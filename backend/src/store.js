// Persistence: DynamoDB on-demand in the cloud, a Map locally and in tests. Keys are plain strings.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';

export function memoryStore() {
  const m = new Map();
  return {
    kind: 'memory',
    async get(pk) { const v = m.get(pk); return v && (!v.ttl || v.ttl > Date.now() / 1000) ? structuredClone(v.value) : null; },
    async put(pk, value, ttlSec) { m.set(pk, { value: structuredClone(value), ttl: ttlSec ? Math.floor(Date.now() / 1000) + ttlSec : 0 }); },
    async incr(pk, by = 1, ttlSec = 86400) { const cur = (m.get(pk)?.value?.n ?? 0) + by; m.set(pk, { value: { n: cur }, ttl: Math.floor(Date.now() / 1000) + ttlSec }); return cur; },
    async push(pk, entry, max = 50, ttlSec = 14 * 86400) { const cur = (await this.get(pk)) ?? { items: [] }; cur.items = [entry, ...cur.items].slice(0, max); await this.put(pk, cur, ttlSec); },
    async list(pk) { return ((await this.get(pk)) ?? { items: [] }).items; },
  };
}

export function dynamoStore(table = process.env.TABLE_NAME, region = process.env.AWS_REGION || 'us-east-1') {
  const doc = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), { marshallOptions: { removeUndefinedValues: true } });
  return {
    kind: 'dynamodb',
    async get(pk) { const r = await doc.send(new GetCommand({ TableName: table, Key: { pk } })); const it = r.Item; if (!it) return null; if (it.ttl && it.ttl < Date.now() / 1000) return null; return it.value; },
    async put(pk, value, ttlSec) { await doc.send(new PutCommand({ TableName: table, Item: { pk, value, ...(ttlSec ? { ttl: Math.floor(Date.now() / 1000) + ttlSec } : {}) } })); },
    async incr(pk, by = 1, ttlSec = 86400) {
      const r = await doc.send(new UpdateCommand({ TableName: table, Key: { pk }, UpdateExpression: 'ADD n :b SET #t = if_not_exists(#t, :t)', ExpressionAttributeNames: { '#t': 'ttl' }, ExpressionAttributeValues: { ':b': by, ':t': Math.floor(Date.now() / 1000) + ttlSec }, ReturnValues: 'UPDATED_NEW' }));
      return r.Attributes?.n ?? by;
    },
    async push(pk, entry, max = 50, ttlSec = 14 * 86400) {
      for (let i = 0; i < 4; i++) {
        const cur = (await this.get(pk)) ?? { items: [] };
        cur.items = [entry, ...cur.items].slice(0, max);
        try { await doc.send(new PutCommand({ TableName: table, Item: { pk, value: cur, ttl: Math.floor(Date.now() / 1000) + ttlSec } })); return; } catch (e) { if (i === 3) throw e; }
      }
    },
    async list(pk) { return ((await this.get(pk)) ?? { items: [] }).items; },
  };
}

export function makeStore() { return process.env.TABLE_NAME ? dynamoStore() : memoryStore(); }

// Local server that speaks the Function URL event shape, so the real handler runs on localhost.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
for (const f of [path.join(here, '../../../.env'), path.join(here, '.env')]) {
  if (!fs.existsSync(f)) continue;
  for (const l of fs.readFileSync(f, 'utf8').split('\n')) { if (l && !l.startsWith('#') && l.includes('=')) { const i = l.indexOf('='); process.env[l.slice(0, i)] ??= l.slice(i + 1); } }
}
process.env.CALLCHECK_INLINE = '1';
const { handle } = await import('./src/handler.js');
const port = Number(process.env.PORT || 18742);
http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  const url = new URL(req.url, 'http://localhost');
  const event = { rawPath: url.pathname, rawQueryString: url.search.slice(1), queryStringParameters: Object.fromEntries(url.searchParams), headers: req.headers, body: Buffer.concat(chunks).toString('utf8') || undefined, isBase64Encoded: false, requestContext: { http: { method: req.method, sourceIp: req.socket.remoteAddress } } };
  const r = await handle(event);
  res.writeHead(r.statusCode, r.headers ?? {}); res.end(r.body ?? '');
  if (r.after) r.after().catch(() => {});
}).listen(port, () => console.log(`callcheck api on http://localhost:${port}`));

// Condenses evidence/probes/*.json into backend/src/data/evidence.json, keyed by probe id.
// Traps cite these ids, so every "observed" claim in the product points at a recorded sandbox response.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'evidence/probes');
const out = {};
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
  for (const r of JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'))) {
    const b = r.response?.body;
    const e = { claim: r.claim, method: r.request?.method, path: r.request?.path, status: r.response?.status, at: r.at, group: f.replace('.json', '') };
    if (b && typeof b === 'object') {
      if (b.name) e.name = b.name;
      const d = b.details?.[0]; if (d) e.issue = d.issue; if (d?.description) e.description = d.description;
      if (b.status) e.resourceStatus = b.status;
      if (b.batch_header) e.batchStatus = b.batch_header.batch_status;
      if (b.batch_status || b.item_status) { e.batchStatus = b.batch_status; e.itemStatus = b.item_status; e.itemError = b.item_errors; }
      if (b.id) e.id = b.id;
      if (b.count != null) e.count = b.count;
    } else if (typeof b === 'string') e.text = b.slice(0, 80);
    out[r.id] = { ...(out[r.id] ?? {}), ...e };
  }
}
fs.mkdirSync(path.join(root, 'backend/src/data'), { recursive: true });
fs.writeFileSync(path.join(root, 'backend/src/data/evidence.json'), JSON.stringify(out, null, 1));
console.log(Object.keys(out).length, 'probe records');

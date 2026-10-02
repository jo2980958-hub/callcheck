// Saves the live schemas next to the code. The Lambda fetches live first and uses these only if developer.paypal.com is unreachable.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRODUCTS } from '../src/spec.js';
const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '../snapshots');
fs.mkdirSync(dir, { recursive: true });
for (const [id, p] of Object.entries(PRODUCTS)) {
  const url = `https://developer.paypal.com/api/${p.slug}/schema.json`;
  const r = await fetch(url);
  if (!r.ok) { console.log('FAIL', id, r.status); continue; }
  const spec = await r.json();
  fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify({ fetchedAt: new Date().toISOString(), url, spec }));
  console.log(id.padEnd(14), spec.info.title, spec.info.version, Object.keys(spec.paths).length, 'paths');
}

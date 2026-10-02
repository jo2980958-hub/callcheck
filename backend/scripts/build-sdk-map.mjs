// Reads the APIMatic-generated PayPal Server SDK source and writes src/data/sdk-ops.json:
// every controller method with its HTTP verb, path template, and where each argument goes on the wire.
// The map is generated, never hand-edited, so it moves when the SDK version moves.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const here = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.join(here, '../node_modules/@paypal/paypal-server-sdk');
const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'));
const ctrlDir = path.join(pkgDir, 'src/controllers');
const ops = [];
for (const file of fs.readdirSync(ctrlDir).filter((f) => f.endsWith('Controller.ts') && !/^(base|oAuth)/.test(f))) {
  const src = fs.readFileSync(path.join(ctrlDir, file), 'utf8');
  const cls = /export class (\w+)/.exec(src)[1];
  const schemaFile = {};
  for (const m of src.matchAll(/import \{([^}]+)\} from '\.\.\/models\/([^']+)\.js'/g)) for (const n of m[1].split(',').map((s) => s.trim()).filter(Boolean)) schemaFile[n] = m[2];
  const parts = src.split(/\n  \/\*\*\n/).slice(1);
  for (const part of parts) {
    const docEnd = part.indexOf('*/');
    const doc = part.slice(0, docEnd).replace(/^\s*\* ?/gm, '');
    const rest = part.slice(docEnd);
    const sig = /async (\w+)\(/.exec(rest);
    if (!sig) continue;
    const name = sig[1];
    const body = rest.slice(sig.index);
    const cr = /this\.createRequest\('(\w+)'(?:, '([^']+)')?\)/.exec(body);
    if (!cr) continue;
    let tpl = cr[2];
    const pathVars = [];
    const ap = /req\.appendTemplatePath`([^`]+)`/.exec(body);
    if (ap) { tpl = ap[1].replace(/\$\{mapped\.(\w+)\}/g, (_, v) => { pathVars.push(v); return `{${v}}`; }); }
    const args = {};
    const prep = /req\.prepareArgs\(\{([\s\S]*?)\}\);/.exec(body);
    if (prep) for (const m of prep[1].matchAll(/(\w+): \[\w+, ([^\]]+)\],?/g)) {
      const expr = m[2].trim(); const optional = expr.startsWith('optional(');
      const sch = /(\w+Schema)\b/.exec(expr)?.[1];
      args[m[1]] = { optional, schema: sch && schemaFile[sch.replace(/Schema$/, '').replace(/^./, (c) => c.toUpperCase())] ? sch : sch, model: sch ? schemaFile[sch.replace(/Schema$/, '').replace(/^./, (c) => c.toUpperCase())] ?? null : null };
    }
    for (const v of pathVars) args[v] = { ...(args[v] ?? {}), kind: 'path' };
    for (const m of body.matchAll(/req\.header\('([^']+)', mapped\.(\w+)\)/g)) args[m[2]] = { ...(args[m[2]] ?? {}), kind: 'header', wire: m[1] };
    for (const m of body.matchAll(/req\.query\('([^']+)', mapped\.(\w+)\)/g)) args[m[2]] = { ...(args[m[2]] ?? {}), kind: 'query', wire: m[1] };
    const j = /req\.json\(mapped\.(\w+)\)/.exec(body); if (j) args[j[1]] = { ...(args[j[1]] ?? {}), kind: 'body' };
    const fm = /req\.formData\(/.exec(body); if (fm) args._form = { kind: 'form' };
    const ok = /req\.callAsJson\((\w+Schema)/.exec(body);
    ops.push({ controller: cls, file, method: name, http: cr[1], path: tpl, args, summary: doc.split('\n').filter((l) => l.trim() && !l.startsWith('@'))[0]?.trim() ?? '', responseSchema: ok?.[1] ?? null });
  }
}
const out = { sdk: pkg.name, version: pkg.version, generatedFrom: 'node_modules/@paypal/paypal-server-sdk/src/controllers', ops };
fs.mkdirSync(path.join(here, '../src/data'), { recursive: true });
fs.writeFileSync(path.join(here, '../src/data/sdk-ops.json'), JSON.stringify(out, null, 1));
const by = {}; for (const o of ops) by[o.controller] = (by[o.controller] ?? 0) + 1;
console.log(pkg.name, pkg.version, ops.length, 'operations', JSON.stringify(by));

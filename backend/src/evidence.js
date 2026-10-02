// Evidence helpers. Probe records come from scripts/probe.mjs runs against the PayPal sandbox (evidence/probes/*.json).
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const PROBES = require('./data/evidence.json');

export function probe(id) {
  const r = PROBES[id];
  if (!r) throw new Error(`Unknown probe id "${id}". Re-run scripts/probe.mjs and scripts/build-evidence.mjs.`);
  const what = r.itemStatus
    ? `batch ${r.batchStatus}, item ${r.itemStatus}${r.itemError ? ` (${r.itemError})` : ''}`
    : `${r.status}${r.name ? ' ' + r.name : ''}${r.issue ? ' / ' + r.issue : ''}${r.resourceStatus ? ' (' + r.resourceStatus + ')' : ''}`;
  return { kind: 'sandbox', probe: id, at: r.at ?? null, text: r.method ? `${r.method} ${String(r.path).replace(/\/[A-Z0-9]{12,}(?=\/|$)/g, '/{id}')} returned ${what}.` : `${id.replace(/^mcp\./, '')} returned ${what}${r.text ? ' (' + r.text.replace(/\s+/g, ' ').slice(0, 50) + ')' : ''}.`, detail: r };
}

export const sibling = (project, text) => ({ kind: 'sibling', project, text });
export const doc = (text, url) => ({ kind: 'docs', text, url });
export const specNote = (text) => ({ kind: 'spec', text });
export const policy = (text) => ({ kind: 'policy', text });

export function allProbes() { return PROBES; }

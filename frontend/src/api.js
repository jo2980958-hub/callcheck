async function j(path, opts = {}) {
  let r;
  try { r = await fetch('/api' + path, { headers: { 'content-type': 'application/json' }, ...opts }); }
  catch { throw Object.assign(new Error('Callcheck could not reach its server. Check your connection and try again.'), { status: 0 }); }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(data.error || `The server answered ${r.status}. Try again in a moment.`), { status: r.status });
  return data;
}
const post = (p, b) => j(p, { method: 'POST', body: JSON.stringify(b) });
export const api = {
  check: (b) => post('/check', b),
  run: (b) => post('/run', b),
  explain: (b) => post('/explain', b),
  job: (id) => j('/job/' + id),
  traps: () => j('/traps'),
  examples: () => j('/examples'),
  sources: () => j('/sources'),
  meta: () => j('/meta'),
  runs: () => j('/runs'),
  webhooks: () => j('/webhooks'),
};

/** Poll a job until it finishes. Calls onUpdate with every snapshot. */
export async function pollJob(id, onUpdate, { signal, intervalMs = 1500, maxMs = 5 * 60_000 } = {}) {
  const t0 = Date.now();
  for (;;) {
    if (signal?.aborted) throw new Error('Stopped.');
    const rec = await api.job(id);
    onUpdate(rec);
    if (rec.status === 'done' || rec.status === 'error') return rec;
    if (Date.now() - t0 > maxMs) throw new Error('This is taking longer than five minutes. The job may still finish; reload to look again.');
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

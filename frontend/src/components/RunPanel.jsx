import React from 'react';
import { IconOk, IconBlocker } from './Icons.jsx';

const OUTCOME = { true: { label: 'Prediction held', Icon: IconOk, cls: 'held' }, false: { label: 'Prediction missed', Icon: IconBlocker, cls: 'missed' } };

export function Ledger({ verdicts }) {
  if (!verdicts?.length) return null;
  return (
    <ol className="ledger" aria-label="Predicted against observed">
      {verdicts.map((v) => {
        const o = OUTCOME[String(v.ok)];
        return (
          <li key={v.attempt} className={`ledger-row ${o ? o.cls : 'none'}`}>
            <div className="ledger-step">{v.attempt === 2 ? 'Second send' : verdicts.length > 1 ? 'First send' : 'Sent once'}</div>
            <dl className="ledger-pair">
              <div><dt>Predicted</dt><dd>{v.predicted ?? 'Nothing was predicted for this step.'}</dd></div>
              <div><dt>Observed</dt><dd>{v.observed}</dd></div>
            </dl>
            <div className="ledger-result">{o ? <><o.Icon width={18} height={18} /> {o.label}</> : 'No prediction'}</div>
            {v.ok === false && <ul className="ledger-miss">{v.checks.filter((c) => !c.ok).map((c, i) => <li key={i}>{c.what}: {c.detail}</li>)}</ul>}
          </li>
        );
      })}
    </ol>
  );
}

export function Timeline({ events }) {
  if (!events?.length) return null;
  return (
    <ol className="timeline" aria-label="Run log">
      {events.map((e, i) => <li key={i}><span className="tl-t">{e.t}</span> {e.text}</li>)}
    </ol>
  );
}

export function RunPanel({ job, onRerun }) {
  if (!job) return null;
  const done = job.status === 'done'; const err = job.status === 'error';
  const r = job.result;
  return (
    <section className="panel run" aria-labelledby="run-h" aria-live="polite">
      <header className="panel-head"><h3 id="run-h">Sandbox run</h3><span className="subtle">{job.target === 'corrected' ? 'Corrected call' : 'Call as pasted'}</span></header>
      {!done && !err && <p className="busy"><span className="spinner" aria-hidden="true" /> {job.status === 'queued' ? 'Starting the run' : 'Running. Payouts take about 20 seconds to settle.'}</p>}
      <Timeline events={job.events} />
      {err && <p className="error" role="alert">{job.error}</p>}
      {done && r && <>
        <Ledger verdicts={r.verdicts} />
        {r.cleanedUp?.length > 0 && <p className="subtle">Callcheck cancelled {r.cleanedUp.length} unclaimed item{r.cleanedUp.length > 1 ? 's' : ''} afterwards so the money went back to the sender.</p>}
        {job.webhooks?.length > 0 && <p className="subtle">PayPal also delivered {job.webhooks.map((w) => w.type).join(', ')} to the webhook, signature verified.</p>}
        <details className="evidence"><summary>Responses ({r.attempts.length})</summary>
          {r.attempts.map((a) => (
            <div key={a.n}>
              <p className="subtle">Send {a.n}: HTTP {a.response.status} in {a.response.ms} ms{a.response.debugId ? `, PayPal debug id ${a.response.debugId}` : ''}</p>
              <pre className="code small" tabIndex={0} aria-label={`Response body of send ${a.n}`}><code>{JSON.stringify(a.response.body ?? null, null, 2)}</code></pre>
            </div>
          ))}
        </details>
      </>}
      {(done || err) && onRerun && <div className="row"><button type="button" className="btn" onClick={onRerun}>Run again</button></div>}
    </section>
  );
}

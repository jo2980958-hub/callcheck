import React from 'react';
import { Code } from './Code.jsx';
import { Ledger } from './RunPanel.jsx';

export function AgentPanel({ job }) {
  if (!job) return null;
  const done = job.status === 'done'; const err = job.status === 'error'; const r = job.result;
  return (
    <section className="panel agent" aria-labelledby="agent-h" aria-live="polite">
      <header className="panel-head"><h3 id="agent-h">Explanation</h3>{r && <span className={`chip ${r.source === 'model' ? 'chip-accent' : ''}`}>{r.source === 'model' ? 'Written by Claude on Bedrock, using tools' : 'Written by rules, not the model'}</span>}</header>
      {!done && !err && <p className="busy"><span className="spinner" aria-hidden="true" /> The agent is reading the live schema and checking its corrected call.{job.events?.length ? ` Last tool: ${job.events[job.events.length - 1].text}.` : ''}</p>}
      {err && <p className="error" role="alert">{job.error}</p>}
      {r && <>
        {r.reason && <p className="notice">{r.reason}</p>}
        <p className="lede">{r.summary}</p>
        <ul className="explain-items">{r.items.map((i) => <li key={i.id}><code className="chip chip-mono">{i.id}</code> {i.text}</li>)}</ul>
        {r.corrected && (
          <div>
            <Code text={r.corrected.text} title={`Corrected call (${r.corrected.by === 'model' ? 'proposed by the model' : 'built by rules'})`} />
            {r.corrected.verified && <p className={r.corrected.verified.blockers ? 'error' : 'ok-line'}>{r.corrected.verified.blockers ? `Callcheck still finds ${r.corrected.verified.blockers} problem${r.corrected.verified.blockers > 1 ? 's' : ''} in this version.` : 'Callcheck re-checked this version and found no blockers.'}{r.corrected.verified.predicted ? ` Expect ${r.corrected.verified.predicted}.` : ''}</p>}
          </div>
        )}
        {r.run && <><h4 className="mini-h">The agent ran its corrected call</h4><Ledger verdicts={r.run.verdicts} /></>}
        {r.caveats?.length > 0 && <ul className="caveats">{r.caveats.map((c, i) => <li key={i}>{c}</li>)}</ul>}
        {r.steps?.length > 0 && (
          <details className="evidence"><summary>Tool calls ({r.steps.length})</summary>
            <ol className="steps">{r.steps.map((s, i) => <li key={i}><code>{s.tool}</code> <span className="subtle">{s.input}</span></li>)}</ol>
          </details>
        )}
      </>}
    </section>
  );
}

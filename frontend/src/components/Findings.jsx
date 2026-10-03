import React from 'react';
import { SEV, IconOk, IconBlocker, IconWarn } from './Icons.jsx';

const CONF = {
  observed: 'Seen in the sandbox',
  spec: 'From the live schema',
  doc: 'From PayPal\'s docs',
  recorded: 'Recorded from a sibling run',
  policy: 'Callcheck policy',
};
const KIND = { sandbox: 'Sandbox run', spec: 'Live schema', docs: 'PayPal docs', sibling: 'Our own integration', policy: 'Policy' };

export function Verdict({ result }) {
  const v = result.verdict; const Icon = v.level === 'fail' ? IconBlocker : v.level === 'trap' ? IconWarn : IconOk;
  const s = result.spec; const p = result.predictions?.first;
  const code = p ? [].concat(p.status).join(' / ') : null;
  const sub = p ? (p.terminal ? `then ${p.terminal.item}` : p.issue && typeof p.issue === 'string' ? p.issue : p.name ?? (p.body?.status ?? '')) : '';
  return (
    <section className={`verdict verdict-${v.level}`} aria-labelledby="verdict-h">
      <Icon width={30} height={30} className="verdict-icon" />
      <div className="verdict-body">
        <h2 id="verdict-h" className="verdict-head">{v.headline}</h2>
        <p className="verdict-detail">{v.detail}</p>
        <ul className="chips" aria-label="What was checked">
          {result.op && <li className="chip chip-mono">{result.op.method} {result.op.path}</li>}
          {s && <li className="chip">{s.title} {s.version}, {s.source === 'live' ? 'live schema' : s.source === 'cached' ? 'cached live schema' : 'bundled snapshot'}</li>}
          {result.sdk && <li className="chip chip-mono">{result.sdk.controller}.{result.sdk.method}</li>}
          <li className="chip">{result.counts.blocker} will fail</li>
          <li className="chip">{result.counts.warning} will bite</li>
          <li className="chip">{result.counts.note} to know</li>
        </ul>
        {s && s.source === 'snapshot' && <p className="subtle">developer.paypal.com did not answer, so this check used the schema snapshot from {new Date(s.fetchedAt).toUTCString().slice(5, 22)} UTC.</p>}
      </div>
      {code && (
        <div className="verdict-code" aria-label={`Predicted HTTP status ${code}`}>
          <span className="vc-label">Predicted</span>
          <span className="vc-num">{code}</span>
          <span className="vc-sub">{sub}</span>
        </div>
      )}
    </section>
  );
}

function Evidence({ items }) {
  if (!items?.length) return null;
  return (
    <details className="evidence">
      <summary>Evidence ({items.length})</summary>
      <ul>
        {items.map((e, i) => (
          <li key={i}><span className="ev-kind">{KIND[e.kind] ?? e.kind}</span> {e.text}{e.at ? <span className="subtle"> Recorded {new Date(e.at).toUTCString().slice(5, 22)} UTC.</span> : null}</li>
        ))}
      </ul>
    </details>
  );
}

export function FindingCard({ f, open }) {
  const s = SEV[f.severity]; const Icon = s.Icon;
  return (
    <li className={`finding finding-${f.severity}`}>
      <details open={open}>
        <summary>
          <Icon width={20} height={20} className="f-icon" />
          <span className="f-sev">{s.label}</span>
          <span className="f-title">{f.title}</span>
          <span className="f-caret" aria-hidden="true" />
        </summary>
        <div className="f-body">
          <p>{f.what}</p>
          {f.fix && <p className="f-fix"><strong>Fix.</strong> {f.fix}</p>}
          <div className="f-meta">
            {f.where && <code className="chip chip-mono">{f.where}</code>}
            {f.confidence && <span className="chip">{CONF[f.confidence] ?? f.confidence}</span>}
          </div>
          <Evidence items={f.evidence} />
        </div>
      </details>
    </li>
  );
}

export function FindingsList({ findings }) {
  if (!findings.length) return <p className="subtle">Nothing to report.</p>;
  const firstBlocker = findings.findIndex((f) => f.severity === 'blocker');
  return (
    <ol className="findings" aria-label="Findings">
      {findings.map((f, i) => <FindingCard key={`${f.id}-${i}`} f={f} open={i === Math.max(firstBlocker, 0) && i < 1 + Math.max(firstBlocker, 0)} />)}
    </ol>
  );
}

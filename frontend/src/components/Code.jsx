import React, { useState } from 'react';
import { tokenize } from '../highlight.js';
import { diffLines } from '../diff.js';
import { IconCopy } from './Icons.jsx';

export function copyText(text) {
  if (navigator.clipboard?.writeText) return navigator.clipboard.writeText(text);
  const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.position = 'fixed'; ta.style.opacity = '0';
  document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); } finally { document.body.removeChild(ta); }
  return Promise.resolve();
}

function Tokens({ text }) {
  return tokenize(text).map((t, i) => (t.t === 'ws' ? t.v : <span key={i} className={`tk-${t.t}`}>{t.v}</span>));
}

export function CopyButton({ text, label = 'Copy' }) {
  const [done, setDone] = useState(false);
  return (
    <button type="button" className="btn btn-quiet btn-sm" onClick={() => copyText(text).then(() => { setDone(true); setTimeout(() => setDone(false), 1600); })}>
      <IconCopy width={15} height={15} /> <span aria-live="polite">{done ? 'Copied' : label}</span>
    </button>
  );
}

/** A highlighted, scrollable code block. `title` becomes the accessible name. */
export function Code({ text, title, copy = true, className = '' }) {
  return (
    <div className={`code-wrap ${className}`}>
      {(title || copy) && (
        <div className="code-bar">
          <span className="code-title">{title}</span>
          {copy && <CopyButton text={text} />}
        </div>
      )}
      <pre className="code" tabIndex={0} aria-label={title || 'Code'}><code><Tokens text={text} /></code></pre>
    </div>
  );
}

/** A diff between the pasted request and the corrected one. Every changed line carries a + or - mark, so colour is never the only cue. */
export function Diff({ before, after, title }) {
  const rows = diffLines(before, after);
  const changed = rows.some((r) => r.type !== 'same');
  return (
    <div className="code-wrap">
      <div className="code-bar"><span className="code-title">{title}</span><CopyButton text={after} label="Copy corrected" /></div>
      <pre className="code diff" tabIndex={0} aria-label={title}>
        <code>
          {rows.map((r, i) => (
            <span key={i} className={`dl dl-${r.type}`}>
              <span className="dl-mark" aria-hidden="true">{r.type === 'add' ? '+' : r.type === 'del' ? '−' : ' '}</span>
              <span className="dl-text">{r.type !== 'same' && <span className="sr-only">{r.type === 'add' ? 'Added: ' : 'Removed: '}</span>}<Tokens text={r.text || ' '} /></span>
            </span>
          ))}
        </code>
        {!changed && <span className="sr-only">No lines changed.</span>}
      </pre>
    </div>
  );
}

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, pollJob } from '../api.js';
import { Code, Diff } from './Code.jsx';
import { Verdict, FindingsList } from './Findings.jsx';
import { RunPanel, Ledger } from './RunPanel.jsx';
import { AgentPanel } from './AgentPanel.jsx';
import { IconPlay, IconSpark } from './Icons.jsx';

const MODES = [
  { id: 'rest', label: 'REST call', hint: 'Paste a curl command, a raw HTTP request, or fetch(). Authorization headers are dropped before anything is stored.' },
  { id: 'sdk', label: 'SDK snippet', hint: 'Paste a call to @paypal/paypal-server-sdk, such as ordersController.createOrder({ body: { ... } }).' },
  { id: 'mcp', label: 'MCP setup', hint: 'Paste an mcpServers block, an npx @paypal/mcp command, an MCP URL, or the tool names you plan to call.' },
];

const PLACEHOLDER = {
  rest: 'POST /v1/payments/payouts\nContent-Type: application/json\n\n{ "sender_batch_header": { "sender_batch_id": "claim-1042" }, "items": [ ... ] }',
  sdk: 'const { result } = await ordersController.createOrder({\n  body: { intent: \'CAPTURE\', purchaseUnits: [ ... ] },\n  paypalRequestId: \'order-1042\',\n});',
  mcp: '{ "mcpServers": { "paypal": { "command": "npx", "args": ["-y", "@paypal/mcp", "--tools=all"] } } }',
};

const QUICK = [
  { label: 'Retried payout', mode: 'rest', trap: 'payout-dup-batch-id' },
  { label: 'Invoice number too long', mode: 'rest', trap: 'invoice-number-length' },
  { label: 'Breakdown that does not add up', mode: 'rest', trap: 'orders-amount-mismatch' },
  { label: 'SDK body with REST keys', mode: 'sdk', text: "const { result } = await ordersController.createOrder({\n  body: {\n    intent: 'CAPTURE',\n    purchase_units: [{ amount: { currencyCode: 'USD', value: '10.00' } }],\n  },\n  paypalRequestId: 'order-1042',\n});" },
  { label: 'MCP path from the quickstart', mode: 'mcp', text: '{\n  "mcpServers": {\n    "paypal": {\n      "command": "npx",\n      "args": ["-y", "mcp-remote", "https://mcp.sandbox.paypal.com/http"]\n    }\n  }\n}' },
];

function store(key, fallback) { try { return localStorage.getItem(key) ?? fallback; } catch { return fallback; } }
function save(key, v) { try { localStorage.setItem(key, v); } catch { /* storage can be blocked */ } }

export default function Check({ pending, clearPending }) {
  const [mode, setMode] = useState(() => store('cc.mode', 'rest'));
  const [texts, setTexts] = useState(() => ({ rest: store('cc.text.rest', ''), sdk: store('cc.text.sdk', ''), mcp: store('cc.text.mcp', '') }));
  const [traps, setTraps] = useState([]);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [runJob, setRunJob] = useState(null);
  const [agentJob, setAgentJob] = useState(null);
  const [target, setTarget] = useState('pasted');
  const [twice, setTwice] = useState(true);
  const abort = useRef(null);
  const resultRef = useRef(null);
  const text = texts[mode];

  useEffect(() => { api.traps().then((d) => setTraps(d.traps)).catch(() => {}); }, []);
  useEffect(() => { save('cc.mode', mode); }, [mode]);

  const setText = (v) => { setTexts((t) => ({ ...t, [mode]: v })); save(`cc.text.${mode}`, v); };

  useEffect(() => {
    if (!pending) return;
    setMode(pending.mode); setTexts((t) => ({ ...t, [pending.mode]: pending.text })); save(`cc.text.${pending.mode}`, pending.text);
    clearPending();
    runCheck(pending.text, pending.mode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending]);

  async function runCheck(t = text, m = mode) {
    setBusy(true); setError(''); setRunJob(null); setAgentJob(null);
    try {
      const r = await api.check({ text: t, mode: m });
      setResult(r); setTarget('pasted'); setTwice(!!r.predictions?.second);
      requestAnimationFrame(() => resultRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' }));
    } catch (e) { setError(e.message); setResult(null); }
    finally { setBusy(false); }
  }

  function loadExample(ex) {
    const t = ex.text ?? traps.find((x) => x.id === ex.trap)?.example?.text;
    if (!t) return;
    setMode(ex.mode); setTexts((s) => ({ ...s, [ex.mode]: t })); save(`cc.text.${ex.mode}`, t);
    runCheck(t, ex.mode);
  }

  async function startRun() {
    setError(''); setRunJob({ status: 'queued', events: [], target });
    abort.current?.abort(); abort.current = new AbortController();
    try {
      const repeat = twice && (target === 'pasted' ? result.predictions?.second : true) ? 2 : 1;
      const { id } = await api.run({ text, mode, target, repeat, repeatMode: result.predictions?.second?.by === 'orders-request-id-reuse' ? 'changed' : 'same' });
      await pollJob(id, (rec) => setRunJob({ ...rec, target }), { signal: abort.current.signal });
    } catch (e) { setRunJob({ status: 'error', error: e.message, events: [], target }); }
  }

  async function startExplain() {
    setAgentJob({ status: 'queued', events: [] });
    abort.current?.abort(); abort.current = new AbortController();
    try {
      const { id } = await api.explain({ text, mode, runId: runJob?.status === 'done' ? runJob.id : undefined });
      await pollJob(id, (rec) => setAgentJob(rec), { signal: abort.current.signal });
    } catch (e) { setAgentJob({ status: 'error', error: e.message, events: [] }); }
  }

  const modeInfo = MODES.find((m) => m.id === mode);
  const runnable = result?.runnable?.ok && mode !== 'mcp';
  const correctedRunnable = result?.corrected?.runnable?.ok ?? !!result?.corrected?.request;
  const busyRun = runJob && !['done', 'error'].includes(runJob.status);
  const busyAgent = agentJob && !['done', 'error'].includes(agentJob.status);
  const grouped = useMemo(() => traps.filter((t) => t.example), [traps]);

  return (
    <div className="check">
      <section className="panel input" aria-labelledby="in-h">
        <header className="panel-head"><h2 id="in-h">Paste a call</h2></header>
        <div className="seg" role="tablist" aria-label="What you are pasting">
          {MODES.map((m) => (
            <button key={m.id} type="button" role="tab" aria-selected={mode === m.id} className={mode === m.id ? 'on' : ''} onClick={() => { setMode(m.id); setResult(null); setRunJob(null); setAgentJob(null); setError(''); }}>{m.label}</button>
          ))}
        </div>
        <label htmlFor="paste" className="sr-only">{modeInfo.label}</label>
        <textarea id="paste" className="paste" spellCheck="false" autoCapitalize="off" autoCorrect="off" value={text} onChange={(e) => setText(e.target.value)} placeholder={PLACEHOLDER[mode]} aria-describedby="paste-hint" rows={16}
          onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && text.trim()) { e.preventDefault(); runCheck(); } }} />
        <p id="paste-hint" className="hint">{modeInfo.hint}</p>
        <div className="row">
          <button type="button" className="btn btn-primary" disabled={busy || !text.trim()} onClick={() => runCheck()}>{busy ? 'Checking' : 'Check this call'}</button>
          <label className="select-wrap"><span className="sr-only">Load an example</span>
            <select value="" onChange={(e) => { const t = grouped.find((x) => x.id === e.target.value); if (t) loadExample({ mode: 'rest', trap: t.id }); }} aria-label="Load an example">
              <option value="">Load an example</option>
              {grouped.map((t) => <option key={t.id} value={t.id}>{t.example.name}</option>)}
            </select>
          </label>
          <button type="button" className="btn btn-quiet" disabled={!text} onClick={() => { setText(''); setResult(null); setRunJob(null); setAgentJob(null); setError(''); }}>Clear</button>
        </div>
        {error && <p className="error" role="alert">{error}</p>}
      </section>

      <div className="output" ref={resultRef} aria-live="polite">
        {!result && !busy && (
          <section className="panel empty">
            <h1>Callcheck says what a PayPal call will do, before you make it.</h1>
            <p>Callcheck reads your call against PayPal&apos;s live OpenAPI schema and a catalogue of failures that real integrations hit, says what will happen, and then runs it in the sandbox to show the prediction was right.</p>
            <p className="subtle">{traps.length ? 'Try one of these:' : 'Loading the trap catalogue\u2026'}</p>
            <ul className="quick">{QUICK.map((q) => <li key={q.label}><button type="button" className="btn btn-quiet" onClick={() => loadExample(q)} disabled={q.trap && !traps.length}>{q.label}</button></li>)}</ul>
            <h3 className="mini-h">The last call it was given</h3>
            <p className="subtle">A payout batch sent twice with the same sender_batch_id. The prediction was made before PayPal was called.</p>
            <Ledger verdicts={[{ attempt: 2, ok: true, predicted: 'HTTP 400 USER_BUSINESS_ERROR (already exists)', observed: 'HTTP 400 USER_BUSINESS_ERROR (Batch with given sender_batch_id already exists)', checks: [] }]} />
          </section>
        )}
        {busy && <section className="panel"><p className="busy"><span className="spinner" aria-hidden="true" /> Reading the live PayPal schema and checking your call.</p></section>}
        {result && !busy && <>
          <Verdict result={result} />
          <section className="panel" aria-labelledby="f-h">
            <header className="panel-head"><h3 id="f-h">Findings</h3></header>
            <FindingsList findings={result.findings} />
          </section>
          {result.corrected && (
            <section className="panel" aria-labelledby="c-h">
              <header className="panel-head"><h3 id="c-h">Corrected call</h3><span className="subtle">{result.corrected.applied.length} fix{result.corrected.applied.length === 1 ? '' : 'es'} applied by rules</span></header>
              <Diff before={result.requestText} after={result.corrected.text} title="Pasted call against corrected call" />
              {result.predictions?.first && result.mode !== 'mcp' && <p className="subtle">The corrected call is re-checked when you run it.</p>}
            </section>
          )}
          {!result.corrected && result.mode !== 'mcp' && result.requestText && (
            <details className="panel disclosure"><summary>How Callcheck read your paste</summary><Code text={result.requestText} title="Parsed request" /></details>
          )}
          {result.probes?.length > 0 && (
            <section className="panel"><header className="panel-head"><h3>Live endpoint probes</h3></header>
              <ul className="probes">{result.probes.map((p) => <li key={p.url}><code>{p.url}</code> answered {p.error ? `with an error (${p.error})` : <strong>{p.status}</strong>} just now.</li>)}</ul>
            </section>
          )}
          <section className="panel actions" aria-labelledby="a-h">
            <header className="panel-head"><h3 id="a-h">Prove it</h3></header>
            {mode === 'mcp' ? <p className="subtle">An MCP setup has no request to send. The probes above are real requests made while you waited.</p> : <>
              {!runnable && <p className="notice">{result.runnable?.reason ?? 'This call cannot run.'} Callcheck can still check it and explain it.</p>}
              {runnable && <>
                <fieldset className="opts"><legend className="sr-only">What to run</legend>
                  {result.corrected && (
                    <div className="seg seg-sm" role="radiogroup" aria-label="Which call to run">
                      <button type="button" role="radio" aria-checked={target === 'pasted'} className={target === 'pasted' ? 'on' : ''} onClick={() => setTarget('pasted')}>Run as pasted</button>
                      <button type="button" role="radio" aria-checked={target === 'corrected'} className={target === 'corrected' ? 'on' : ''} disabled={!correctedRunnable} onClick={() => setTarget('corrected')}>Run corrected</button>
                    </div>
                  )}
                  {result.predictions?.second && target === 'pasted' && (
                    <label className="check-opt"><input type="checkbox" checked={twice} onChange={(e) => setTwice(e.target.checked)} /> <span>Send twice to test the retry. <span className="subtle">Predicted: {result.predictions.second.text}.</span></span></label>
                  )}
                </fieldset>
                {result.corrected && target === 'corrected' && !correctedRunnable && <p className="notice">{result.corrected.runnable?.reason}</p>}
                <div className="row">
                  <button type="button" className="btn btn-primary" disabled={busyRun || (target === 'corrected' && !correctedRunnable)} onClick={startRun}><IconPlay width={16} height={16} /> {busyRun ? 'Running' : 'Run in the sandbox'}</button>
                </div>
              </>}
            </>}
            <div className="row">
              <button type="button" className="btn" disabled={busyAgent} onClick={startExplain}><IconSpark width={16} height={16} /> {busyAgent ? 'Explaining' : 'Explain and correct with the agent'}</button>
              <span className="subtle">Takes 10 to 40 seconds. Bedrock is shared, so it may fall back to rules and say so.</span>
            </div>
          </section>
          <RunPanel job={runJob} onRerun={startRun} />
          <AgentPanel job={agentJob} />
        </>}
      </div>
    </div>
  );
}

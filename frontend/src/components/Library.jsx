import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api.js';
import { SEV, IconArrow } from './Icons.jsx';

const KIND = { sandbox: 'Sandbox run', spec: 'Live schema', docs: 'PayPal docs', sibling: 'Sibling project', policy: 'Policy' };

function useLoad(fn) {
  const [state, set] = useState({ data: null, error: '' });
  useEffect(() => { let on = true; fn().then((d) => on && set({ data: d, error: '' })).catch((e) => on && set({ data: null, error: e.message })); return () => { on = false; }; }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return state;
}

export function Traps({ onCheck }) {
  const { data, error } = useLoad(api.traps);
  const [group, setGroup] = useState('All');
  const [q, setQ] = useState('');
  const traps = data?.traps ?? [];
  const groups = useMemo(() => ['All', ...new Set(traps.map((t) => t.group))], [traps]);
  const shown = traps.filter((t) => (group === 'All' || t.group === group) && (!q || `${t.title} ${t.summary}`.toLowerCase().includes(q.toLowerCase())));
  return (
    <div className="page">
      <header className="page-head"><h1>Known traps</h1><p className="lede">{traps.length} ways a PayPal integration goes wrong. Open one for the mechanism and its evidence.</p></header>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="filters">
        <div className="seg seg-wrap" role="group" aria-label="Filter by API">
          {groups.map((g) => <button key={g} type="button" aria-pressed={group === g} className={group === g ? 'on' : ''} onClick={() => setGroup(g)}>{g}</button>)}
        </div>
        <label className="search"><span className="sr-only">Search the traps</span><input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search the traps" /></label>
      </div>
      <p className="subtle" aria-live="polite">{shown.length} shown</p>
      <ul className="trap-list">
        {shown.map((t) => {
          const s = SEV[t.severity] ?? SEV.warning; const Icon = s.Icon;
          return (
            <li key={t.id} className={`trap-row trap-${t.severity}`}>
              <details>
                <summary>
                  <span className="chip trap-badge">{t.group}</span>
                  <span className="trap-title">{t.title}</span>
                  <span className={`sev sev-${t.severity}`}><Icon width={16} height={16} /> {s.label}</span>
                  <span className="f-caret" aria-hidden="true" />
                </summary>
                <div className="trap-more">
                  <p>{t.summary}</p>
                  <details className="evidence"><summary>Evidence ({t.evidence.length})</summary>
                    <ul>{t.evidence.map((e, i) => <li key={i}><span className="ev-kind">{KIND[e.kind] ?? e.kind}</span> {e.text}</li>)}</ul>
                  </details>
                  {t.example && <div className="row"><button type="button" className="btn" onClick={() => onCheck({ mode: 'rest', text: t.example.text })}>Check {t.example.name.toLowerCase()} <IconArrow width={15} height={15} /></button></div>}
                </div>
              </details>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function Examples({ onCheck }) {
  const { data, error } = useLoad(api.examples);
  return (
    <div className="page">
      <header className="page-head"><h1>Worked examples</h1><p className="lede">Eight integrations built in this repository for the same hackathon, and the PayPal behaviour each one hit. The quotes come from their own build logs. The button loads the request that reproduces the mistake.</p></header>
      {error && <p className="error" role="alert">{error}</p>}
      <ul className="cards">
        {(data?.examples ?? []).map((e) => (
          <li key={e.id} className="card example">
            <div className="card-top"><span className="chip">{e.surface}</span><code className="chip chip-mono">{e.folder}</code></div>
            <h2>{e.project}</h2>
            <p className="subtle">{e.does}</p>
            <p><strong>What it missed.</strong> {e.missed}</p>
            <blockquote><p>{e.quote}</p><footer>{e.log}</footer></blockquote>
            <p className="subtle">Traps involved: {e.traps.join(', ')}.</p>
            <div className="row"><button type="button" className="btn" onClick={() => onCheck({ mode: 'rest', text: e.text })}>Check this request <IconArrow width={15} height={15} /></button></div>
          </li>
        ))}
      </ul>
      <p className="subtle">projects/channel3 was empty when this was written, so it is not here.</p>
    </div>
  );
}

export function Sources() {
  const { data, error } = useLoad(api.sources);
  const [wh, setWh] = useState(null);
  useEffect(() => { api.webhooks().then(setWh).catch(() => {}); }, []);
  return (
    <div className="page">
      <header className="page-head"><h1>Where PayPal&apos;s sources disagree</h1><p className="lede">Worked out live from PayPal&apos;s schemas, its GitHub mirror, the APIMatic-generated SDK and the recorded runs. Most tools read GitHub and so under-report PayPal.</p></header>
      {error && <p className="error" role="alert">{error}</p>}
      {!data && !error && <p className="busy"><span className="spinner" aria-hidden="true" /> Fetching ten schemas from developer.paypal.com and the GitHub mirror.</p>}
      {data && <>
        <section className="panel" aria-labelledby="s1"><header className="panel-head"><h2 id="s1">Live schema, GitHub mirror and SDK</h2></header>
          <div className="table-wrap" tabIndex={0} role="region" aria-label="Spec versions by API">
            <table>
              <thead><tr><th scope="col">API</th><th scope="col">Live schema</th><th scope="col">GitHub mirror</th><th scope="col">APIMatic SDK 2.5.0</th></tr></thead>
              <tbody>{data.products.map((p) => (
                <tr key={p.product}>
                  <th scope="row">{p.label}</th>
                  <td>{p.live.title} {p.live.version}, {p.live.paths} paths</td>
                  <td>{p.github?.error ? 'could not be read' : p.github ? <>{p.github.title} {p.github.version}, {p.github.paths} paths{p.missingFromGithub.length > 0 && <strong> ({p.missingFromGithub.length} live paths missing)</strong>}</> : 'no file'}</td>
                  <td>{p.sdk.covered === 0 ? 'no operations' : `${p.sdk.covered} of ${p.sdk.total} operations`}</td>
                </tr>))}
              </tbody>
            </table>
          </div>
          <p className="subtle">The SDK has {data.sdk.operations} operations in {data.sdk.controllers.length} controllers ({data.sdk.controllers.map((c) => c.replace('Controller', '')).join(', ')}). Payouts, Invoicing, Disputes, Webhooks and Catalog have none, so the Context Plugin has nothing to teach about them.</p>
        </section>
        {data.contradictions.map((c, i) => (
          <section key={c.topic} className="panel" aria-labelledby={`c${i}`}>
            <header className="panel-head"><h2 id={`c${i}`}>{c.topic}</h2></header>
            <p>{c.note}</p>
            <dl className="values">{c.values.map((v, j) => <div key={j}><dt>{v.source}</dt><dd>{v.value}{v.probe && <span className="subtle"> {v.probe}</span>}</dd></div>)}</dl>
          </section>
        ))}
        <section className="panel" aria-labelledby="mcp"><header className="panel-head"><h2 id="mcp">MCP tools</h2></header>
          <p>PayPal registers {data.mcp.total} tools. <code>npx @paypal/mcp --tools=all</code> exposes {data.mcp.local}. These {data.mcp.hidden.length} are unreachable from it:</p>
          <p className="wrap-mono">{data.mcp.hidden.join('  ')}</p>
        </section>
      </>}
      <section className="panel" aria-labelledby="whp"><header className="panel-head"><h2 id="whp">Webhook deliveries</h2></header>
        {!wh && <p className="subtle">Loading.</p>}
        {wh && !wh.configured && <p className="subtle">No webhook is configured on this deployment.</p>}
        {wh?.configured && !wh.events.length && <p className="subtle">No delivery has arrived yet. Run a payout and PayPal will send one.</p>}
        {wh?.events?.length > 0 && <ul className="deliveries">{wh.events.slice(0, 12).map((e, i) => <li key={i}><span className={`chip ${e.verified ? 'chip-ok' : 'chip-bad'}`}>{e.verified ? 'Signature verified' : 'Rejected'}</span> {e.type ?? 'unknown event'} <span className="subtle">{new Date(e.at).toUTCString().slice(5, 25)} UTC{e.reason ? `. ${e.reason}` : ''}</span></li>)}</ul>}
      </section>
    </div>
  );
}

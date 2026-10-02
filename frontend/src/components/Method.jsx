import React from 'react';

export default function Method() {
  return (
    <div className="page prose">
      <header className="page-head"><h1>How this was built, and where APIMatic fits</h1>
        <p className="lede">APIMatic is a build-time tool. Callcheck uses it at build time, and keeps one honest foot in run time without calling an APIMatic service.</p></header>

      <section className="panel" aria-labelledby="m1"><header className="panel-head"><h2 id="m1">The boundary</h2></header>
        <div className="table-wrap" tabIndex={0} role="region" aria-label="Build time and run time use of APIMatic">
          <table>
            <thead><tr><th scope="col">APIMatic thing</th><th scope="col">When</th><th scope="col">What Callcheck does with it</th></tr></thead>
            <tbody>
              <tr><th scope="row">Context Plugin for PayPal</th><td>Build time</td><td>Installed with <code>npx context-plugins install</code>. Claude Code read its TypeScript skills while the SDK-facing code was written. It is not part of the deployed product.</td></tr>
              <tr><th scope="row">Generated PayPal Server SDK 2.5.0</th><td>Run time</td><td>A dependency of the Lambda. Its generated model schemas are a second contract: would the SDK accept this body, and what would it put on the wire? Its source is parsed at build time into an operation map.</td></tr>
              <tr><th scope="row">APIMatic Transformer, validation, code generation, Code Sample API</th><td>Not used</td><td>They need an account Auth Key and work on API definitions and SDKs. None of them judges a request body, so there is nothing to call at run time.</td></tr>
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel" aria-labelledby="m2"><header className="panel-head"><h2 id="m2">Why the SDK matters to a PayPal integration</h2></header>
        <p className="key-line">The plugin teaches the SDK, so its limits are the plugin&apos;s limits.</p>
        <div className="table-wrap" tabIndex={0} role="region" aria-label="SDK 2.5.0 coverage">
          <table>
            <thead><tr><th scope="col">SDK 2.5.0 covers</th><th scope="col">Operations</th></tr></thead>
            <tbody><tr><th scope="row">Orders</th><td>8</td></tr><tr><th scope="row">Payments</th><td>7</td></tr><tr><th scope="row">Subscriptions</th><td>17</td></tr><tr><th scope="row">Transaction Search</th><td>2</td></tr><tr><th scope="row">Vault</th><td>6</td></tr></tbody>
          </table>
        </div>
        <p className="key-line"><strong>Not covered at all:</strong> Payouts, Invoicing, Disputes, Webhooks, Catalog. That is where this repository&apos;s integrations hit most of their problems.</p>
        <p className="subtle">The SDK was generated from an earlier Orders schema than the live 2.36, so it also drops fields the live API accepts.</p>
      </section>

      <section className="panel" aria-labelledby="m3"><header className="panel-head"><h2 id="m3">The record</h2></header>
        <p>The prompts, the skills each one pulled, and what they changed are in <code>BUILD-LOG.md</code> and the transcripts under <code>evidence/plugin/</code> in the repository. <code>evidence/probes/</code>, and the predicted-against-observed sweep is <code>evidence/trap-sweep.out.txt</code>.</p>
      </section>
    </div>
  );
}

import React, { useCallback, useEffect, useState } from 'react';
import Check from './components/Check.jsx';
import { Traps, Examples, Sources } from './components/Library.jsx';
import Method from './components/Method.jsx';
import { Mark, IconSun, IconMoon } from './components/Icons.jsx';

const ROUTES = [
  { id: 'check', label: 'Check a call', nav: 'Check' },
  { id: 'traps', label: 'Known traps', nav: 'Traps' },
  { id: 'examples', label: 'Worked examples', nav: 'Examples' },
  { id: 'sources', label: 'Where sources disagree', nav: 'Sources' },
  { id: 'method', label: 'How it was built', nav: 'Build' },
];

function routeFromHash() { const h = window.location.hash.replace(/^#\/?/, ''); return ROUTES.some((r) => r.id === h) ? h : 'check'; }

function useTheme() {
  const [theme, setTheme] = useState(() => { try { const t = localStorage.getItem('cc.theme'); return t === 'dark' ? 'dark' : 'light'; } catch { return 'light'; } });
  useEffect(() => {
    const el = document.documentElement;
    if (theme) el.setAttribute('data-theme', theme); else el.removeAttribute('data-theme');
    try { theme ? localStorage.setItem('cc.theme', theme) : localStorage.removeItem('cc.theme'); } catch { /* storage can be blocked */ }
  }, [theme]);
  return [theme, () => setTheme(theme === 'dark' ? 'light' : 'dark')];
}

export default function App() {
  const [route, setRoute] = useState(routeFromHash);
  const [pending, setPending] = useState(null);
  const [theme, toggle] = useTheme();
  useEffect(() => { const on = () => { setRoute(routeFromHash()); window.scrollTo(0, 0); }; window.addEventListener('hashchange', on); return () => window.removeEventListener('hashchange', on); }, []);
  useEffect(() => { document.title = route === 'check' ? 'Callcheck: what a PayPal call will do in production' : `${ROUTES.find((r) => r.id === route).label} | Callcheck`; }, [route]);
  const go = useCallback((id) => { window.location.hash = `/${id}`; }, []);
  const openCheck = useCallback((p) => { setPending(p); go('check'); }, [go]);

  return (
    <>
      <a className="skip" href="#main">Skip to the content</a>
      <header className="top">
        <div className="top-in">
          <a className="brand" href="#/check" aria-label="Callcheck, home"><Mark /> <span>callcheck</span></a>
          <nav aria-label="Main">
            <ul>{ROUTES.map((r) => <li key={r.id}><a href={`#/${r.id}`} aria-current={route === r.id ? 'page' : undefined} aria-label={r.label}>{r.nav}</a></li>)}</ul>
          </nav>
          <button type="button" className="btn btn-quiet icon-btn" onClick={toggle} aria-label={theme === 'dark' ? 'Switch to the light theme' : 'Switch to the dark theme'}>{theme === 'dark' ? <IconSun /> : <IconMoon />}</button>
        </div>
      </header>
      <main id="main" tabIndex={-1}>
        {route === 'check' && <Check pending={pending} clearPending={() => setPending(null)} />}
        {route === 'traps' && <Traps onCheck={openCheck} />}
        {route === 'examples' && <Examples onCheck={openCheck} />}
        {route === 'sources' && <Sources />}
        {route === 'method' && <Method />}
      </main>
      <footer className="foot">
        <p>MIT licence.</p>
        <p>Built for the PayPal AI Hackathon, Best Use of APIMatic. Not affiliated with PayPal or APIMatic.</p>
      </footer>
    </>
  );
}

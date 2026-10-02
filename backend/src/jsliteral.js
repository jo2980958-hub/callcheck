// A small, safe reader for JavaScript literals. It never evaluates anything: identifiers it cannot resolve become
// { __ident } markers, calls become { __call, args }. Enough for fetch() options and SDK controller calls.

export class LiteralError extends Error {}

function tokenize(src) {
  const toks = []; let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue; }
    if (c === '"' || c === "'" || c === '`') {
      let j = i + 1; let s = '';
      while (j < n && src[j] !== c) {
        if (src[j] === '\\') { const e = src[j + 1]; s += ({ n: '\n', t: '\t', r: '\r' })[e] ?? e; j += 2; continue; }
        if (c === '`' && src[j] === '$' && src[j + 1] === '{') {
          let depth = 1; let k = j + 2; while (k < n && depth) { if (src[k] === '{') depth++; else if (src[k] === '}') depth--; k++; }
          s += '${' + src.slice(j + 2, k - 1) + '}'; j = k; continue;
        }
        s += src[j++];
      }
      toks.push({ t: 'str', v: s, tpl: c === '`' && s.includes('${') }); i = j + 1; continue;
    }
    if (/[0-9]/.test(c) || (c === '-' && /[0-9]/.test(src[i + 1] ?? ''))) {
      const m = /^-?\d+(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i)); toks.push({ t: 'num', v: Number(m[0]) }); i += m[0].length; continue;
    }
    if (/[A-Za-z_$]/.test(c)) { const m = /^[A-Za-z_$][\w$]*/.exec(src.slice(i)); toks.push({ t: 'id', v: m[0] }); i += m[0].length; continue; }
    if (c === '.' && src[i + 1] === '.' && src[i + 2] === '.') { toks.push({ t: 'p', v: '...' }); i += 3; continue; }
    if ('{}[](),:;.=?!<>+*/%&|'.includes(c)) { toks.push({ t: 'p', v: c }); i++; continue; }
    throw new LiteralError(`Unexpected character "${c}"`);
  }
  return toks;
}

class Reader {
  constructor(toks) { this.toks = toks; this.i = 0; }
  peek() { return this.toks[this.i]; }
  next() { return this.toks[this.i++]; }
  isP(v) { const t = this.peek(); return t && t.t === 'p' && t.v === v; }
  eatP(v) { if (this.isP(v)) { this.i++; return true; } return false; }
  expectP(v) { if (!this.eatP(v)) throw new LiteralError(`Expected "${v}"`); }

  value() {
    const t = this.peek();
    if (!t) throw new LiteralError('Unexpected end of input');
    if (t.t === 'str') { this.next(); return t.tpl ? { __template: t.v } : t.v; }
    if (t.t === 'num') { this.next(); return t.v; }
    if (this.isP('{')) return this.object();
    if (this.isP('[')) return this.array();
    if (this.isP('(')) { this.next(); const v = this.value(); this.expectP(')'); return v; }
    if (t.t === 'id') {
      if (t.v === 'true') { this.next(); return true; }
      if (t.v === 'false') { this.next(); return false; }
      if (t.v === 'null') { this.next(); return null; }
      if (t.v === 'undefined') { this.next(); return undefined; }
      if (t.v === 'await' || t.v === 'new') { this.next(); return this.value(); }
      let name = this.next().v;
      while (this.isP('.') || (this.isP('?') && this.toks[this.i + 1]?.v === '.')) {
        if (this.isP('?')) this.next();
        this.next();
        const p = this.next();
        if (!p || p.t !== 'id') throw new LiteralError('Unsupported expression');
        name += '.' + p.v;
      }
      if (this.isP('(')) {
        this.next(); const args = [];
        while (!this.isP(')')) { args.push(this.value()); if (!this.eatP(',')) break; }
        this.expectP(')');
        return { __call: name, args };
      }
      // arithmetic or comparisons are out of scope: treat the rest of a simple binary expression as unresolved
      return { __ident: name };
    }
    throw new LiteralError(`Unexpected "${t.v}"`);
  }

  object() {
    this.expectP('{'); const o = {};
    while (!this.isP('}')) {
      if (this.eatP('...')) { const v = this.value(); o[`...${v?.__ident ?? 'spread'}`] = { __ident: v?.__ident ?? 'spread' }; if (!this.eatP(',')) break; continue; }
      const k = this.next();
      if (!k) throw new LiteralError('Unterminated object');
      let key;
      if (k.t === 'str' || k.t === 'id') key = k.v; else if (k.t === 'num') key = String(k.v); else throw new LiteralError(`Bad key "${k.v}"`);
      if (this.eatP(':')) o[key] = this.value();
      else o[key] = { __ident: key }; // shorthand { amount }
      if (!this.eatP(',')) break;
    }
    this.expectP('}');
    return o;
  }

  array() {
    this.expectP('['); const a = [];
    while (!this.isP(']')) { a.push(this.value()); if (!this.eatP(',')) break; }
    this.expectP(']');
    return a;
  }
}

export function parseJsExpression(src) {
  const r = new Reader(tokenize(src));
  const v = r.value();
  return v;
}

/** Find `name(args...)` (or `x.name(args...)`) in a snippet and read its arguments. `name` is a RegExp matching the final segment. */
export function extractCall(src, nameRe) {
  const toks = tokenize(src);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.t !== 'id' || !new RegExp(`^(?:${nameRe.source})$`).test(t.v)) continue;
    if (!(toks[i + 1]?.t === 'p' && toks[i + 1].v === '(')) continue;
    // callee chain: walk back over `.id` pairs
    let j = i; const chain = [t.v];
    while (toks[j - 1]?.t === 'p' && toks[j - 1].v === '.' && toks[j - 2]?.t === 'id') { chain.unshift(toks[j - 2].v); j -= 2; }
    const r = new Reader(toks); r.i = i + 2; const args = [];
    try {
      while (!r.isP(')')) { args.push(r.value()); if (!r.eatP(',')) break; }
      r.expectP(')');
    } catch (e) { throw new LiteralError(`Could not read the arguments of ${t.v}(...): ${e.message}`); }
    return { name: t.v, callee: chain.join('.'), args };
  }
  return null;
}

/** All `receiver.method(` call names in order, used to guess which SDK method a snippet means. */
export function callNames(src) {
  const toks = tokenize(src); const out = [];
  for (let i = 0; i < toks.length; i++) if (toks[i].t === 'id' && toks[i + 1]?.t === 'p' && toks[i + 1].v === '(' && toks[i - 1]?.v === '.') out.push({ name: toks[i].v, receiver: toks[i - 2]?.v });
  return out;
}

// A JSON Schema validator for the OpenAPI subset PayPal's schemas use. It reports every problem with a JSON pointer,
// the keyword that failed, and what was expected, so findings can point at the exact field.
import { deref } from './spec.js';

const MAX_ERRORS = 60;

export function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

function typeOk(t, v) {
  const a = typeOf(v);
  if (t === 'integer') return a === 'number' && Number.isInteger(v);
  return a === t;
}

/**
 * @returns {{ errors: Array, unknown: Array }}  errors are violations; unknown are properties the schema never mentions.
 */
export function validate(spec, schema, value) {
  const errors = []; const unknown = [];
  walk(spec, schema, value, '', errors, unknown, 0);
  return { errors: errors.slice(0, MAX_ERRORS), unknown };
}

function push(errors, ptr, keyword, message, extra = {}) { if (errors.length < MAX_ERRORS * 2) errors.push({ ptr: ptr || '/', keyword, message, ...extra }); }

const flatCache = new WeakMap();

/** Merge allOf into one schema view: properties, required and constraints unioned; oneOf/anyOf kept as `variants`. */
function flatten(spec, rawSchema, depth = 0) {
  const schema = deref(spec, rawSchema);
  if (!schema || typeof schema !== 'object' || depth > 12) return {};
  if (flatCache.has(schema)) return flatCache.get(schema);
  const out = { properties: { ...(schema.properties ?? {}) }, required: [...(schema.required ?? [])], variants: [...(schema.oneOf ?? schema.anyOf ?? [])] };
  for (const k of ['type', 'enum', 'const', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'minItems', 'maxItems', 'items', 'additionalProperties', 'nullable']) if (schema[k] !== undefined) out[k] = schema[k];
  for (const sub of schema.allOf ?? []) {
    const f = flatten(spec, sub, depth + 1);
    out.properties = { ...f.properties, ...out.properties };
    out.required.push(...f.required);
    out.variants.push(...f.variants);
    for (const k of ['type', 'enum', 'const', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'minItems', 'maxItems', 'items', 'additionalProperties', 'nullable']) if (out[k] === undefined && f[k] !== undefined) out[k] = f[k];
  }
  flatCache.set(schema, out);
  return out;
}

function variantProps(spec, f, depth = 0) {
  let props = {};
  if (depth > 6) return props;
  for (const v of f.variants) { const vf = flatten(spec, v); props = { ...props, ...vf.properties, ...variantProps(spec, vf, depth + 1) }; }
  return props;
}

function walk(spec, rawSchema, value, ptr, errors, unknown, depth) {
  if (depth > 40 || rawSchema == null || rawSchema === true) return;
  const f = flatten(spec, rawSchema);
  if (value === null && (f.nullable === true || (Array.isArray(f.type) && f.type.includes('null')))) return;

  const types = Array.isArray(f.type) ? f.type : f.type ? [f.type] : [];
  if (types.length && !types.some((t) => typeOk(t, value))) {
    push(errors, ptr, 'type', `expected ${types.join(' or ')} but got ${typeOf(value)}`, { expected: types.join('|'), got: typeOf(value), value });
    return;
  }
  if (f.enum && !f.enum.includes(value)) push(errors, ptr, 'enum', `must be one of ${f.enum.slice(0, 12).join(', ')}${f.enum.length > 12 ? ', ...' : ''}`, { expected: f.enum, value });
  if (f.const !== undefined && value !== f.const) push(errors, ptr, 'const', `must equal ${JSON.stringify(f.const)}`, { value });

  const t = typeOf(value);
  if (t === 'string') {
    if (f.minLength != null && value.length < f.minLength) push(errors, ptr, 'minLength', `must be at least ${f.minLength} characters, got ${value.length}`, { expected: f.minLength, value });
    if (f.maxLength != null && value.length > f.maxLength) push(errors, ptr, 'maxLength', `must be at most ${f.maxLength} characters, got ${value.length}`, { expected: f.maxLength, value });
    if (f.pattern) {
      try {
        if (!new RegExp(f.pattern, 'u').test(value)) push(errors, ptr, 'pattern', `does not match the pattern ${f.pattern}`, { expected: f.pattern, value });
      } catch { /* PCRE-only syntax: skip rather than guess */ }
    }
  } else if (t === 'number') {
    if (f.minimum != null && value < f.minimum) push(errors, ptr, 'minimum', `must be at least ${f.minimum}`, { expected: f.minimum, value });
    if (f.maximum != null && value > f.maximum) push(errors, ptr, 'maximum', `must be at most ${f.maximum}`, { expected: f.maximum, value });
  } else if (t === 'array') {
    if (f.minItems != null && value.length < f.minItems) push(errors, ptr, 'minItems', `needs at least ${f.minItems} item${f.minItems === 1 ? '' : 's'}, has ${value.length}`, { expected: f.minItems, value: value.length });
    if (f.maxItems != null && value.length > f.maxItems) push(errors, ptr, 'maxItems', `allows at most ${f.maxItems} items, has ${value.length}`, { expected: f.maxItems, value: value.length });
    if (f.items) value.forEach((v, i) => walk(spec, f.items, v, `${ptr}/${i}`, errors, unknown, depth + 1));
  } else if (t === 'object') {
    const vProps = variantProps(spec, f);
    const known = { ...vProps, ...f.properties };
    for (const r of new Set(f.required)) {
      if (!(r in value) || value[r] === undefined) push(errors, `${ptr}/${r}`, 'required', 'is required and missing', { missing: r });
    }
    for (const [k, v] of Object.entries(value)) {
      if (f.properties[k]) walk(spec, f.properties[k], v, `${ptr}/${k}`, errors, unknown, depth + 1);
      else if (known[k]) { /* belongs to a variant; checked below */ }
      else if (f.additionalProperties === false) push(errors, `${ptr}/${k}`, 'additionalProperties', 'is not allowed here', { name: k, known: Object.keys(known) });
      else if (f.additionalProperties && typeof f.additionalProperties === 'object') walk(spec, f.additionalProperties, v, `${ptr}/${k}`, errors, unknown, depth + 1);
      else if (Object.keys(known).length) unknown.push({ ptr: `${ptr}/${k}`, name: k, known: Object.keys(known) });
    }
  }

  if (f.variants.length) {
    const results = f.variants.map((s) => { const e = []; const u = []; walk(spec, s, value, ptr, e, u, depth + 1); return { e, u }; });
    const ok = results.find((r) => r.e.length === 0);
    if (!ok) {
      const best = results.reduce((a, b) => (b.e.length < a.e.length ? b : a));
      best.e.forEach((x) => errors.push(x));
    }
  }
}

/** Read a value at a JSON pointer. */
export function at(obj, ptr) {
  return ptr.split('/').filter(Boolean).reduce((n, k) => (n == null ? n : n[k]), obj);
}

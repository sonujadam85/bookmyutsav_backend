// Tiny dependency-free router, validation and helpers.

export class HttpError extends Error {
  constructor(status, message, errors) {
    super(message);
    this.status = status;
    this.errors = errors;
  }
}

export const notFound = (what = 'Record') => new HttpError(404, `${what} not found`);

export class Router {
  routes = [];
  add(method, path, handler, opts = {}) {
    const keys = [];
    const pattern = path.replace(/:(\w+)/g, (_, k) => { keys.push(k); return '([^/]+)'; });
    this.routes.push({ method, re: new RegExp(`^${pattern}/?$`), keys, handler, opts });
  }
  get(p, h, o) { this.add('GET', p, h, o); }
  post(p, h, o) { this.add('POST', p, h, o); }
  put(p, h, o) { this.add('PUT', p, h, o); }
  patch(p, h, o) { this.add('PATCH', p, h, o); }
  delete(p, h, o) { this.add('DELETE', p, h, o); }

  match(method, pathname) {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = pathname.match(r.re);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      return { route: r, params };
    }
    return pathMatched ? { methodNotAllowed: true } : null;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;

function isValidDate(s) {
  if (!DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * Validate and clean a request body against a schema.
 * rule: { type, required, max, min, values, default }
 * partial: only keys present in body are validated/returned (used for PATCH-style updates).
 */
export function validate(body, schema, { partial = false } = {}) {
  const src = body && typeof body === 'object' ? body : {};
  const out = {};
  const errors = {};
  for (const [key, rule] of Object.entries(schema)) {
    let v = src[key];
    if (v === undefined) {
      if (partial) continue;
      v = rule.default;
    }
    if (typeof v === 'string' && v.trim() === '' && rule.type !== 'string') v = null;
    if (typeof v === 'string' && rule.type === 'string') v = v.trim();
    if (v === null || v === undefined || v === '') {
      if (rule.required) errors[key] = 'This field is required';
      else out[key] = rule.default ?? null;
      continue;
    }
    switch (rule.type) {
      case 'string':
        v = String(v);
        if (rule.max && v.length > rule.max) errors[key] = `Maximum ${rule.max} characters`;
        break;
      case 'number':
      case 'int':
        v = Number(v);
        if (!Number.isFinite(v)) { errors[key] = 'Must be a number'; break; }
        if (rule.type === 'int' && !Number.isInteger(v)) errors[key] = 'Must be a whole number';
        if (rule.min !== undefined && v < rule.min) errors[key] = `Must be at least ${rule.min}`;
        if (rule.max !== undefined && v > rule.max) errors[key] = `Must be at most ${rule.max}`;
        if (rule.type === 'number') v = round2(v);
        break;
      case 'bool':
        v = v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0;
        break;
      case 'tristate': // null | 0 | 1
        v = v === true || v === 1 || v === '1' || v === 'true' ? 1 : 0;
        break;
      case 'date':
        v = String(v).slice(0, 10);
        if (!isValidDate(v)) errors[key] = 'Invalid date (YYYY-MM-DD)';
        break;
      case 'time':
        v = String(v).slice(0, 5);
        if (!TIME_RE.test(v)) errors[key] = 'Invalid time (HH:MM)';
        break;
      case 'enum':
        v = String(v);
        if (!rule.values.includes(v)) errors[key] = `Must be one of: ${rule.values.join(', ')}`;
        break;
      case 'mobile':
        v = String(v).replace(/[\s-]/g, '');
        if (!/^\+?\d{10,15}$/.test(v)) errors[key] = 'Enter a valid mobile number (10-15 digits)';
        break;
      case 'email':
        v = String(v).trim().toLowerCase();
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) errors[key] = 'Enter a valid email';
        break;
      case 'color':
        v = String(v);
        if (!/^#[0-9a-fA-F]{6}$/.test(v)) errors[key] = 'Use a hex colour like #7c3aed';
        break;
      default:
        break;
    }
    out[key] = v;
  }
  if (Object.keys(errors).length) throw new HttpError(400, 'Please correct the highlighted fields', errors);
  return out;
}

export function localToday() {
  const d = new Date();
  return toISODate(d);
}

export function toISODate(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function idParam(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n <= 0) throw new HttpError(400, 'Invalid id');
  return n;
}

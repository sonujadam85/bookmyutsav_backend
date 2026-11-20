// Company sign-up (public) and the Super Admin panel: approve, reject, suspend companies and view their KYC.
import { HttpError, validate, idParam, notFound } from '../http.js';
import { hashPassword } from '../auth.js';
import {
  pAll, pGet, pInsert, pRun, pUpdate, getAccount, getCompany, mainCompany, companyBySlug, slugify, RESERVED_SLUGS,
  encryptText, decryptText, saveKycFile, readKycFile, createCompanyDatabase,
} from '../platform.js';
import { mailConfig, sendMail } from '../mailer.js';
import { config } from '../config.js';

const SUPER = { super: true };
const IMG = /^image\/(png|jpe?g|webp)$/;

/** Aadhaar checksum (Verhoeff), so typing mistakes are caught. */
const VD = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],
  [5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
const VP = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],
  [4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
export function validAadhaar(n) {
  if (!/^[2-9]\d{11}$/.test(n)) return false;
  let c = 0;
  [...n].reverse().forEach((d, i) => { c = VD[c][VP[i % 8][Number(d)]]; });
  return c === 0;
}
export const validPan = (p) => /^[A-Z]{5}[0-9]{4}[A-Z]$/.test(p);

/** Card photo sent as base64 from the sign-up form. */
function photo(b64, mime, label) {
  if (!b64) throw new HttpError(400, `Please upload a photo of your ${label}`, { [label === 'Aadhaar card' ? 'aadhaar_photo' : 'pan_photo']: 'Required' });
  const m = String(mime || '').toLowerCase();
  if (!IMG.test(m)) throw new HttpError(400, `${label} photo must be a JPG, PNG or WEBP image`);
  const buf = Buffer.from(String(b64).replace(/^data:[^,]+,/, ''), 'base64');
  if (!buf.length || buf.length > 6 * 1024 * 1024) throw new HttpError(400, `${label} photo must be smaller than 6 MB`);
  return { buf, mime: m === 'image/jpg' ? 'image/jpeg' : m };
}

// Simple limit so the public sign-up cannot be flooded.
const hits = new Map();
function limit(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 3600e3);
  if (list.length >= Number(process.env.SIGNUP_RATE_LIMIT_PER_HOUR || 5)) throw new HttpError(429, 'Too many sign-ups from this device. Please try again later.');
  list.push(now);
  hits.set(ip, list);
}

/** What the Super Admin sees in lists: no full KYC numbers. */
function summary(c) {
  return {
    id: c.id, slug: c.slug, company_name: c.company_name, profile_name: c.profile_name, business_type: c.business_type,
    owner_name: c.owner_name, email: c.email, phone: c.phone, address: c.address, status: c.status, status_note: c.status_note,
    is_main: !!c.is_main, aadhaar_last4: c.aadhaar_last4, pan_masked: c.pan_masked,
    has_aadhaar_photo: !!c.aadhaar_photo, has_pan_photo: !!c.pan_photo, created_at: c.created_at, approved_at: c.approved_at,
  };
}

const appUrl = () => (process.env.APP_URL || `http://localhost:${config.port}`).replace(/\/$/, '');
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

/** Email without failing the request if email is not set up. */
function notify(to, subject, lines, button) {
  if (!mailConfig() || !to) return;
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px;color:#222">${lines.map((l) => `<p>${l}</p>`).join('')}
    ${button ? `<p><a href="${esc(button.href)}" style="background:#FF761E;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600">${esc(button.text)}</a></p>` : ''}</div>`;
  const text = lines.map((l) => l.replace(/<[^>]+>/g, '')).join('\n\n') + (button ? `\n\n${button.text}: ${button.href}` : '');
  sendMail({ to, subject, html, text }).catch((e) => console.error(`Email "${subject}" failed:`, e.message));
}
const superEmail = () => process.env.SUPER_ADMIN_EMAIL || process.env.SMTP_USER
  || pGet('SELECT email FROM accounts WHERE is_super = 1 LIMIT 1')?.email;

export function register(r) {
  // ---------- Public sign-up ----------
  r.get('/api/public/slug-available', ({ query }) => {
    const slug = slugify(query.name || query.slug);
    return { slug, available: slug.length >= 3 && !RESERVED_SLUGS.has(slug) && !companyBySlug(slug) };
  }, { public: true });

  r.post('/api/public/signup', ({ req, body }) => {
    limit(req);
    const d = validate(body, {
      owner_name: { type: 'string', required: true, max: 120 },
      email: { type: 'email', required: true },
      phone: { type: 'mobile', required: true },
      password: { type: 'string', required: true, max: 200 },
      aadhaar_no: { type: 'string', required: true, max: 20 },
      pan_no: { type: 'string', required: true, max: 15 },
      address: { type: 'string', required: true, max: 500 },
      profile_name: { type: 'string', required: true, max: 80 },
      company_name: { type: 'string', required: true, max: 150 },
      business_type: { type: 'string', required: true, max: 80 },
    });
    const errors = {};
    if (d.password.length < 8) errors.password = 'Minimum 8 characters';
    const aadhaar = d.aadhaar_no.replace(/[\s-]/g, '');
    if (!validAadhaar(aadhaar)) errors.aadhaar_no = 'Enter a valid 12-digit Aadhaar number';
    const pan = d.pan_no.replace(/\s/g, '').toUpperCase();
    if (!validPan(pan)) errors.pan_no = 'Enter a valid PAN, e.g. ABCDE1234F';
    const slug = slugify(d.profile_name);
    if (slug.length < 3 || RESERVED_SLUGS.has(slug)) errors.profile_name = 'Choose another profile name (at least 3 letters)';
    const sameSlug = companyBySlug(slug);
    const acc = getAccount(d.email);
    const old = acc && getCompany(acc.company_id);
    // An email can sign up again only if its earlier sign-up was rejected.
    if (acc && old?.status !== 'REJECTED') errors.email = 'This email is already registered. Please log in.';
    if (sameSlug && sameSlug.id !== old?.id) errors.profile_name = 'This profile name is already taken';
    if (Object.keys(errors).length) throw new HttpError(400, Object.values(errors)[0], errors);
    const aPhoto = photo(body.aadhaar_photo, body.aadhaar_photo_mime, 'Aadhaar card');
    const pPhoto = photo(body.pan_photo, body.pan_photo_mime, 'PAN card');

    const data = {
      slug, company_name: d.company_name, profile_name: d.profile_name, business_type: d.business_type,
      owner_name: d.owner_name, email: d.email, phone: d.phone, address: d.address,
      aadhaar_enc: encryptText(aadhaar), aadhaar_last4: aadhaar.slice(-4),
      pan_enc: encryptText(pan), pan_masked: `${pan.slice(0, 2)}XXXXXX${pan.slice(8)}`,
      owner_password_hash: hashPassword(d.password), status: 'PENDING', status_note: null,
    };
    let id;
    if (old) { id = old.id; pUpdate(id, data); } else id = pInsert('companies', data);
    pUpdate(id, {
      aadhaar_photo: saveKycFile(id, aPhoto.buf), aadhaar_photo_mime: aPhoto.mime,
      pan_photo: saveKycFile(id, pPhoto.buf), pan_photo_mime: pPhoto.mime,
    });
    if (!acc) pInsert('accounts', { email: d.email, company_id: id, is_super: 0 });

    notify(superEmail(), `New sign-up waiting for approval – ${d.company_name}`, [
      `<b>${esc(d.company_name)}</b> (${esc(d.business_type)}) signed up.`,
      `Owner: ${esc(d.owner_name)} · ${esc(d.phone)} · ${esc(d.email)}`,
      'Open the Companies page to check the details and approve or reject.',
    ], { text: 'Review sign-up', href: `${appUrl()}/admin/companies` });
    notify(d.email, 'We received your sign-up', [
      `Hello ${esc(d.owner_name)},`, `Thank you for signing up <b>${esc(d.company_name)}</b>. We will check your details and approve your account soon. You will get an email when you can log in.`,
    ]);
    return { status: 'PENDING', slug };
  }, { public: true });

  // ---------- Super Admin ----------
  r.get('/api/super/companies', ({ query }) => {
    const where = query.status ? 'WHERE status = ?' : '';
    return pAll(`SELECT * FROM companies ${where} ORDER BY CASE status WHEN 'PENDING' THEN 0 ELSE 1 END, created_at DESC`, query.status ? [query.status] : []).map(summary);
  }, SUPER);

  r.get('/api/super/companies/:id', ({ params }) => {
    const c = getCompany(idParam(params.id));
    if (!c) throw notFound('Company');
    return { ...summary(c), aadhaar_no: decryptText(c.aadhaar_enc), pan_no: decryptText(c.pan_enc) };
  }, SUPER);

  r.get('/api/super/companies/:id/kyc/:kind', (ctx) => {
    const c = getCompany(idParam(ctx.params.id));
    const kind = ctx.params.kind === 'pan' ? 'pan' : 'aadhaar';
    const file = c?.[`${kind}_photo`] && readKycFile(c.id, c[`${kind}_photo`]);
    if (!file) throw notFound('Photo');
    ctx.res.writeHead(200, { 'Content-Type': c[`${kind}_photo_mime`] || 'image/jpeg', 'Content-Length': file.length, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
    ctx.res.end(file);
    ctx.handled = true;
  }, { ...SUPER, allowQueryToken: true });

  const status = (id) => {
    const c = getCompany(idParam(id));
    if (!c) throw notFound('Company');
    if (c.is_main) throw new HttpError(400, 'The main company cannot be changed here');
    return c;
  };

  r.post('/api/super/companies/:id/approve', ({ params }) => {
    const c = status(params.id);
    if (c.status === 'APPROVED') return summary(c);
    if (c.status === 'SUSPENDED') throw new HttpError(400, 'Use Reactivate for a suspended company');
    createCompanyDatabase(c); // own database with the owner login, default services and settings
    pUpdate(c.id, { status: 'APPROVED', status_note: null, owner_password_hash: null, approved_at: new Date().toISOString() });
    notify(c.email, 'Your account is approved', [
      `Hello ${esc(c.owner_name)},`, `<b>${esc(c.company_name)}</b> is approved. You can now log in with your email and password.`,
      `Your client booking page: ${esc(`${appUrl()}/book/${c.slug}`)}`,
    ], { text: 'Log in', href: `${appUrl()}/login` });
    return summary(getCompany(c.id));
  }, SUPER);

  r.post('/api/super/companies/:id/reject', ({ params, body }) => {
    const c = status(params.id);
    if (c.status !== 'PENDING') throw new HttpError(400, 'Only a waiting sign-up can be rejected. Use Suspend for an approved company.');
    const { reason } = validate(body, { reason: { type: 'string', max: 500 } });
    pUpdate(c.id, { status: 'REJECTED', status_note: reason || null });
    notify(c.email, 'Your sign-up was not approved', [
      `Hello ${esc(c.owner_name)},`, `Your sign-up for <b>${esc(c.company_name)}</b> was not approved.${reason ? ` Reason: ${esc(reason)}` : ''}`,
      'You can sign up again with corrected details.',
    ]);
    return summary(getCompany(c.id));
  }, SUPER);

  r.post('/api/super/companies/:id/suspend', ({ params, body }) => {
    const c = status(params.id);
    if (c.status !== 'APPROVED') throw new HttpError(400, 'Only an approved company can be suspended');
    const { reason } = validate(body, { reason: { type: 'string', max: 500 } });
    pUpdate(c.id, { status: 'SUSPENDED', status_note: reason || null });
    return summary(getCompany(c.id));
  }, SUPER);

  r.post('/api/super/companies/:id/reactivate', ({ params }) => {
    const c = status(params.id);
    if (c.status !== 'SUSPENDED') throw new HttpError(400, 'Only a suspended company can be reactivated');
    pUpdate(c.id, { status: 'APPROVED', status_note: null });
    return summary(getCompany(c.id));
  }, SUPER);
}

export { mainCompany };

// Platform level: the companies using the panel, their logins, KYC documents, and which database each one uses.
// Each company has its own SQLite file and upload folder; the main company (the platform owner) keeps the
// original data/event-pro.db and data/uploads, so its existing data never moves.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { config } from './config.js';
import { companyContext } from './context.js';
import { openDatabase, prepareCompanyDb, seedNewCompany } from './db.js';

const P = new DatabaseSync(config.platformDbFile);
P.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;
CREATE TABLE IF NOT EXISTS companies (
  id                  INTEGER PRIMARY KEY,
  slug                TEXT NOT NULL UNIQUE COLLATE NOCASE,   -- booking link: /book/<slug>
  company_name        TEXT NOT NULL,
  profile_name        TEXT,
  business_type       TEXT,
  owner_name          TEXT NOT NULL,
  email               TEXT NOT NULL COLLATE NOCASE,
  phone               TEXT,
  address             TEXT,
  aadhaar_enc         TEXT,                                  -- AES-256-GCM, see encrypt()
  aadhaar_last4       TEXT,
  pan_enc             TEXT,
  pan_masked          TEXT,
  aadhaar_photo       TEXT,                                  -- encrypted file in data/kyc/<id>/
  aadhaar_photo_mime  TEXT,
  pan_photo           TEXT,
  pan_photo_mime      TEXT,
  owner_password_hash TEXT,                                  -- moved into the company database on approval
  status              TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','APPROVED','REJECTED','SUSPENDED')),
  status_note         TEXT,
  is_main             INTEGER NOT NULL DEFAULT 0,
  approved_at         TEXT,
  created_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS accounts (
  email      TEXT PRIMARY KEY COLLATE NOCASE,   -- one login email belongs to exactly one company
  company_id INTEGER NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  is_super   INTEGER NOT NULL DEFAULT 0
);`);

const row = (r) => (r ? { ...r } : r);
export const pAll = (sql, params = []) => P.prepare(sql).all(...params).map(row);
export const pGet = (sql, params = []) => row(P.prepare(sql).get(...params));
export const pRun = (sql, params = []) => { const r = P.prepare(sql).run(...params); return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) }; };

export function pInsert(table, data) {
  const keys = Object.keys(data);
  return pRun(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`, keys.map((k) => data[k])).lastId;
}
export function pUpdate(id, data) {
  const keys = Object.keys(data);
  if (!keys.length) return;
  pRun(`UPDATE companies SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE id = ?`, [...keys.map((k) => data[k]), id]);
}

// ---------- KYC encryption (Aadhaar / PAN numbers and card photos) ----------
function kycKey() {
  if (process.env.KYC_SECRET) return crypto.createHash('sha256').update(process.env.KYC_SECRET).digest();
  const f = path.join(config.dataDir, '.kyc-key');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
  return Buffer.from(fs.readFileSync(f, 'utf8').trim(), 'hex');
}
const KEY = kycKey();

export function encrypt(buf) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const data = Buffer.concat([c.update(buf), c.final()]);
  return Buffer.concat([Buffer.from('EK1'), iv, c.getAuthTag(), data]);
}
export function decrypt(buf) {
  if (buf.subarray(0, 3).toString() !== 'EK1') throw new Error('Unknown encryption format');
  const iv = buf.subarray(3, 15), tag = buf.subarray(15, 31), data = buf.subarray(31);
  const d = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(data), d.final()]);
}
export const encryptText = (s) => encrypt(Buffer.from(String(s), 'utf8')).toString('base64');
export const decryptText = (s) => (s ? decrypt(Buffer.from(s, 'base64')).toString('utf8') : null);

/** Save an encrypted KYC file; returns its stored name. */
export function saveKycFile(companyId, buf) {
  const dir = path.join(config.kycDir, String(companyId));
  fs.mkdirSync(dir, { recursive: true });
  const name = `${crypto.randomUUID()}.bin`;
  fs.writeFileSync(path.join(dir, name), encrypt(buf), { mode: 0o600 });
  return name;
}
export function readKycFile(companyId, name) {
  const f = path.join(config.kycDir, String(companyId), path.basename(name));
  return fs.existsSync(f) ? decrypt(fs.readFileSync(f)) : null;
}

// ---------- Companies ----------
export const getCompany = (id) => pGet('SELECT * FROM companies WHERE id = ?', [id]);
export const companyBySlug = (slug) => pGet('SELECT * FROM companies WHERE slug = ?', [slug]);
export const mainCompany = () => pGet('SELECT * FROM companies WHERE is_main = 1 ORDER BY id LIMIT 1');
export const getAccount = (email) => pGet('SELECT * FROM accounts WHERE email = ?', [email]);

export const RESERVED_SLUGS = new Set(['admin', 'api', 'book', 'c', 'login', 'signup', 'super', 'main', 'www', 'app', 'events', 'services']);
export function slugify(s) {
  return String(s || '').toLowerCase().normalize('NFKD').replace(/[^\w\s-]/g, '').trim().replace(/[\s_]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
}

const open = new Map();
/** Database and upload folder of a company (opened once, then cached). */
export function companyStore(company) {
  let s = open.get(company.id);
  if (s) return { ...s, company };
  const main = !!company.is_main;
  const dir = path.join(config.companiesDir, String(company.id));
  const dbFile = main ? config.dbFile : path.join(dir, 'event-pro.db');
  const uploadDir = main ? config.mainUploadDir : path.join(dir, 'uploads');
  fs.mkdirSync(uploadDir, { recursive: true });
  s = { db: openDatabase(dbFile), uploadDir };
  open.set(company.id, s);
  companyContext.run({ ...s, company }, () => prepareCompanyDb({ isMain: main }));
  return { ...s, company };
}

/** Run fn with every database call and upload path pointing at this company. */
export function withCompany(company, fn) {
  return companyContext.run(companyStore(company), fn);
}

/** Create the company's own database with its owner login (on approval). */
export function createCompanyDatabase(company) {
  const dir = path.join(config.companiesDir, String(company.id));
  fs.mkdirSync(path.join(dir, 'uploads'), { recursive: true });
  const db = openDatabase(path.join(dir, 'event-pro.db'));
  companyContext.run({ db, uploadDir: path.join(dir, 'uploads'), company }, () => seedNewCompany({
    owner_name: company.owner_name, email: company.email, password_hash: company.owner_password_hash,
    company_name: company.company_name, phone: company.phone, address: company.address,
  }));
  db.close();
}

// ---------- First start: register the existing database as the main company ----------
(function setupMain() {
  if (mainCompany()) return;
  const main = { id: 0, is_main: 1 };
  const store = companyStore(main); // opens data/event-pro.db (creates + seeds it if new)
  open.delete(0);
  const info = companyContext.run({ ...store, company: main }, () => {
    const st = Object.fromEntries(store.db.prepare('SELECT key, value FROM settings').all().map((r) => [r.key, r.value]));
    const users = store.db.prepare('SELECT id, name, email, role FROM users ORDER BY id').all().map(row);
    return { st, users };
  });
  const admin = info.users.find((u) => u.role === 'ADMIN') || info.users[0];
  const name = info.st.business_name || 'Event Pro';
  const id = pInsert('companies', {
    slug: slugify(name) || 'event-pro', company_name: name, profile_name: name, owner_name: admin?.name || 'Administrator',
    email: info.st.business_email || admin?.email || '', phone: info.st.business_phone || null, address: info.st.business_address || null,
    status: 'APPROVED', is_main: 1, approved_at: new Date().toISOString(),
  });
  for (const u of info.users) pInsert('accounts', { email: u.email, company_id: id, is_super: u.id === admin?.id ? 1 : 0 });
  open.set(id, store);
  console.log(`Main company "${name}" set up. Super Admin login: ${admin?.email}`);
})();

// Open the main company at start so its database is ready.
companyStore(mainCompany());

// The app is now called BookMyUtsav: the old default name "Event Pro" of the main company follows once.
(function renameDefaultMain() {
  const m = mainCompany();
  if (m.company_name !== 'Event Pro') return;
  pUpdate(m.id, { company_name: 'BookMyUtsav', profile_name: m.profile_name === 'Event Pro' ? 'BookMyUtsav' : m.profile_name });
  const st = companyStore(m);
  const cur = st.db.prepare("SELECT value FROM settings WHERE key = 'business_name'").get();
  if (!cur || !cur.value || cur.value === 'Event Pro') st.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('business_name', 'BookMyUtsav')").run();
})();

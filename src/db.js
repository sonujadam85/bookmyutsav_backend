import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './config.js';
import { current } from './context.js';
import { hashPassword } from './auth.js';
import { DEFAULT_CHECKLIST, DEFAULT_EVENT_TYPES, DEFAULT_INVENTORY, DEFAULT_SERVICES, SERVICES_V2_NEW, DECOR } from './defaults.js';

// Each company has its own SQLite file. All helpers below work on the database of the company
// handling the current request (see context.js).
const SCHEMA = fs.readFileSync(path.join(ROOT, 'src', 'schema.sql'), 'utf8');

/** Open (and create if needed) a company database file with the full schema. */
export function openDatabase(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const d = new DatabaseSync(file);
  d.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  d.exec(SCHEMA);
  return d;
}

const cdb = () => current().db;
const normalize = (row) => (row ? { ...row } : row);

export const all = (sql, params = []) => cdb().prepare(sql).all(...params).map(normalize);
export const get = (sql, params = []) => normalize(cdb().prepare(sql).get(...params));
export const run = (sql, params = []) => {
  const r = cdb().prepare(sql).run(...params);
  return { changes: Number(r.changes), lastId: Number(r.lastInsertRowid) };
};
export const scalar = (sql, params = []) => {
  const row = cdb().prepare(sql).get(...params);
  return row ? Object.values(row)[0] : null;
};

export function insert(table, data) {
  const keys = Object.keys(data);
  const sql = `INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`;
  return run(sql, keys.map((k) => data[k])).lastId;
}

export function update(table, id, data, { touch = true } = {}) {
  const keys = Object.keys(data);
  if (!keys.length) return 0;
  const sets = keys.map((k) => `${k} = ?`);
  if (touch) sets.push(`updated_at = CURRENT_TIMESTAMP`);
  return run(`UPDATE ${table} SET ${sets.join(', ')} WHERE id = ?`, [...keys.map((k) => data[k]), id]).changes;
}

const txDepth = new WeakMap();
export function tx(fn) {
  const d = cdb();
  const depth = txDepth.get(d) || 0;
  if (depth > 0) return fn();
  d.exec('BEGIN');
  txDepth.set(d, 1);
  try {
    const result = fn();
    d.exec('COMMIT');
    return result;
  } catch (e) {
    d.exec('ROLLBACK');
    throw e;
  } finally {
    txDepth.set(d, 0);
  }
}

export function audit(userId, action, entity, entityId, details) {
  run('INSERT INTO audit_log (user_id, action, entity, entity_id, details) VALUES (?,?,?,?,?)', [
    userId ?? null, action, entity, entityId ?? null, details ? JSON.stringify(details) : null,
  ]);
}

export function seedChecklist(eventId) {
  DEFAULT_CHECKLIST.forEach((item, i) =>
    insert('checklist_items', {
      event_id: eventId,
      name: item.name,
      category: item.category,
      included: null, // not confirmed yet - user verifies each item
      done: 0,
      needs_verification: item.verify ? 1 : 0,
      notes: item.verify ? 'Name read from handwritten notes - please verify.' : null,
      sort_order: i + 1,
    })
  );
}

/** First start of the main company: admin + staff logins and two tentative demo bookings. */
function seedMain() {
  if (scalar('SELECT COUNT(*) FROM users') > 0) return;
  tx(() => {
    insert('users', { name: 'Administrator', email: 'admin@eventpro.local', password_hash: hashPassword('Admin@123'), role: 'ADMIN' });
    insert('users', { name: 'Staff Member', email: 'staff@eventpro.local', password_hash: hashPassword('Staff@123'), role: 'STAFF' });
    for (const t of DEFAULT_EVENT_TYPES) insert('event_types', t);
    for (const it of DEFAULT_INVENTORY) insert('inventory_items', it);

    // Tentative dates from the handwritten notes - fully editable, no amounts assumed.
    const weddingType = scalar("SELECT id FROM event_types WHERE name = 'Wedding'");
    const clientId = insert('clients', { name: 'To be confirmed', mobile: '0000000000', notes: 'Placeholder client for tentative bookings - edit with the real client.' });
    for (const date of ['2026-11-26', '2026-12-11']) {
      const id = insert('events', {
        client_id: clientId, event_type_id: weddingType, name: `Tentative booking ${date.split('-').reverse().join('/')}`,
        event_date: date, status: 'UPCOMING', is_tentative: 1, booking_amount: 0,
        description: 'Tentative date from handwritten notes. Update the client, venue and amounts once confirmed.',
      });
      seedChecklist(id);
      insert('event_decor', { event_id: id });
    }
  });
  console.log('Database seeded. Admin login: admin@eventpro.local / Admin@123  (change it after first login)');
}

/** New company approved by the Super Admin: its one owner login, defaults and business details. */
export function seedNewCompany({ owner_name, email, password_hash, company_name, phone, address }) {
  if (scalar('SELECT COUNT(*) FROM users') > 0) return;
  tx(() => {
    insert('users', { name: owner_name, email, password_hash, role: 'ADMIN' });
    for (const t of DEFAULT_EVENT_TYPES) insert('event_types', t);
    for (const it of DEFAULT_INVENTORY) insert('inventory_items', it);
    const set = (k, v) => v && run('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)', [k, v]);
    set('business_name', company_name);
    set('business_phone', phone);
    set('business_email', email);
    set('business_address', address);
  });
}

// Databases created before service headings existed get the new columns here.
function addColumn(table, col, type) {
  if (!all(`PRAGMA table_info(${table})`).some((c) => c.name === col)) cdb().exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
}

// Runs separately from seed() so an existing database also gets the default price list once.
function seedServices() {
  if (scalar('SELECT COUNT(*) FROM services') > 0) return;
  tx(() => {
    DEFAULT_SERVICES.forEach(([name, price, category, sort_order]) => insert('services', { name, price, category, sort_order }));
    run("INSERT OR REPLACE INTO settings (key, value) VALUES ('services_headings_v2', '1')");
  });
}

// One-time update: put existing services under headings and add the Photography and DJ services.
function migrateServiceHeadings() {
  if (scalar("SELECT value FROM settings WHERE key = 'services_headings_v2'")) return;
  tx(() => {
    const byName = new Map(DEFAULT_SERVICES.map((d) => [d[0], d]));
    for (const s of all('SELECT id, name FROM services WHERE category IS NULL')) {
      const d = byName.get(s.name);
      update('services', s.id, d ? { category: d[2], sort_order: d[3] } : { category: DECOR });
    }
    const have = new Set(all('SELECT name FROM services WHERE active = 1').map((s) => s.name));
    for (const [name, price, category, sort_order] of DEFAULT_SERVICES) {
      if (SERVICES_V2_NEW.has(name) && !have.has(name)) insert('services', { name, price, category, sort_order });
    }
    run(`UPDATE event_services SET category = (SELECT s.category FROM services s WHERE s.id = event_services.service_id) WHERE category IS NULL`);
    run("INSERT OR REPLACE INTO settings (key, value) VALUES ('services_headings_v2', '1')");
  });
}

/** Bring a company database up to date. Runs inside that company's context. */
export function prepareCompanyDb({ isMain }) {
  if (isMain) seedMain();
  addColumn('services', 'category', 'TEXT');
  addColumn('event_services', 'category', 'TEXT');
  seedServices();
  migrateServiceHeadings();
}

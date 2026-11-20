// End-to-end API test. Starts the server on a temp database and exercises every module.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const PORT = 3999;
const BASE = `http://localhost:${PORT}`;
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eventpro-'));
let proc;
let token;
// Fake SMTP server: records every email the API sends.
const mails = [];
const smtp = net.createServer((sock) => {
  let buf = '';
  let inData = false;
  let auth = 0;
  sock.write('220 test ESMTP\r\n');
  sock.on('data', (d) => {
    buf += d.toString('latin1');
    while (true) {
      if (inData) {
        const end = buf.indexOf('\r\n.\r\n');
        if (end < 0) return;
        mails.push(buf.slice(0, end));
        buf = buf.slice(end + 5);
        inData = false;
        sock.write('250 queued\r\n');
        continue;
      }
      const i = buf.indexOf('\r\n');
      if (i < 0) return;
      const line = buf.slice(0, i);
      buf = buf.slice(i + 2);
      if (auth) { auth--; sock.write(auth ? '334 UGFzc3dvcmQ6\r\n' : '235 ok\r\n'); continue; }
      if (/^EHLO/i.test(line)) sock.write('250-test\r\n250 AUTH LOGIN PLAIN\r\n');
      else if (/^AUTH LOGIN/i.test(line)) { auth = 2; sock.write('334 VXNlcm5hbWU6\r\n'); }
      else if (/^(MAIL|RCPT)/i.test(line)) sock.write('250 ok\r\n');
      else if (/^DATA/i.test(line)) { inData = true; sock.write('354 go\r\n'); }
      else if (/^QUIT/i.test(line)) { sock.end('221 bye\r\n'); return; }
      else sock.write('250 ok\r\n');
    }
  });
  sock.on('error', () => {});
});
let staffToken;

async function api(method, url, body, tk = token) {
  const res = await fetch(BASE + url, {
    method,
    headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: `Bearer ${tk}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  return { status: res.status, data: text ? JSON.parse(text) : null };
}

before(async () => {
  await new Promise((r) => smtp.listen(0, '127.0.0.1', r));
  proc = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', 'src/index.js'], {
    cwd: path.resolve(import.meta.dirname, '..'),
    env: {
      ...process.env, PORT: String(PORT), DATA_DIR: dataDir, CLIENT_DIST: path.join(dataDir, 'none'),
      SMTP_HOST: '127.0.0.1', SMTP_PORT: String(smtp.address().port), SMTP_SECURE: 'false', SMTP_ALLOW_INSECURE: 'true',
      SMTP_USER: 'bot@test.local', SMTP_PASS: 'secret', SMTP_FROM: 'Event Pro <bot@test.local>', BOOKING_RATE_LIMIT_PER_HOUR: '20', SIGNUP_RATE_LIMIT_PER_HOUR: '20', VIDEO_MAX_MB: '1',
    },
    stdio: 'pipe',
  });
  await new Promise((resolve, reject) => {
    proc.stdout.on('data', (d) => d.toString().includes('running on') && resolve());
    proc.stderr.on('data', (d) => process.stderr.write(d));
    setTimeout(() => reject(new Error('server did not start')), 8000);
  });
});

after(() => {
  proc?.kill();
  smtp.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

test('auth', async () => {
  assert.equal((await api('GET', '/api/events', null, null)).status, 401);
  assert.equal((await api('POST', '/api/auth/login', { email: 'admin@eventpro.local', password: 'wrong' })).status, 401);
  const r = await api('POST', '/api/auth/login', { email: 'admin@eventpro.local', password: 'Admin@123' });
  assert.equal(r.status, 201);
  token = r.data.token;
  const s = await api('POST', '/api/auth/login', { email: 'staff@eventpro.local', password: 'Staff@123' });
  staffToken = s.data.token;
  assert.equal((await api('GET', '/api/auth/me')).data.role, 'ADMIN');
  assert.equal((await api('GET', '/api/users', null, staffToken)).status, 403);
});

test('seeded tentative events with 29-item checklist', async () => {
  const r = await api('GET', '/api/events');
  assert.equal(r.data.length, 2);
  assert.deepEqual(r.data.map((e) => e.event_date), ['2026-11-26', '2026-12-11']);
  const cl = await api('GET', `/api/events/${r.data[0].id}/checklist`);
  assert.equal(cl.data.length, 29);
  assert.ok(cl.data.every((i) => i.included === null), 'items start unconfirmed');
  assert.equal(cl.data.filter((i) => i.needs_verification).length, 2);
});

let eventId;
test('create event with new client + advance, payments math', async () => {
  const bad = await api('POST', '/api/events', { name: '', event_date: '2026-13-01' });
  assert.equal(bad.status, 400);
  assert.ok(bad.data.errors.name && bad.data.errors.event_date);

  const dup = await api('GET', '/api/events/check-date?date=2026-11-26');
  assert.equal(dup.data.length, 1);

  const r = await api('POST', '/api/events', {
    name: 'Sharma Wedding', event_date: '2026-11-26', start_time: '18:00', end_time: '23:30', venue: 'Royal Garden', guests: 500,
    booking_amount: 200000, status: 'UPCOMING', event_type_id: 1,
    client: { name: 'Rakesh Sharma', mobile: '9876543210' },
    advance_payment: { amount: 50000, payment_date: '2026-11-01', mode: 'UPI', transaction_id: 'UPI123' },
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  eventId = r.data.id;
  assert.equal(r.data.total_received, 50000);
  assert.equal(r.data.remaining_balance, 150000);

  const p = await api('POST', `/api/events/${eventId}/payments`, { payment_date: '2026-11-10', amount: 30000, mode: 'CASH', installment: 'SECOND' });
  assert.equal(p.status, 201);
  assert.equal(p.data.summary.total_received, 80000);
  assert.equal(p.data.summary.remaining_balance, 120000);
  assert.equal(p.data.summary.advance_received, 50000);
  assert.match(p.data.payment.receipt_no, /^RCPT-2026-\d{5}$/);

  const rc = await api('GET', `/api/payments/${p.data.payment.id}/receipt`);
  assert.equal(rc.data.received_to_date, 80000);
  assert.equal(rc.data.balance_after, 120000);

  // Staff cannot delete payments
  assert.equal((await api('DELETE', `/api/payments/${p.data.payment.id}`, null, staffToken)).status, 403);
});

test('functions, checklist, materials, inventory stock', async () => {
  const f = await api('POST', `/api/events/${eventId}/functions`, { name: 'Haldi', function_date: '2026-11-25', start_time: '10:00', end_time: '13:00' });
  assert.equal(f.status, 201);
  const badTime = await api('POST', `/api/events/${eventId}/functions`, { name: 'X', function_date: '2026-11-25', start_time: '10:00', end_time: '09:00' });
  assert.equal(badTime.status, 400);

  const cl = (await api('GET', `/api/events/${eventId}/checklist`)).data;
  assert.equal(cl.length, 29);
  const dj = cl.find((i) => i.name.startsWith('DJ Setup'));
  assert.equal((await api('PUT', `/api/checklist/${dj.id}`, { included: true, done: true })).data.included, 1);
  const custom = await api('POST', `/api/events/${eventId}/checklist`, { name: 'Fireworks', category: 'Entertainment', included: true });
  assert.equal(custom.status, 201);

  const inv = (await api('GET', '/api/inventory')).data;
  const bass = inv.find((i) => i.name === 'Bass Speaker');
  await api('PUT', `/api/inventory/${bass.id}`, { total_stock: 10, rental_price: 1500 });
  const m = await api('POST', `/api/events/${eventId}/materials`, {
    checklist_item_id: dj.id, inventory_item_id: bass.id, name: 'Bass', quantity: 4, unit: 'Piece', price_type: 'RENTAL', rental_price: 1500, purchase_price: 0,
  });
  assert.equal(m.status, 201, JSON.stringify(m.data));
  assert.equal(m.data.total_cost, 6000);
  const after = (await api('GET', `/api/inventory/${bass.id}`)).data;
  assert.equal(after.used_stock, 4);
  assert.equal(after.remaining_stock, 6);
  const upd = await api('PUT', `/api/materials/${m.data.id}`, { price_type: 'PURCHASE', purchase_price: 100 });
  assert.equal(upd.data.total_cost, 400);
});

test('expenses, vendors, P&L', async () => {
  const v = await api('POST', '/api/vendors', { name: 'DJ Rocky', contact: '9999988888', service_category: 'DJ & Sound' });
  assert.equal(v.status, 201);
  const x1 = await api('POST', `/api/events/${eventId}/expenses`, { expense_date: '2026-11-20', category: 'DJ & Sound', vendor_id: v.data.id, quantity: 1, unit_price: 40000, payment_status: 'PARTIAL', amount_paid: 10000 });
  assert.equal(x1.status, 201, JSON.stringify(x1.data));
  assert.equal(x1.data.payment_status, 'PARTIAL');
  const x2 = await api('POST', `/api/events/${eventId}/expenses`, { expense_date: '2026-11-20', category: 'Labour', quantity: 10, unit_price: 800, payment_status: 'PAID' });
  assert.equal(x2.data.total_amount, 8000);
  assert.equal(x2.data.payment_status, 'PAID');

  let vd = (await api('GET', `/api/vendors/${v.data.id}`)).data;
  assert.equal(vd.total_amount, 40000);
  assert.equal(vd.remaining, 30000);

  const over = await api('POST', `/api/vendors/${v.data.id}/payments`, { expense_id: x1.data.id, payment_date: '2026-11-21', amount: 50000, mode: 'CASH' });
  assert.equal(over.status, 400);
  const vp = await api('POST', `/api/vendors/${v.data.id}/payments`, { expense_id: x1.data.id, payment_date: '2026-11-21', amount: 20000, mode: 'UPI' });
  assert.equal(vp.status, 201);
  vd = (await api('GET', `/api/vendors/${v.data.id}`)).data;
  assert.equal(vd.remaining, 10000);
  assert.equal(vd.expenses[0].amount_paid, 30000);

  const pnl = (await api('GET', `/api/events/${eventId}/pnl`)).data;
  assert.equal(pnl.total_revenue, 200000);
  assert.equal(pnl.total_expenses, 48000);
  assert.equal(pnl.net_profit, 152000);
  assert.equal(pnl.profit_percentage, 76);
  assert.equal(pnl.client_pending, 120000);
  assert.equal(pnl.vendor_pending, 10000);

  const ev = (await api('GET', `/api/events/${eventId}/vendors`)).data;
  assert.equal(ev.vendors[0].pending, 10000);

  assert.equal((await api('DELETE', `/api/expenses/${x1.data.id}`)).status, 409, 'linked payments block delete');
  assert.equal((await api('DELETE', `/api/vendors/${v.data.id}`)).status, 409);
});

test('editing an event keeps child data; soft delete', async () => {
  const r = await api('PUT', `/api/events/${eventId}`, { venue: 'New Venue', booking_amount: 210000 });
  assert.equal(r.status, 200);
  assert.equal(r.data.venue, 'New Venue');
  assert.equal(r.data.remaining_balance, 130000);
  assert.equal(r.data.counts.payments, 2);
  assert.equal(r.data.counts.expenses, 2);
  assert.equal(r.data.checklist_summary.total, 30);
  assert.equal(r.data.functions.length, 1);

  const cal = (await api('GET', '/api/calendar?from=2026-11-01&to=2026-11-30')).data;
  assert.ok(cal.some((c) => c.kind === 'function' && c.title === 'Haldi'));
  assert.equal(cal.filter((c) => c.date === '2026-11-26').length, 2, 'multiple events on same date allowed');

  const dash = (await api('GET', '/api/dashboard')).data;
  assert.equal(dash.stats.total_events, 3);
  assert.equal(dash.stats.total_booking_amount, 210000);
  assert.equal(dash.stats.total_advance_received, 80000);
  assert.equal(dash.stats.total_profit, 162000);
  assert.equal((await api('GET', '/api/dashboard', null, staffToken)).data.stats.total_profit, null);

  for (const kind of ['events', 'client-payments', 'pending-payments', 'expenses', 'vendor-payments', 'profit-loss']) {
    const rep = await api('GET', `/api/reports/${kind}?from=2026-01-01&to=2026-12-31`);
    assert.equal(rep.status, 200, kind);
    assert.ok(Array.isArray(rep.data.rows));
  }

  assert.equal((await api('DELETE', `/api/events/${eventId}`, null, staffToken)).status, 403);
  assert.equal((await api('DELETE', `/api/events/${eventId}`)).status, 204);
  assert.equal((await api('GET', `/api/events/${eventId}`)).status, 404);
});

test('documents upload and download', async () => {
  const id = (await api('GET', '/api/events')).data[0].id;
  const up = await api('POST', `/api/events/${id}/documents`, { file_name: 'note.txt', mime_type: 'text/plain', data_base64: Buffer.from('hello').toString('base64') });
  assert.equal(up.status, 201, JSON.stringify(up.data));
  const res = await fetch(`${BASE}/api/documents/${up.data.id}/file?token=${token}`);
  assert.equal(await res.text(), 'hello');
  assert.equal((await api('POST', `/api/events/${id}/documents`, { file_name: 'x.exe', mime_type: 'application/x-msdownload', data_base64: 'AA==' })).status, 400);
});

// ---------- Services & Prices (Event Manager) ----------
const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

test('services: default price list, photos with own prices, roles', async () => {
  const list = (await api('GET', '/api/services')).data;
  assert.equal(list.length, 42);
  assert.equal(list[0].name, 'Home Decoration');
  assert.equal(list[0].price, 3000);
  assert.equal(list[0].category, 'Decoration & Setup');
  // Headings in order: Decoration & Setup, Photography, DJ & Sound
  assert.deepEqual([...new Set(list.map((s) => s.category))], ['Decoration & Setup', 'Photography', 'DJ & Sound']);
  assert.deepEqual(list.filter((s) => s.category === 'Photography').map((s) => s.name),
    ['Photo', 'Video', 'Pre-Wedding Shoot', 'Lagan', 'Bhat', 'Bandori', 'Reception', 'Haldi', 'Mehndi', 'Lagan-Tika']);
  assert.equal(list.filter((s) => s.category === 'DJ & Sound').length, 6);
  assert.equal(list.at(-1).name, 'DJ Setup 4x4 + Ring');
  assert.ok(!('services_headings_v2' in (await api('GET', '/api/settings')).data));

  // Staff can view but not edit
  assert.equal((await api('GET', '/api/services', null, staffToken)).status, 200);
  assert.equal((await api('POST', '/api/services', { name: 'X' }, staffToken)).status, 403);

  const haldi = list.find((s) => s.name === 'Haldi Theme');
  let r = await api('POST', `/api/services/${haldi.id}/photos`, { mime_type: 'image/png', data_base64: PNG, label: 'Yellow' });
  assert.equal(r.status, 201);
  assert.equal(r.data.photos[0].price, 4500); // defaults to service price
  r = await api('POST', `/api/services/${haldi.id}/photos`, { mime_type: 'image/png', data_base64: PNG, price: 7000, label: 'Floral' });
  assert.equal(r.data.photos.length, 2);
  assert.equal(r.data.min_price, 4500);
  assert.equal(r.data.max_price, 7000);
  assert.equal((await api('POST', `/api/services/${haldi.id}/photos`, { mime_type: 'application/pdf', data_base64: PNG })).status, 400);

  const p2 = r.data.photos[1];
  r = await api('PUT', `/api/service-photos/${p2.id}`, { price: 7500 });
  assert.equal(r.data.photos[1].price, 7500);

  const file = await fetch(`${BASE}/api/service-photos/${p2.id}/file?token=${token}`);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'image/png');

  r = await api('PUT', `/api/services/${haldi.id}`, { name: 'Haldi Theme Setup', price: 5000 });
  assert.equal(r.data.name, 'Haldi Theme Setup');
  assert.equal((await api('PUT', `/api/services/${haldi.id}`, { name: '' })).status, 400);

  r = await api('POST', '/api/services', { name: 'Fog Machine', price: 2500, category: 'Decoration & Setup' });
  assert.equal(r.status, 201);
  assert.equal((await api('GET', '/api/services')).data[0].name, 'Fog Machine'); // new service shows first in its heading
  assert.equal((await api('DELETE', `/api/services/${r.data.id}`)).status, 204);

  // New heading goes last; renaming a heading moves its services
  r = await api('POST', '/api/services', { name: 'Welcome Drinks', price: 100, category: 'Catering' });
  assert.equal((await api('GET', '/api/services')).data.at(-1).name, 'Welcome Drinks');
  assert.equal((await api('PUT', '/api/service-categories', { from: 'Catering', to: 'Food & Catering' }, staffToken)).status, 403);
  const renamed = await api('PUT', '/api/service-categories', { from: 'Catering', to: 'Food & Catering' });
  assert.equal(renamed.data.at(-1).category, 'Food & Catering');
  assert.equal((await api('DELETE', `/api/services/${r.data.id}`)).status, 204);
  assert.equal((await api('GET', '/api/services')).data.length, 42);
});

test('event services: select, price snapshot, discount, booking amount, safe deletes', async () => {
  const ev = (await api('GET', '/api/events')).data[0];
  const list = (await api('GET', '/api/services')).data;
  const haldi = list.find((s) => s.name === 'Haldi Theme Setup');
  const dj = list.find((s) => s.name === 'DJ Setup 4x4 + Ring');
  const floral = haldi.photos[1];

  let r = await api('GET', `/api/events/${ev.id}/services`);
  assert.deepEqual(r.data.items, []);
  assert.equal(r.data.total, 0);

  const body = {
    discount: 2500,
    items: [
      { service_id: haldi.id, photo_id: floral.id, unit_price: floral.price, quantity: 1 },
      { service_id: dj.id, unit_price: 30000, quantity: 2 }, // per-event price edit + qty
      { name: 'Extra lights', unit_price: 1000, quantity: 3 }, // custom line
    ],
  };
  r = await api('PUT', `/api/events/${ev.id}/services`, body, staffToken);
  assert.equal(r.status, 200);
  assert.equal(r.data.items.length, 3);
  assert.equal(r.data.items[0].name, 'Haldi Theme Setup');
  assert.equal(r.data.items[0].variant_label, 'Floral');
  assert.equal(r.data.items[0].category, 'Decoration & Setup');
  assert.equal(r.data.items[2].category, 'Other'); // custom line
  assert.equal(r.data.subtotal, 7500 + 60000 + 3000);
  assert.equal(r.data.total, 70500 - 2500);
  assert.equal(r.data.booking_amount, 0); // not changed unless asked

  // Discount larger than subtotal is rejected; wrong photo is rejected
  assert.equal((await api('PUT', `/api/events/${ev.id}/services`, { ...body, discount: 999999 })).status, 400);
  assert.equal((await api('PUT', `/api/events/${ev.id}/services`, { items: [{ service_id: dj.id, photo_id: floral.id, unit_price: 1 }] })).status, 400);

  r = await api('PUT', `/api/events/${ev.id}/services`, { ...body, set_booking_amount: true });
  assert.equal(r.data.booking_amount, 68000);
  assert.equal((await api('GET', `/api/events/${ev.id}`)).data.booking_amount, 68000);

  // Price list changes do not touch the saved event
  await api('PUT', `/api/service-photos/${floral.id}`, { price: 9999 });
  assert.equal((await api('GET', `/api/events/${ev.id}/services`)).data.items[0].unit_price, 7500);

  // Deleting a photo used by an event hides it from the list but keeps the image for the event
  assert.equal((await api('DELETE', `/api/service-photos/${floral.id}`)).status, 204);
  assert.equal((await api('GET', `/api/services/${haldi.id}`)).data.photos.length, 1);
  assert.equal((await fetch(`${BASE}/api/service-photos/${floral.id}/file?token=${token}`)).status, 200);
  assert.equal((await api('GET', `/api/events/${ev.id}/services`)).data.items[0].photo_id, floral.id);

  // Deleting a used service hides it; the event line stays
  assert.equal((await api('DELETE', `/api/services/${dj.id}`)).status, 204);
  assert.ok(!(await api('GET', '/api/services')).data.some((s) => s.id === dj.id));
  assert.equal((await api('GET', `/api/events/${ev.id}/services`)).data.items[1].name, 'DJ Setup 4x4 + Ring');
});

test('public booking page: client picks services, event is created with photos and price', async () => {
  // No login needed for the price list and photos
  const svc = await api('GET', '/api/public/services', null, null);
  assert.equal(svc.status, 200);
  const haldi = svc.data.find((s) => s.name === 'Haldi Theme Setup');
  const photo = haldi.photos[0];
  assert.equal((await fetch(`${BASE}/api/public/service-photos/${photo.id}/file`)).status, 200);
  assert.equal((await api('GET', '/api/public/info', null, null)).status, 200);
  const gate = svc.data.find((s) => s.name === 'Main Gate Decoration');

  const date = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  const body = {
    name: 'Riya Sharma', mobile: '9876500011', event_date: date, venue: 'Shiv Vatika', guests: 300, notes: 'Pastel colours',
    items: [
      { service_id: haldi.id, photo_id: photo.id, quantity: 1, unit_price: 1 }, // browser price is ignored
      { service_id: gate.id, quantity: 2 },
    ],
  };
  // Validation
  assert.equal((await api('POST', '/api/public/bookings', { ...body, items: [] }, null)).status, 400);
  assert.equal((await api('POST', '/api/public/bookings', { ...body, event_date: '2020-01-01' }, null)).status, 400);
  assert.equal((await api('POST', '/api/public/bookings', { ...body, website: 'spam' }, null)).status, 400);

  const r = await api('POST', '/api/public/bookings', body, null);
  assert.equal(r.status, 201);
  const expected = photo.price + 2 * 10000;
  assert.equal(r.data.total, expected);
  assert.match(r.data.reference, /^EV-\d{5}$/);

  // Staff sees a tentative event with the services, photo and total as booking amount
  const evs = (await api('GET', '/api/events', null, staffToken)).data;
  const ev = evs.find((e) => e.name === 'Riya Sharma – Online booking');
  assert.ok(ev);
  assert.equal(ev.is_tentative, 1);
  assert.equal(ev.booking_amount, expected);
  const es = (await api('GET', `/api/events/${ev.id}/services`)).data;
  assert.equal(es.items.length, 2);
  assert.equal(es.items[0].photo_id, photo.id);
  assert.equal(es.items[0].unit_price, photo.price);
  assert.equal((await api('GET', `/api/events/${ev.id}/checklist`)).data.length, 29);

  // Same mobile reuses the client
  await api('POST', '/api/public/bookings', { ...body, name: 'Riya S' }, null);
  const clients = (await api('GET', '/api/clients')).data.filter((c) => c.mobile === '9876500011');
  assert.equal(clients.length, 1);
});

test('booked events list shows services with photos and price', async () => {
  const all = (await api('GET', '/api/bookings?when=all', null, staffToken)).data;
  assert.ok(all.length >= 2);
  assert.ok(all.every((e) => e.items.length > 0));
  const online = (await api('GET', '/api/bookings?source=online')).data;
  const riya = online.find((e) => e.name === 'Riya Sharma – Online booking');
  assert.ok(riya);
  assert.equal(riya.is_online, 1);
  assert.ok(riya.items[0].photo_id);
  assert.equal(riya.services_total, riya.booking_amount);
  assert.ok((await api('GET', '/api/bookings?source=staff&when=all')).data.every((e) => e.is_online === 0));
  assert.equal((await api('GET', '/api/bookings?q=Riya')).data.length, 2);
});

test('online booking emails the owner with the PDF attached, and keeps the PDF on the event', async () => {
  // No recipient yet: booking still works, no email
  const before = mails.length;
  const svc = (await api('GET', '/api/public/services', null, null)).data;
  const date = new Date(Date.now() + 40 * 864e5).toISOString().slice(0, 10);
  const one = { service_id: svc.find((s) => s.category === 'DJ & Sound').id };
  const st = await api('GET', '/api/settings/email-status');
  assert.equal(st.data.configured, true);
  // No address in Settings: falls back to the sending Gmail account (SMTP_USER)
  assert.equal((await api('GET', '/api/settings/email-status')).data.to, 'bot@test.local');

  await api('PUT', '/api/settings', { booking_notify_email: 'owner@test.local' });
  assert.equal((await api('GET', '/api/settings')).data.booking_notify_email, 'owner@test.local');
  assert.equal((await api('POST', '/api/settings/test-email', null, staffToken)).status, 403);
  const t = await api('POST', '/api/settings/test-email');
  assert.equal(t.status, 201);
  assert.equal(t.data.sent_to, 'owner@test.local');
  assert.ok(mails.slice(before).some((m) => /Subject: Test email from BookMyUtsav/.test(m)));

  const fakePdf = 'data:application/pdf;base64,' + Buffer.from('%PDF-1.4\n% test pdf\n%%EOF').toString('base64');
  const r = await api('POST', '/api/public/bookings', {
    name: 'Aman Verma', mobile: '9811122233', email: 'aman@test.local', event_date: date, venue: 'Jaipur',
    items: [one, { service_id: svc.find((s) => s.category === 'Photography').id }], pdf_base64: fakePdf,
  }, null);
  assert.equal(r.status, 201);
  const find = () => mails.find((x) => /Reply-To: aman@test.local/.test(x));
  for (let i = 0; i < 40 && !find(); i++) await new Promise((x) => setTimeout(x, 50));
  const m = find();
  assert.ok(m, 'booking email received');
  assert.match(m, /To: owner@test.local/);
  assert.match(m, /Reply-To: aman@test.local/);
  assert.match(m, new RegExp(`Subject: .*`));
  assert.match(m, /Content-Type: application\/pdf; name="Booking-EV-\d{5}\.pdf"/);
  const html = Buffer.from(m.split('Content-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n')[1].split('--')[0].replace(/\r\n/g, ''), 'base64').toString('utf8');
  assert.match(html, /Aman Verma/);
  assert.match(html, /Photography/);
  assert.match(html, new RegExp(r.data.reference));

  // PDF kept in the event's documents
  const ev = (await api('GET', '/api/events?q=Aman')).data[0];
  const docs = (await api('GET', `/api/events/${ev.id}/documents`)).data;
  assert.equal(docs.length, 1);
  assert.equal(docs[0].mime_type, 'application/pdf');

  // A non-PDF upload is ignored, booking still saved
  const bad = await api('POST', '/api/public/bookings', { name: 'X Y', mobile: '9811122299', event_date: date, items: [one], pdf_base64: 'aGVsbG8=' }, null);
  assert.equal(bad.status, 201);
});

// ---------- Multiple companies: sign-up, approval, and data kept apart ----------
const PNG2 = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';
// Make a valid Aadhaar number (Verhoeff check digit) for tests.
function aadhaar(base11) {
  const d = [[0,1,2,3,4,5,6,7,8,9],[1,2,3,4,0,6,7,8,9,5],[2,3,4,0,1,7,8,9,5,6],[3,4,0,1,2,8,9,5,6,7],[4,0,1,2,3,9,5,6,7,8],[5,9,8,7,6,0,4,3,2,1],[6,5,9,8,7,1,0,4,3,2],[7,6,5,9,8,2,1,0,4,3],[8,7,6,5,9,3,2,1,0,4],[9,8,7,6,5,4,3,2,1,0]];
  const p = [[0,1,2,3,4,5,6,7,8,9],[1,5,7,6,2,8,3,0,9,4],[5,8,0,3,7,9,6,1,4,2],[8,9,1,6,0,4,3,5,2,7],[9,4,5,3,1,2,6,8,7,0],[4,2,8,6,5,7,3,9,0,1],[2,7,9,3,8,0,6,4,1,5],[7,0,4,6,9,1,3,2,5,8]];
  const inv = [0,4,3,2,1,5,6,7,8,9];
  let c = 0;
  [...base11].reverse().forEach((x, i) => { c = d[c][p[(i + 1) % 8][Number(x)]]; });
  return base11 + inv[c];
}
const signup = (o = {}) => ({
  owner_name: 'Ravi Sharma', email: 'ravi@sharma.test', phone: '9876543210', password: 'Sharma@123',
  aadhaar_no: aadhaar('23456789012'), pan_no: 'abcde1234f', address: 'MI Road, Jaipur', profile_name: 'Sharma Events',
  company_name: 'Sharma Events Pvt Ltd', business_type: 'Wedding Planner',
  aadhaar_photo: PNG2, aadhaar_photo_mime: 'image/png', pan_photo: PNG2, pan_photo_mime: 'image/png', ...o,
});

test('companies: sign-up, approval by Super Admin, and each company sees only its own data', async () => {
  // Main admin is the Super Admin and belongs to the main company
  const me = (await api('GET', '/api/auth/me')).data;
  assert.equal(me.is_super, true);
  assert.equal(me.company.is_main, true);
  assert.equal((await api('GET', '/api/auth/me', null, staffToken)).data.is_super, false);
  assert.equal((await api('GET', '/api/super/companies', null, staffToken)).status, 403);

  // Sign-up checks
  assert.equal((await api('GET', '/api/public/slug-available?name=Sharma Events', null, null)).data.available, true);
  let r = await api('POST', '/api/public/signup', signup({ aadhaar_no: '234567890123' }), null);
  assert.equal(r.status, 400); assert.ok(r.data.errors.aadhaar_no);
  r = await api('POST', '/api/public/signup', signup({ pan_no: '12345' }), null);
  assert.ok(r.data.errors.pan_no);
  r = await api('POST', '/api/public/signup', signup({ email: 'admin@eventpro.local' }), null);
  assert.ok(r.data.errors.email);
  r = await api('POST', '/api/public/signup', signup({ pan_photo: null }), null);
  assert.equal(r.status, 400);
  r = await api('POST', '/api/public/signup', signup(), null);
  assert.equal(r.status, 201);
  assert.equal(r.data.slug, 'sharma-events');
  assert.equal((await api('GET', '/api/public/slug-available?name=Sharma Events', null, null)).data.available, false);

  // Waiting for approval: login explains it
  r = await api('POST', '/api/auth/login', { email: 'ravi@sharma.test', password: 'Sharma@123' }, null);
  assert.equal(r.status, 403); assert.match(r.data.message, /waiting for approval/);
  assert.equal((await api('POST', '/api/auth/login', { email: 'ravi@sharma.test', password: 'wrong-pass' }, null)).status, 401);
  assert.equal((await api('GET', '/api/public/c/sharma-events/services', null, null)).status, 404); // no booking page yet

  // Super Admin sees it, with KYC masked in the list and full only in the detail
  const list = (await api('GET', '/api/super/companies')).data;
  const c = list.find((x) => x.slug === 'sharma-events');
  assert.equal(c.status, 'PENDING'); assert.equal(c.pan_masked, 'ABXXXXXX4F'); assert.ok(!('aadhaar_no' in c));
  const full = (await api('GET', `/api/super/companies/${c.id}`)).data;
  assert.equal(full.pan_no, 'ABCDE1234F'); assert.equal(full.aadhaar_no.length, 12);
  const kyc = await fetch(`${BASE}/api/super/companies/${c.id}/kyc/aadhaar?token=${token}`);
  assert.equal(kyc.status, 200); assert.equal(kyc.headers.get('content-type'), 'image/png');
  assert.equal((await fetch(`${BASE}/api/super/companies/${c.id}/kyc/pan?token=${staffToken}`)).status, 403);
  // KYC numbers are not stored in plain text
  const plat = fs.readFileSync(path.join(dataDir, 'platform.db')).toString('latin1') + (fs.existsSync(path.join(dataDir, 'platform.db-wal')) ? fs.readFileSync(path.join(dataDir, 'platform.db-wal')).toString('latin1') : '');
  assert.ok(!plat.includes(full.aadhaar_no)); assert.ok(!plat.includes('ABCDE1234F'));

  assert.equal((await api('POST', `/api/super/companies/${c.id}/approve`, null, staffToken)).status, 403);
  r = await api('POST', `/api/super/companies/${c.id}/approve`);
  assert.equal(r.data.status, 'APPROVED');

  // Company B logs in and starts empty (its own default services, no events or clients of the main company)
  r = await api('POST', '/api/auth/login', { email: 'ravi@sharma.test', password: 'Sharma@123' }, null);
  assert.equal(r.status, 201);
  const tb = r.data.token;
  assert.equal(r.data.user.company.slug, 'sharma-events'); assert.equal(r.data.user.is_super, false); assert.equal(r.data.user.role, 'ADMIN');
  assert.equal((await api('GET', '/api/events?when=all', null, tb)).data.length, 0);
  assert.equal((await api('GET', '/api/clients', null, tb)).data.length, 0);
  assert.equal((await api('GET', '/api/bookings?when=all', null, tb)).data.length, 0);
  assert.equal((await api('GET', '/api/services', null, tb)).data.length, 0); // starts with no services; adds its own
  assert.equal((await api('GET', '/api/settings', null, tb)).data.business_name, 'Sharma Events Pvt Ltd');
  // No Super Admin or user management for company owners
  assert.equal((await api('GET', '/api/super/companies', null, tb)).status, 403);
  assert.equal((await api('GET', '/api/users', null, tb)).status, 403);

  // B's own changes stay in B
  await api('PUT', '/api/settings', { business_name: 'Sharma Events' }, tb);
  const bSvc = (await api('POST', '/api/services', { name: 'Sharma Special Stage', price: 77777, category: 'Decoration & Setup' }, tb)).data;
  r = await api('POST', '/api/events', { client: { name: 'Neha', mobile: '9000000001' }, name: 'Neha Wedding', event_date: '2027-02-10' }, tb);
  assert.equal(r.status, 201);
  const bEvent = r.data;
  assert.ok(!(await api('GET', '/api/services')).data.some((s) => s.name === 'Sharma Special Stage'));
  assert.ok(!(await api('GET', '/api/events?q=Neha')).data.length);
  assert.notEqual((await api('GET', '/api/settings')).data.business_name, 'Sharma Events');

  // B cannot open the main company's records by id
  const mainEvents = (await api('GET', '/api/events')).data;
  const mainOnly = mainEvents.find((e) => e.id !== bEvent.id) || mainEvents[0];
  const seen = await api('GET', `/api/events/${mainOnly.id}`, null, tb);
  assert.ok(seen.status === 404 || seen.data.name !== mainOnly.name);
  // Photo upload goes to B's own folder; main company's list does not change
  await api('POST', `/api/services/${bSvc.id}/photos`, { mime_type: 'image/png', data_base64: PNG2 }, tb);
  assert.ok(fs.readdirSync(path.join(dataDir, 'companies', String(c.id), 'uploads')).some((f) => f.startsWith('svc-')));

  // B's own booking page shows B's services and creates the booking in B only
  const pub = (await api('GET', '/api/public/c/sharma-events/services', null, null)).data;
  assert.ok(pub.some((s) => s.name === 'Sharma Special Stage'));
  assert.equal((await api('GET', '/api/public/c/sharma-events/info', null, null)).data.business_name, 'Sharma Events');
  const date = new Date(Date.now() + 50 * 864e5).toISOString().slice(0, 10);
  r = await api('POST', '/api/public/c/sharma-events/bookings', { name: 'Pooja', mobile: '9000000002', event_date: date, items: [{ service_id: bSvc.id }] }, null);
  assert.equal(r.status, 201); assert.equal(r.data.total, 77777);
  assert.equal((await api('GET', '/api/bookings?source=online&q=Pooja', null, tb)).data.length, 1);
  assert.equal((await api('GET', '/api/bookings?source=online&q=Pooja')).data.length, 0);
  // Booking email goes to company B's sign-up email, with B's name as sender
  const find = () => mails.find((m) => /To: ravi@sharma.test/.test(m) && /New booking/.test(Buffer.from(m.match(/Subject: =\?UTF-8\?B\?([^?]+)/)?.[1] || '', 'base64').toString()));
  for (let i = 0; i < 40 && !find(); i++) await new Promise((x) => setTimeout(x, 50));
  assert.ok(find(), 'company B got its booking email');
  assert.match(find(), /From: Sharma Events <bot@test.local>/);

  // Suspend: B's session stops working and login explains why; reactivate restores it
  await api('POST', `/api/super/companies/${c.id}/suspend`, { reason: 'Payment due' });
  assert.equal((await api('GET', '/api/events', null, tb)).status, 401);
  r = await api('POST', '/api/auth/login', { email: 'ravi@sharma.test', password: 'Sharma@123' }, null);
  assert.equal(r.status, 403); assert.match(r.data.message, /suspended.*Payment due/);
  assert.equal((await api('GET', '/api/public/c/sharma-events/services', null, null)).status, 404);
  const sub = (m) => Buffer.from(m.match(/Subject: =\?UTF-8\?B\?([^?]+)/)?.[1] || '', 'base64').toString() || (m.match(/Subject: (.*)/)?.[1] ?? '');
  const waitMail = async (re) => { for (let i = 0; i < 40 && !mails.some((m) => /To: ravi@sharma.test/.test(m) && re.test(sub(m))); i++) await new Promise((x) => setTimeout(x, 50)); return mails.some((m) => /To: ravi@sharma.test/.test(m) && re.test(sub(m))); };
  assert.ok(await waitMail(/ID has been stopped/), 'stop email sent to the company');
  await api('POST', `/api/super/companies/${c.id}/reactivate`);
  assert.ok(await waitMail(/active again/), 'start email sent to the company');
  assert.equal((await api('GET', '/api/events', null, tb)).status, 200);
  assert.equal((await api('POST', `/api/super/companies/${me.company.id}/suspend`)).status, 400); // main company is protected

  // Reject a second sign-up, then let it sign up again
  await api('POST', '/api/public/signup', signup({ email: 'x@y.test', profile_name: 'XY Decor', aadhaar_no: aadhaar('34567890123') }), null);
  const x = (await api('GET', '/api/super/companies?status=PENDING')).data.find((z) => z.slug === 'xy-decor');
  await api('POST', `/api/super/companies/${x.id}/reject`, { reason: 'PAN photo not clear' });
  r = await api('POST', '/api/auth/login', { email: 'x@y.test', password: 'Sharma@123' }, null);
  assert.match(r.data.message, /not approved.*PAN photo not clear/);
  r = await api('POST', '/api/public/signup', signup({ email: 'x@y.test', profile_name: 'XY Decor', aadhaar_no: aadhaar('34567890123') }), null);
  assert.equal(r.status, 201);
  assert.equal((await api('GET', `/api/super/companies/${x.id}`)).data.status, 'PENDING');
});

test('service video links: YouTube and Instagram only, shown on the booking page', async () => {
  const svc = (await api('GET', '/api/services')).data.find((x) => x.name === 'Wedding Stage');
  assert.deepEqual(svc.videos, []);
  const add = (url, label) => api('POST', `/api/services/${svc.id}/videos`, { url, label });
  let r = await add('https://youtu.be/dQw4w9WgXcQ?si=abc', 'Stage walkthrough');
  assert.equal(r.status, 201);
  assert.deepEqual(r.data.videos.map((v) => [v.provider, v.video_id, v.label]), [['youtube', 'dQw4w9WgXcQ', 'Stage walkthrough']]);
  r = await add('https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s');
  assert.equal(r.data.videos[1].video_id, 'dQw4w9WgXcQ');
  r = await add('youtube.com/shorts/abcdefghijk');
  assert.equal(r.data.videos[2].video_id, 'abcdefghijk');
  r = await add('https://www.instagram.com/reel/C9xYz12AbCd/?igsh=xyz');
  assert.deepEqual([r.data.videos[3].provider, r.data.videos[3].video_id], ['instagram', 'reel/C9xYz12AbCd']);
  r = await add('https://www.instagram.com/reels/C9xYz12AbCd/');
  assert.equal(r.data.videos[4].video_id, 'reel/C9xYz12AbCd');
  // Anything else is refused
  for (const bad of ['https://vimeo.com/123', 'https://evil.test/watch?v=dQw4w9WgXcQ', 'javascript:alert(1)', 'https://youtube.com/watch?v=bad"><x']) {
    assert.equal((await add(bad)).status, 400, bad);
  }
  assert.equal((await api('POST', `/api/services/${svc.id}/videos`, { url: 'https://youtu.be/dQw4w9WgXcQ' }, staffToken)).status, 403);

  const vid = r.data.videos[0];
  r = await api('PUT', `/api/service-videos/${vid.id}`, { label: 'Night view' });
  assert.equal(r.data.videos[0].label, 'Night view');
  assert.equal((await api('DELETE', `/api/service-videos/${r.data.videos[4].id}`)).status, 204);

  const pub = (await api('GET', '/api/public/services', null, null)).data.find((x) => x.id === svc.id);
  assert.equal(pub.videos.length, 4);
  assert.ok(!('url' in pub.videos[0]));
  assert.equal((await api('GET', '/api/services', null, staffToken)).data.find((x) => x.id === svc.id).videos.length, 4);
});

test('service video files: upload, play with Range, size and type limits, delete', async () => {
  const svc = (await api('GET', '/api/services')).data.find((x) => x.name === 'Mini Stage');
  const up = (body, type = 'video/mp4', t = token, q = '?name=stage.mp4&label=Walkthrough') =>
    fetch(`${BASE}/api/services/${svc.id}/videos/upload${q}`, { method: 'POST', headers: { Authorization: `Bearer ${t}`, 'Content-Type': type }, body });
  const bytes = Buffer.alloc(300 * 1024, 7);
  let r = await up(bytes);
  assert.equal(r.status, 201);
  const data = await r.json();
  const v = data.videos.at(-1);
  assert.equal(v.provider, 'file'); assert.equal(v.label, 'Walkthrough'); assert.equal(v.size, bytes.length);

  // Play it: whole file and a byte range
  r = await fetch(`${BASE}/api/service-videos/${v.id}/file?token=${token}`);
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'video/mp4'); assert.equal(r.headers.get('accept-ranges'), 'bytes');
  assert.equal((await r.arrayBuffer()).byteLength, bytes.length);
  r = await fetch(`${BASE}/api/service-videos/${v.id}/file?token=${token}`, { headers: { Range: 'bytes=100-199' } });
  assert.equal(r.status, 206); assert.equal(r.headers.get('content-range'), `bytes 100-199/${bytes.length}`);
  assert.equal((await r.arrayBuffer()).byteLength, 100);
  // Public booking page can play it, without exposing the file name
  const pub = (await api('GET', '/api/public/services', null, null)).data.find((x) => x.id === svc.id);
  assert.equal(pub.videos.at(-1).video_id, null);
  assert.equal((await fetch(`${BASE}/api/public/service-videos/${v.id}/file`)).status, 200);

  // Limits
  assert.equal((await up(bytes, 'application/pdf')).status, 400);
  assert.equal((await up(Buffer.alloc(1.5 * 1024 * 1024, 1))).status, 413);
  assert.equal((await up(bytes, 'video/mp4', staffToken)).status, 403);
  assert.equal((await fetch(`${BASE}/api/service-videos/${v.id}/file`)).status, 401);

  // Delete removes the file
  const before = fs.readdirSync(path.join(dataDir, 'uploads')).filter((f) => f.startsWith('svcvid-')).length;
  assert.equal((await api('DELETE', `/api/service-videos/${v.id}`)).status, 204);
  assert.equal(fs.readdirSync(path.join(dataDir, 'uploads')).filter((f) => f.startsWith('svcvid-')).length, before - 1);
  assert.equal((await fetch(`${BASE}/api/public/service-videos/${v.id}/file`)).status, 404);
});

test('branding: main company is BookMyUtsav, and the business name in Settings renames the company', async () => {
  const me = (await api('GET', '/api/auth/me')).data;
  assert.equal(me.company.name, 'BookMyUtsav');
  assert.equal((await api('GET', '/api/settings')).data.business_name, 'BookMyUtsav');
  await api('PUT', '/api/settings', { business_name: 'Sonu Events' });
  assert.equal((await api('GET', '/api/auth/me')).data.company.name, 'Sonu Events');
  await api('PUT', '/api/settings', { business_name: 'BookMyUtsav' });
});

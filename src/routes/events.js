import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { all, get, insert, update, run, scalar, tx, audit, seedChecklist } from '../db.js';
import { HttpError, validate, idParam, notFound, round2 } from '../http.js';
import { EVENT_SELECT, withMoney, eventPnl } from '../finance.js';
import { clientSchema } from './masters.js';
import { config } from '../config.js';
import { DEFAULT_CHECKLIST } from '../defaults.js';
import { createClientPayment } from './finance.js';

const ADMIN = { roles: ['ADMIN'] };
const STATUSES = ['UPCOMING', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'];

const eventSchema = {
  client_id: { type: 'int' },
  event_type_id: { type: 'int' },
  name: { type: 'string', required: true, max: 200 },
  event_date: { type: 'date', required: true },
  start_time: { type: 'time' },
  end_time: { type: 'time' },
  venue: { type: 'string', max: 200 },
  address: { type: 'string', max: 500 },
  guests: { type: 'int', min: 0 },
  booking_amount: { type: 'number', min: 0, default: 0 },
  description: { type: 'string', max: 5000 },
  special_instructions: { type: 'string', max: 5000 },
  status: { type: 'enum', values: STATUSES, default: 'UPCOMING' },
  is_tentative: { type: 'bool', default: 0 },
};

const functionSchema = {
  name: { type: 'string', required: true, max: 150 },
  function_date: { type: 'date', required: true },
  start_time: { type: 'time' },
  end_time: { type: 'time' },
  venue: { type: 'string', max: 200 },
  notes: { type: 'string', max: 2000 },
  status: { type: 'enum', values: STATUSES, default: 'UPCOMING' },
  sort_order: { type: 'int', default: 0 },
};

const checklistSchema = {
  name: { type: 'string', required: true, max: 150 },
  category: { type: 'string', max: 100 },
  included: { type: 'tristate' },
  done: { type: 'bool', default: 0 },
  needs_verification: { type: 'bool', default: 0 },
  notes: { type: 'string', max: 2000 },
  sort_order: { type: 'int' },
};

const materialSchema = {
  checklist_item_id: { type: 'int' },
  inventory_item_id: { type: 'int' },
  name: { type: 'string', required: true, max: 150 },
  category: { type: 'string', max: 100 },
  quantity: { type: 'number', min: 0, required: true },
  unit: { type: 'string', required: true, max: 30, default: 'Piece' },
  price_type: { type: 'enum', values: ['PURCHASE', 'RENTAL'], default: 'RENTAL' },
  purchase_price: { type: 'number', min: 0, default: 0 },
  rental_price: { type: 'number', min: 0, default: 0 },
  vendor_id: { type: 'int' },
  required_date: { type: 'date' },
  availability: { type: 'enum', values: ['AVAILABLE', 'PARTIAL', 'NOT_AVAILABLE', 'ORDERED'], default: 'AVAILABLE' },
  notes: { type: 'string', max: 2000 },
};

const decorSchema = {
  theme: { type: 'string', max: 300 },
  color_scheme: { type: 'string', max: 300 },
  flowers: { type: 'string', max: 1000 },
  lighting: { type: 'string', max: 1000 },
  backdrop: { type: 'string', max: 1000 },
  notes: { type: 'string', max: 5000 },
};

export function requireEvent(id) {
  const ev = get('SELECT * FROM events WHERE id = ? AND deleted_at IS NULL', [id]);
  if (!ev) throw notFound('Event');
  return ev;
}

function checkTimes(d) {
  if (d.start_time && d.end_time && d.end_time <= d.start_time) {
    // Allow events that run past midnight only when explicitly flagged by the user via notes; otherwise reject.
    throw new HttpError(400, 'End time must be after start time', { end_time: 'Must be after start time' });
  }
}

function checkRefs(d) {
  if (d.client_id && !get('SELECT id FROM clients WHERE id = ?', [d.client_id])) throw new HttpError(400, 'Selected client does not exist', { client_id: 'Invalid client' });
  if (d.event_type_id && !get('SELECT id FROM event_types WHERE id = ?', [d.event_type_id])) throw new HttpError(400, 'Selected event type does not exist', { event_type_id: 'Invalid type' });
}

function materialTotal(m) {
  const price = m.price_type === 'PURCHASE' ? m.purchase_price : m.rental_price;
  return round2(Number(m.quantity || 0) * Number(price || 0)); // Total Cost = Quantity x Unit Price
}

export function eventDetail(id) {
  const ev = withMoney(get(`${EVENT_SELECT} WHERE e.id = ? AND e.deleted_at IS NULL`, [id]));
  if (!ev) throw notFound('Event');
  ev.client = get('SELECT * FROM clients WHERE id = ?', [ev.client_id]);
  ev.functions = all('SELECT * FROM event_functions WHERE event_id = ? ORDER BY function_date, start_time, sort_order', [id]);
  ev.checklist_summary = get(`SELECT COUNT(*) AS total,
      SUM(CASE WHEN included = 1 THEN 1 ELSE 0 END) AS included,
      SUM(CASE WHEN included = 0 THEN 1 ELSE 0 END) AS excluded,
      SUM(CASE WHEN included IS NULL THEN 1 ELSE 0 END) AS unconfirmed,
      SUM(CASE WHEN included = 1 AND done = 1 THEN 1 ELSE 0 END) AS completed
    FROM checklist_items WHERE event_id = ?`, [id]);
  ev.counts = get(`SELECT
      (SELECT COUNT(*) FROM event_materials WHERE event_id = ?) AS materials,
      (SELECT COUNT(*) FROM expenses WHERE event_id = ?) AS expenses,
      (SELECT COUNT(*) FROM client_payments WHERE event_id = ?) AS payments,
      (SELECT COUNT(*) FROM documents WHERE event_id = ?) AS documents`, [id, id, id, id]);
  return ev;
}

export function register(r) {
  // ---------- Events ----------
  r.get('/api/events', ({ query }) => {
    const where = ['e.deleted_at IS NULL'];
    const p = [];
    if (query.q) {
      where.push('(e.name LIKE ? OR c.name LIKE ? OR c.mobile LIKE ? OR e.venue LIKE ?)');
      p.push(...Array(4).fill(`%${query.q}%`));
    }
    if (query.status) { where.push('e.status = ?'); p.push(query.status); }
    if (query.typeId) { where.push('e.event_type_id = ?'); p.push(Number(query.typeId)); }
    if (query.clientId) { where.push('e.client_id = ?'); p.push(Number(query.clientId)); }
    if (query.from) { where.push('e.event_date >= ?'); p.push(query.from); }
    if (query.to) { where.push('e.event_date <= ?'); p.push(query.to); }
    const sorts = {
      date_asc: 'e.event_date ASC, e.start_time ASC',
      date_desc: 'e.event_date DESC, e.start_time DESC',
      name: 'e.name COLLATE NOCASE ASC',
      client: 'c.name COLLATE NOCASE ASC',
      amount_desc: 'e.booking_amount DESC',
      created_desc: 'e.id DESC',
    };
    const order = sorts[query.sort] || sorts.date_asc;
    let rows = all(`${EVENT_SELECT} WHERE ${where.join(' AND ')} ORDER BY ${order}`, p).map(withMoney);
    if (query.pending === '1') rows = rows.filter((e) => e.remaining_balance > 0 && e.status !== 'CANCELLED');
    return rows;
  });

  // Used before saving to warn about other bookings on the same date.
  r.get('/api/events/check-date', ({ query }) => {
    const date = validate(query, { date: { type: 'date', required: true } }).date;
    const exclude = Number(query.excludeId) || 0;
    const events = all(`SELECT e.id, e.name, e.start_time, e.end_time, e.venue, c.name AS client_name, 'event' AS kind
      FROM events e JOIN clients c ON c.id = e.client_id
      WHERE e.event_date = ? AND e.deleted_at IS NULL AND e.status <> 'CANCELLED' AND e.id <> ?`, [date, exclude]);
    const functions = all(`SELECT e.id, f.name || ' - ' || e.name AS name, f.start_time, f.end_time, COALESCE(f.venue, e.venue) AS venue, c.name AS client_name, 'function' AS kind
      FROM event_functions f JOIN events e ON e.id = f.event_id JOIN clients c ON c.id = e.client_id
      WHERE f.function_date = ? AND e.deleted_at IS NULL AND f.status <> 'CANCELLED' AND e.id <> ?`, [date, exclude]);
    return [...events, ...functions];
  });

  r.get('/api/events/:id', ({ params }) => eventDetail(idParam(params.id)));

  r.post('/api/events', ({ body, user }) => {
    const data = validate(body, eventSchema);
    checkTimes(data);
    return tx(() => {
      let clientId = data.client_id;
      if (!clientId) {
        if (!body.client) throw new HttpError(400, 'Select an existing client or enter client details', { client_id: 'Client is required' });
        const c = validate(body.client, clientSchema);
        clientId = insert('clients', c);
      } else if (body.client) {
        update('clients', clientId, validate(body.client, clientSchema, { partial: true }));
      }
      checkRefs({ ...data, client_id: clientId });
      const id = insert('events', { ...data, client_id: clientId, created_by: user.id });
      if (body.seed_checklist !== false) seedChecklist(id);
      insert('event_decor', { event_id: id });

      // Advance payment entered on the event form becomes the first payment entry.
      const adv = body.advance_payment;
      if (adv && Number(adv.amount) > 0) {
        createClientPayment(id, { payment_date: adv.payment_date || data.event_date, amount: adv.amount, mode: adv.mode || 'CASH', installment: 'ADVANCE', transaction_id: adv.transaction_id, notes: adv.notes || 'Advance recorded at booking' }, user);
      }
      audit(user.id, 'CREATE', 'event', id);
      return eventDetail(id);
    });
  });

  // Update only the event's own fields. Checklist, materials, payments etc. are never touched here.
  r.put('/api/events/:id', ({ params, body, user }) => {
    const id = idParam(params.id);
    const existing = requireEvent(id);
    const data = validate(body, eventSchema, { partial: true });
    checkTimes({ ...existing, ...data });
    return tx(() => {
      if (body.client && (data.client_id || existing.client_id)) {
        update('clients', data.client_id || existing.client_id, validate(body.client, clientSchema, { partial: true }));
      }
      checkRefs(data);
      update('events', id, data);
      audit(user.id, 'UPDATE', 'event', id, { before: existing, changes: data });
      return eventDetail(id);
    });
  });

  r.patch('/api/events/:id/status', ({ params, body, user }) => {
    const id = idParam(params.id);
    requireEvent(id);
    const { status } = validate(body, { status: { type: 'enum', values: STATUSES, required: true } });
    update('events', id, { status });
    audit(user.id, 'STATUS', 'event', id, { status });
    return eventDetail(id);
  });

  // Soft delete keeps all payment / expense history recoverable.
  r.delete('/api/events/:id', ({ params, user }) => {
    const id = idParam(params.id);
    requireEvent(id);
    run('UPDATE events SET deleted_at = CURRENT_TIMESTAMP WHERE id = ?', [id]);
    audit(user.id, 'DELETE', 'event', id);
  }, ADMIN);

  r.get('/api/events/:id/pnl', ({ params }) => {
    const id = idParam(params.id);
    requireEvent(id);
    return eventPnl(id);
  });

  // ---------- Functions / schedule ----------
  r.get('/api/events/:id/functions', ({ params }) => {
    const id = idParam(params.id);
    requireEvent(id);
    return all('SELECT * FROM event_functions WHERE event_id = ? ORDER BY function_date, start_time, sort_order', [id]);
  });
  r.post('/api/events/:id/functions', ({ params, body, user }) => {
    const id = idParam(params.id);
    requireEvent(id);
    const data = validate(body, functionSchema);
    checkTimes(data);
    const fid = insert('event_functions', { ...data, event_id: id });
    audit(user.id, 'CREATE', 'function', fid);
    return get('SELECT * FROM event_functions WHERE id = ?', [fid]);
  });
  r.put('/api/functions/:fid', ({ params, body }) => {
    const fid = idParam(params.fid);
    const existing = get('SELECT * FROM event_functions WHERE id = ?', [fid]);
    if (!existing) throw notFound('Function');
    const data = validate(body, functionSchema, { partial: true });
    checkTimes({ ...existing, ...data });
    update('event_functions', fid, data, { touch: false });
    return get('SELECT * FROM event_functions WHERE id = ?', [fid]);
  });
  r.delete('/api/functions/:fid', ({ params, user }) => {
    const fid = idParam(params.fid);
    if (!run('DELETE FROM event_functions WHERE id = ?', [fid]).changes) throw notFound('Function');
    audit(user.id, 'DELETE', 'function', fid);
  });

  // ---------- Checklist ----------
  const listChecklist = (id) => all(`SELECT ci.*,
      (SELECT COUNT(*) FROM event_materials m WHERE m.checklist_item_id = ci.id) AS material_count,
      (SELECT COALESCE(SUM(m.total_cost),0) FROM event_materials m WHERE m.checklist_item_id = ci.id) AS material_cost
    FROM checklist_items ci WHERE ci.event_id = ? ORDER BY ci.sort_order, ci.id`, [id]);

  r.get('/api/events/:id/checklist', ({ params }) => {
    const id = idParam(params.id);
    requireEvent(id);
    return listChecklist(id);
  });
  r.post('/api/events/:id/checklist', ({ params, body }) => {
    const id = idParam(params.id);
    requireEvent(id);
    const data = validate(body, checklistSchema);
    if (data.sort_order === null) data.sort_order = (scalar('SELECT COALESCE(MAX(sort_order),0) FROM checklist_items WHERE event_id = ?', [id]) || 0) + 1;
    const cid = insert('checklist_items', { ...data, event_id: id });
    return get('SELECT * FROM checklist_items WHERE id = ?', [cid]);
  });
  r.post('/api/events/:id/checklist/restore-defaults', ({ params }) => {
    const id = idParam(params.id);
    requireEvent(id);
    const existing = new Set(all('SELECT name FROM checklist_items WHERE event_id = ?', [id]).map((x) => x.name.toLowerCase()));
    let order = scalar('SELECT COALESCE(MAX(sort_order),0) FROM checklist_items WHERE event_id = ?', [id]) || 0;
    let added = 0;
    tx(() => {
      for (const item of DEFAULT_CHECKLIST) {
        if (existing.has(item.name.toLowerCase())) continue;
        insert('checklist_items', { event_id: id, name: item.name, category: item.category, included: null, needs_verification: item.verify ? 1 : 0, sort_order: ++order });
        added++;
      }
    });
    return { added, items: listChecklist(id) };
  });
  r.put('/api/checklist/:cid', ({ params, body }) => {
    const cid = idParam(params.cid);
    if (!get('SELECT id FROM checklist_items WHERE id = ?', [cid])) throw notFound('Checklist item');
    const data = validate(body, checklistSchema, { partial: true });
    // "done" only makes sense for included items
    update('checklist_items', cid, data, { touch: false });
    return get('SELECT * FROM checklist_items WHERE id = ?', [cid]);
  });
  r.delete('/api/checklist/:cid', ({ params, user }) => {
    const cid = idParam(params.cid);
    if (!run('DELETE FROM checklist_items WHERE id = ?', [cid]).changes) throw notFound('Checklist item');
    audit(user.id, 'DELETE', 'checklist_item', cid);
  });

  // ---------- Decoration plan ----------
  r.get('/api/events/:id/decor', ({ params }) => {
    const id = idParam(params.id);
    requireEvent(id);
    let d = get('SELECT * FROM event_decor WHERE event_id = ?', [id]);
    if (!d) { run('INSERT INTO event_decor (event_id) VALUES (?)', [id]); d = get('SELECT * FROM event_decor WHERE event_id = ?', [id]); }
    return d;
  });
  r.put('/api/events/:id/decor', ({ params, body }) => {
    const id = idParam(params.id);
    requireEvent(id);
    const data = validate(body, decorSchema, { partial: true });
    run('INSERT INTO event_decor (event_id) VALUES (?) ON CONFLICT(event_id) DO NOTHING', [id]);
    const keys = Object.keys(data);
    if (keys.length) run(`UPDATE event_decor SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = CURRENT_TIMESTAMP WHERE event_id = ?`, [...keys.map((k) => data[k]), id]);
    return get('SELECT * FROM event_decor WHERE event_id = ?', [id]);
  });

  // ---------- Materials ----------
  const MATERIAL_SELECT = `SELECT m.*, v.name AS vendor_name, ci.name AS checklist_item_name, i.name AS inventory_name,
      i.total_stock AS inventory_total_stock
    FROM event_materials m LEFT JOIN vendors v ON v.id = m.vendor_id
    LEFT JOIN checklist_items ci ON ci.id = m.checklist_item_id LEFT JOIN inventory_items i ON i.id = m.inventory_item_id`;

  function checkMaterialRefs(eventId, d) {
    if (d.checklist_item_id && !get('SELECT id FROM checklist_items WHERE id = ? AND event_id = ?', [d.checklist_item_id, eventId])) throw new HttpError(400, 'Checklist item does not belong to this event', { checklist_item_id: 'Invalid item' });
    if (d.inventory_item_id && !get('SELECT id FROM inventory_items WHERE id = ?', [d.inventory_item_id])) throw new HttpError(400, 'Stock item does not exist', { inventory_item_id: 'Invalid stock item' });
    if (d.vendor_id && !get('SELECT id FROM vendors WHERE id = ?', [d.vendor_id])) throw new HttpError(400, 'Vendor does not exist', { vendor_id: 'Invalid vendor' });
  }

  r.get('/api/events/:id/materials', ({ params }) => {
    const id = idParam(params.id);
    requireEvent(id);
    return all(`${MATERIAL_SELECT} WHERE m.event_id = ? ORDER BY ci.sort_order, m.id`, [id]);
  });
  r.post('/api/events/:id/materials', ({ params, body, user }) => {
    const id = idParam(params.id);
    requireEvent(id);
    const data = validate(body, materialSchema);
    checkMaterialRefs(id, data);
    data.total_cost = materialTotal(data);
    const mid = insert('event_materials', { ...data, event_id: id });
    audit(user.id, 'CREATE', 'material', mid);
    return get(`${MATERIAL_SELECT} WHERE m.id = ?`, [mid]);
  });
  r.put('/api/materials/:mid', ({ params, body, user }) => {
    const mid = idParam(params.mid);
    const existing = get('SELECT * FROM event_materials WHERE id = ?', [mid]);
    if (!existing) throw notFound('Material');
    const data = validate(body, materialSchema, { partial: true });
    checkMaterialRefs(existing.event_id, data);
    data.total_cost = materialTotal({ ...existing, ...data });
    update('event_materials', mid, data, { touch: false });
    audit(user.id, 'UPDATE', 'material', mid);
    return get(`${MATERIAL_SELECT} WHERE m.id = ?`, [mid]);
  });
  r.delete('/api/materials/:mid', ({ params, user }) => {
    const mid = idParam(params.mid);
    if (!run('DELETE FROM event_materials WHERE id = ?', [mid]).changes) throw notFound('Material');
    audit(user.id, 'DELETE', 'material', mid);
  });

  // ---------- Documents & images ----------
  const ALLOWED = /^(image\/(png|jpe?g|gif|webp)|application\/pdf|application\/msword|application\/vnd\.openxmlformats-officedocument\.(wordprocessingml\.document|spreadsheetml\.sheet)|application\/vnd\.ms-excel|text\/plain)$/;

  r.get('/api/events/:id/documents', ({ params }) => {
    const id = idParam(params.id);
    requireEvent(id);
    return all('SELECT d.*, u.name AS uploaded_by_name FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by WHERE d.event_id = ? ORDER BY d.id DESC', [id]);
  });
  r.post('/api/events/:id/documents', ({ params, body, user }) => {
    const id = idParam(params.id);
    requireEvent(id);
    const data = validate(body, {
      file_name: { type: 'string', required: true, max: 255 },
      mime_type: { type: 'string', required: true, max: 120 },
      data_base64: { type: 'string', required: true },
      caption: { type: 'string', max: 500 },
    });
    if (!ALLOWED.test(data.mime_type)) throw new HttpError(400, 'Only images, PDF, Word, Excel and text files are allowed');
    const buf = Buffer.from(data.data_base64.replace(/^data:[^,]+,/, ''), 'base64');
    if (!buf.length) throw new HttpError(400, 'File is empty');
    if (buf.length > config.maxUploadBytes) throw new HttpError(413, 'File is larger than 10 MB');
    const ext = path.extname(data.file_name).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 10);
    const stored = `${crypto.randomUUID()}${ext}`;
    fs.writeFileSync(path.join(config.uploadDir, stored), buf);
    const did = insert('documents', { event_id: id, file_name: path.basename(data.file_name), stored_name: stored, mime_type: data.mime_type, size: buf.length, caption: data.caption, uploaded_by: user.id });
    return get('SELECT * FROM documents WHERE id = ?', [did]);
  });
  r.put('/api/documents/:did', ({ params, body }) => {
    const did = idParam(params.did);
    const data = validate(body, { caption: { type: 'string', max: 500 } }, { partial: true });
    if (!update('documents', did, data, { touch: false })) throw notFound('Document');
    return get('SELECT * FROM documents WHERE id = ?', [did]);
  });
  r.delete('/api/documents/:did', ({ params, user }) => {
    const did = idParam(params.did);
    const doc = get('SELECT * FROM documents WHERE id = ?', [did]);
    if (!doc) throw notFound('Document');
    run('DELETE FROM documents WHERE id = ?', [did]);
    fs.rmSync(path.join(config.uploadDir, doc.stored_name), { force: true });
    audit(user.id, 'DELETE', 'document', did, { file_name: doc.file_name });
  });
  r.get('/api/documents/:did/file', (ctx) => {
    const doc = get('SELECT * FROM documents WHERE id = ?', [idParam(ctx.params.did)]);
    if (!doc) throw notFound('Document');
    const file = path.join(config.uploadDir, doc.stored_name);
    if (!fs.existsSync(file)) throw notFound('File');
    const disposition = ctx.query.download === '1' ? 'attachment' : 'inline';
    ctx.res.writeHead(200, {
      'Content-Type': doc.mime_type,
      'Content-Length': doc.size,
      'Content-Disposition': `${disposition}; filename="${encodeURIComponent(doc.file_name)}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=3600',
    });
    fs.createReadStream(file).pipe(ctx.res);
    ctx.handled = true;
  }, { allowQueryToken: true });
}

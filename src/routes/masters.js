import { all, get, insert, update, run, scalar, audit } from '../db.js';
import { HttpError, validate, idParam, notFound, round2 } from '../http.js';
import { EVENT_SELECT, withMoney, VENDOR_SELECT, withVendorMoney, EXPENSE_SELECT, withExpenseStatus } from '../finance.js';
import { EXPENSE_CATEGORIES, UNITS, DEFAULT_CHECKLIST } from '../defaults.js';
import { pRun } from '../platform.js';

const ADMIN = { roles: ['ADMIN'] };

export const clientSchema = {
  name: { type: 'string', required: true, max: 150 },
  mobile: { type: 'mobile', required: true },
  email: { type: 'email' },
  address: { type: 'string', max: 500 },
  notes: { type: 'string', max: 2000 },
};

const vendorSchema = {
  name: { type: 'string', required: true, max: 150 },
  contact: { type: 'mobile' },
  address: { type: 'string', max: 500 },
  service_category: { type: 'string', max: 100 },
  notes: { type: 'string', max: 2000 },
};

const inventorySchema = {
  name: { type: 'string', required: true, max: 150 },
  category: { type: 'string', max: 100 },
  unit: { type: 'string', required: true, max: 30, default: 'Piece' },
  total_stock: { type: 'number', min: 0, default: 0 },
  purchase_price: { type: 'number', min: 0, default: 0 },
  rental_price: { type: 'number', min: 0, default: 0 },
  ownership: { type: 'enum', values: ['PURCHASED', 'RENTAL'], default: 'PURCHASED' },
  vendor_id: { type: 'int' },
  notes: { type: 'string', max: 2000 },
};

// Stock is "used" while it is allocated to an upcoming or running event.
const INVENTORY_SELECT = `
  SELECT i.*, v.name AS vendor_name,
    (SELECT COALESCE(SUM(m.quantity),0) FROM event_materials m JOIN events e ON e.id = m.event_id
       WHERE m.inventory_item_id = i.id AND e.deleted_at IS NULL AND e.status IN ('UPCOMING','IN_PROGRESS')) AS used_stock,
    (SELECT COUNT(DISTINCT m.event_id) FROM event_materials m JOIN events e ON e.id = m.event_id
       WHERE m.inventory_item_id = i.id AND e.deleted_at IS NULL) AS event_count
  FROM inventory_items i LEFT JOIN vendors v ON v.id = i.vendor_id`;
const withStock = (i) => ({ ...i, used_stock: round2(i.used_stock), remaining_stock: round2(i.total_stock - i.used_stock) });

const SETTINGS_KEYS = ['business_name', 'business_address', 'business_phone', 'business_email', 'gstin', 'receipt_footer', 'booking_notify_email'];

export function getSettings() {
  const s = Object.fromEntries(SETTINGS_KEYS.map((k) => [k, '']));
  for (const row of all('SELECT key, value FROM settings')) if (SETTINGS_KEYS.includes(row.key)) s[row.key] = row.value ?? '';
  if (!s.business_name) s.business_name = 'BookMyUtsav';
  return s;
}

function checkVendor(id) {
  if (id && !get('SELECT id FROM vendors WHERE id = ?', [id])) throw new HttpError(400, 'Selected vendor does not exist', { vendor_id: 'Invalid vendor' });
}

export function register(r) {
  // ---------- Lookups used by forms ----------
  r.get('/api/lookups', () => ({
    event_types: all('SELECT * FROM event_types ORDER BY name'),
    vendors: all('SELECT id, name, service_category, contact FROM vendors ORDER BY name'),
    expense_categories: EXPENSE_CATEGORIES,
    units: UNITS,
    checklist_categories: [...new Set([...DEFAULT_CHECKLIST.map((c) => c.category), ...all('SELECT DISTINCT category FROM checklist_items WHERE category IS NOT NULL').map((r) => r.category)])].sort(),
    material_categories: [...new Set([...EXPENSE_CATEGORIES, ...all('SELECT DISTINCT category FROM inventory_items WHERE category IS NOT NULL').map((r) => r.category)])].sort(),
    payment_modes: ['CASH', 'UPI', 'BANK_TRANSFER', 'CHEQUE'],
  }));

  // ---------- Settings ----------
  r.get('/api/settings', () => getSettings());
  r.put('/api/settings', ({ body, user, company }) => {
    const data = validate(body, Object.fromEntries(SETTINGS_KEYS.map((k) => [k, { type: 'string', max: 1000 }])), { partial: true });
    for (const [k, v] of Object.entries(data)) run('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', [k, v]);
    // The company name shown in the menu and to the Super Admin follows the business name.
    if (data.business_name && company) pRun('UPDATE companies SET company_name = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?', [data.business_name, company.id]);
    audit(user.id, 'UPDATE', 'settings', null);
    return getSettings();
  }, ADMIN);

  // ---------- Clients ----------
  r.get('/api/clients', ({ query }) => {
    const where = [];
    const p = [];
    if (query.q) { where.push('(c.name LIKE ? OR c.mobile LIKE ? OR c.email LIKE ?)'); p.push(`%${query.q}%`, `%${query.q}%`, `%${query.q}%`); }
    return all(`
      SELECT c.*,
        (SELECT COUNT(*) FROM events e WHERE e.client_id = c.id AND e.deleted_at IS NULL) AS event_count,
        (SELECT COALESCE(SUM(e.booking_amount),0) FROM events e WHERE e.client_id = c.id AND e.deleted_at IS NULL AND e.status <> 'CANCELLED') AS total_booking,
        (SELECT COALESCE(SUM(cp.amount),0) FROM client_payments cp JOIN events e ON e.id = cp.event_id WHERE e.client_id = c.id AND e.deleted_at IS NULL) AS total_received
      FROM clients c ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY c.name`, p)
      .map((c) => ({ ...c, pending: round2(c.total_booking - c.total_received) }));
  });

  r.get('/api/clients/:id', ({ params }) => {
    const id = idParam(params.id);
    const client = get('SELECT * FROM clients WHERE id = ?', [id]);
    if (!client) throw notFound('Client');
    client.events = all(`${EVENT_SELECT} WHERE e.client_id = ? AND e.deleted_at IS NULL ORDER BY e.event_date DESC`, [id]).map(withMoney);
    return client;
  });

  r.post('/api/clients', ({ body, user }) => {
    const data = validate(body, clientSchema);
    const id = insert('clients', data);
    audit(user.id, 'CREATE', 'client', id);
    return get('SELECT * FROM clients WHERE id = ?', [id]);
  });

  r.put('/api/clients/:id', ({ params, body, user }) => {
    const id = idParam(params.id);
    if (!get('SELECT id FROM clients WHERE id = ?', [id])) throw notFound('Client');
    update('clients', id, validate(body, clientSchema, { partial: true }));
    audit(user.id, 'UPDATE', 'client', id);
    return get('SELECT * FROM clients WHERE id = ?', [id]);
  });

  r.delete('/api/clients/:id', ({ params, user }) => {
    const id = idParam(params.id);
    if (scalar('SELECT COUNT(*) FROM events WHERE client_id = ?', [id]) > 0) throw new HttpError(409, 'This client has events. Delete or move those events first.');
    if (!run('DELETE FROM clients WHERE id = ?', [id]).changes) throw notFound('Client');
    audit(user.id, 'DELETE', 'client', id);
  }, ADMIN);

  // ---------- Event types ----------
  r.get('/api/event-types', () => all('SELECT t.*, (SELECT COUNT(*) FROM events e WHERE e.event_type_id = t.id AND e.deleted_at IS NULL) AS event_count FROM event_types t ORDER BY name'));
  const typeSchema = { name: { type: 'string', required: true, max: 60 }, color: { type: 'color', required: true } };
  r.post('/api/event-types', ({ body }) => {
    const data = validate(body, typeSchema);
    if (get('SELECT id FROM event_types WHERE name = ?', [data.name])) throw new HttpError(409, 'This event type already exists', { name: 'Already exists' });
    return get('SELECT * FROM event_types WHERE id = ?', [insert('event_types', data)]);
  }, ADMIN);
  r.put('/api/event-types/:id', ({ params, body }) => {
    const id = idParam(params.id);
    const data = validate(body, typeSchema, { partial: true });
    if (data.name && get('SELECT id FROM event_types WHERE name = ? AND id <> ?', [data.name, id])) throw new HttpError(409, 'This event type already exists', { name: 'Already exists' });
    if (!update('event_types', id, data, { touch: false })) throw notFound('Event type');
    return get('SELECT * FROM event_types WHERE id = ?', [id]);
  }, ADMIN);
  r.delete('/api/event-types/:id', ({ params }) => {
    const id = idParam(params.id);
    if (scalar('SELECT COUNT(*) FROM events WHERE event_type_id = ? AND deleted_at IS NULL', [id]) > 0) throw new HttpError(409, 'This type is used by events. Change those events first.');
    run('UPDATE events SET event_type_id = NULL WHERE event_type_id = ?', [id]);
    if (!run('DELETE FROM event_types WHERE id = ?', [id]).changes) throw notFound('Event type');
  }, ADMIN);

  // ---------- Vendors ----------
  r.get('/api/vendors', ({ query }) => {
    const where = [];
    const p = [];
    if (query.q) { where.push('(v.name LIKE ? OR v.contact LIKE ? OR v.service_category LIKE ?)'); p.push(`%${query.q}%`, `%${query.q}%`, `%${query.q}%`); }
    if (query.category) { where.push('v.service_category = ?'); p.push(query.category); }
    let rows = all(`${VENDOR_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY v.name`, p).map(withVendorMoney);
    if (query.pending === '1') rows = rows.filter((v) => v.remaining > 0);
    return rows;
  });

  r.get('/api/vendors/:id', ({ params }) => {
    const id = idParam(params.id);
    const vendor = get(`${VENDOR_SELECT} WHERE v.id = ?`, [id]);
    if (!vendor) throw notFound('Vendor');
    return {
      ...withVendorMoney(vendor),
      expenses: all(`${EXPENSE_SELECT} WHERE x.vendor_id = ? AND e.deleted_at IS NULL ORDER BY x.expense_date DESC`, [id]).map(withExpenseStatus),
      payments: all(`SELECT vp.*, e.name AS event_name, x.description AS expense_description FROM vendor_payments vp
                     LEFT JOIN events e ON e.id = vp.event_id LEFT JOIN expenses x ON x.id = vp.expense_id
                     WHERE vp.vendor_id = ? ORDER BY vp.payment_date DESC, vp.id DESC`, [id]),
      events: all(`SELECT e.id, e.name, e.event_date, ROUND(SUM(x.total_amount),2) AS billed FROM expenses x JOIN events e ON e.id = x.event_id
                   WHERE x.vendor_id = ? AND e.deleted_at IS NULL GROUP BY e.id ORDER BY e.event_date DESC`, [id]),
    };
  });

  r.post('/api/vendors', ({ body, user }) => {
    const id = insert('vendors', validate(body, vendorSchema));
    audit(user.id, 'CREATE', 'vendor', id);
    return withVendorMoney(get(`${VENDOR_SELECT} WHERE v.id = ?`, [id]));
  });

  r.put('/api/vendors/:id', ({ params, body, user }) => {
    const id = idParam(params.id);
    if (!get('SELECT id FROM vendors WHERE id = ?', [id])) throw notFound('Vendor');
    update('vendors', id, validate(body, vendorSchema, { partial: true }));
    audit(user.id, 'UPDATE', 'vendor', id);
    return withVendorMoney(get(`${VENDOR_SELECT} WHERE v.id = ?`, [id]));
  });

  r.delete('/api/vendors/:id', ({ params, user }) => {
    const id = idParam(params.id);
    const used = scalar('SELECT (SELECT COUNT(*) FROM expenses WHERE vendor_id = ?) + (SELECT COUNT(*) FROM vendor_payments WHERE vendor_id = ?)', [id, id]);
    if (used > 0) throw new HttpError(409, 'This vendor has expenses or payments. They cannot be deleted without losing history.');
    run('UPDATE event_materials SET vendor_id = NULL WHERE vendor_id = ?', [id]);
    run('UPDATE inventory_items SET vendor_id = NULL WHERE vendor_id = ?', [id]);
    if (!run('DELETE FROM vendors WHERE id = ?', [id]).changes) throw notFound('Vendor');
    audit(user.id, 'DELETE', 'vendor', id);
  }, ADMIN);

  // ---------- Inventory / stock ----------
  r.get('/api/inventory', ({ query }) => {
    const where = [];
    const p = [];
    if (query.q) { where.push('(i.name LIKE ? OR i.category LIKE ?)'); p.push(`%${query.q}%`, `%${query.q}%`); }
    if (query.ownership) { where.push('i.ownership = ?'); p.push(query.ownership); }
    if (query.category) { where.push('i.category = ?'); p.push(query.category); }
    return all(`${INVENTORY_SELECT} ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY i.category, i.name`, p).map(withStock);
  });

  r.get('/api/inventory/:id', ({ params }) => {
    const id = idParam(params.id);
    const item = get(`${INVENTORY_SELECT} WHERE i.id = ?`, [id]);
    if (!item) throw notFound('Inventory item');
    return {
      ...withStock(item),
      allocations: all(`SELECT m.*, e.name AS event_name, e.event_date, e.status AS event_status FROM event_materials m
                        JOIN events e ON e.id = m.event_id WHERE m.inventory_item_id = ? AND e.deleted_at IS NULL ORDER BY e.event_date DESC`, [id]),
    };
  });

  r.post('/api/inventory', ({ body, user }) => {
    const data = validate(body, inventorySchema);
    checkVendor(data.vendor_id);
    const id = insert('inventory_items', data);
    audit(user.id, 'CREATE', 'inventory', id);
    return withStock(get(`${INVENTORY_SELECT} WHERE i.id = ?`, [id]));
  });

  r.put('/api/inventory/:id', ({ params, body, user }) => {
    const id = idParam(params.id);
    if (!get('SELECT id FROM inventory_items WHERE id = ?', [id])) throw notFound('Inventory item');
    const data = validate(body, inventorySchema, { partial: true });
    checkVendor(data.vendor_id);
    update('inventory_items', id, data);
    audit(user.id, 'UPDATE', 'inventory', id);
    return withStock(get(`${INVENTORY_SELECT} WHERE i.id = ?`, [id]));
  });

  r.delete('/api/inventory/:id', ({ params, user }) => {
    const id = idParam(params.id);
    // Event materials keep their own copy of name/price, so history survives.
    run('UPDATE event_materials SET inventory_item_id = NULL WHERE inventory_item_id = ?', [id]);
    if (!run('DELETE FROM inventory_items WHERE id = ?', [id]).changes) throw notFound('Inventory item');
    audit(user.id, 'DELETE', 'inventory', id);
  }, ADMIN);
}

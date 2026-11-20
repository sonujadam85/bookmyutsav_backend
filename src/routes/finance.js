import { all, get, insert, update, run, scalar, tx, audit } from '../db.js';
import { HttpError, validate, idParam, notFound, round2 } from '../http.js';
import { EXPENSE_SELECT, withExpenseStatus, EVENT_SELECT, withMoney } from '../finance.js';
import { EXPENSE_CATEGORIES } from '../defaults.js';
import { requireEvent } from './events.js';
import { getSettings } from './masters.js';

const ADMIN = { roles: ['ADMIN'] };
const MODES = ['CASH', 'UPI', 'BANK_TRANSFER', 'CHEQUE'];
const INSTALLMENTS = ['ADVANCE', 'SECOND', 'THIRD', 'FINAL', 'OTHER'];

const paymentSchema = {
  payment_date: { type: 'date', required: true },
  amount: { type: 'number', required: true, min: 0.01 },
  mode: { type: 'enum', values: MODES, required: true },
  installment: { type: 'enum', values: INSTALLMENTS, default: 'OTHER' },
  transaction_id: { type: 'string', max: 100 },
  notes: { type: 'string', max: 1000 },
};

const expenseSchema = {
  expense_date: { type: 'date', required: true },
  category: { type: 'enum', values: EXPENSE_CATEGORIES, required: true },
  description: { type: 'string', max: 1000 },
  vendor_id: { type: 'int' },
  quantity: { type: 'number', min: 0, default: 1 },
  unit_price: { type: 'number', min: 0, default: 0 },
  payment_status: { type: 'enum', values: ['PAID', 'PARTIAL', 'UNPAID'], default: 'UNPAID' },
  amount_paid: { type: 'number', min: 0 },
  payment_method: { type: 'string', max: 40 },
};

const vendorPaymentSchema = {
  event_id: { type: 'int' },
  expense_id: { type: 'int' },
  payment_date: { type: 'date', required: true },
  amount: { type: 'number', required: true, min: 0.01 },
  mode: { type: 'enum', values: MODES, required: true },
  transaction_id: { type: 'string', max: 100 },
  notes: { type: 'string', max: 1000 },
};

const PAYMENT_SELECT = `SELECT cp.*, e.name AS event_name, e.event_date, e.booking_amount, c.name AS client_name, c.mobile AS client_mobile, u.name AS received_by_name
  FROM client_payments cp JOIN events e ON e.id = cp.event_id JOIN clients c ON c.id = e.client_id LEFT JOIN users u ON u.id = cp.received_by`;

export function createClientPayment(eventId, body, user) {
  const data = validate(body, paymentSchema);
  const id = insert('client_payments', { ...data, event_id: eventId, received_by: user.id });
  run('UPDATE client_payments SET receipt_no = ? WHERE id = ?', [`RCPT-${data.payment_date.slice(0, 4)}-${String(id).padStart(5, '0')}`, id]);
  audit(user.id, 'CREATE', 'client_payment', id, { amount: data.amount });
  return id;
}

export function paymentSummary(eventId) {
  const ev = withMoney(get(`${EVENT_SELECT} WHERE e.id = ?`, [eventId]));
  const by = Object.fromEntries(INSTALLMENTS.map((k) => [k, 0]));
  for (const row of all('SELECT installment, SUM(amount) AS s FROM client_payments WHERE event_id = ? GROUP BY installment', [eventId])) by[row.installment] = round2(row.s);
  return {
    booking_amount: round2(ev.booking_amount),
    advance_received: by.ADVANCE,
    second_installment: by.SECOND,
    third_installment: by.THIRD,
    final_payment: by.FINAL,
    other_payments: by.OTHER,
    total_received: ev.total_received, // Sum of all payments
    remaining_balance: ev.remaining_balance, // Booking - Total received
  };
}

/** Works out paid_direct from the chosen status so the derived status always matches what the user picked. */
function resolvePaid(data, total, linked) {
  if (data.payment_status === 'PAID') return round2(Math.max(total - linked, 0));
  if (data.payment_status === 'UNPAID') return 0;
  const paid = Number(data.amount_paid ?? 0);
  if (!(paid > 0)) throw new HttpError(400, 'Enter the amount already paid', { amount_paid: 'Required for partial payment' });
  if (paid >= total) throw new HttpError(400, 'Partial payment must be less than the total amount', { amount_paid: 'Must be less than total' });
  return round2(Math.max(paid - linked, 0));
}

export function register(r) {
  // ---------- Client payments ----------
  r.get('/api/payments', ({ query }) => {
    const where = ['e.deleted_at IS NULL'];
    const p = [];
    if (query.eventId) { where.push('cp.event_id = ?'); p.push(Number(query.eventId)); }
    if (query.from) { where.push('cp.payment_date >= ?'); p.push(query.from); }
    if (query.to) { where.push('cp.payment_date <= ?'); p.push(query.to); }
    if (query.mode) { where.push('cp.mode = ?'); p.push(query.mode); }
    if (query.q) { where.push('(c.name LIKE ? OR e.name LIKE ? OR cp.receipt_no LIKE ? OR cp.transaction_id LIKE ?)'); p.push(...Array(4).fill(`%${query.q}%`)); }
    return all(`${PAYMENT_SELECT} WHERE ${where.join(' AND ')} ORDER BY cp.payment_date DESC, cp.id DESC`, p);
  });

  r.get('/api/events/:id/payments', ({ params }) => {
    const id = idParam(params.id);
    requireEvent(id);
    return { summary: paymentSummary(id), payments: all(`${PAYMENT_SELECT} WHERE cp.event_id = ? ORDER BY cp.payment_date, cp.id`, [id]) };
  });

  r.post('/api/events/:id/payments', ({ params, body, user }) => {
    const id = idParam(params.id);
    requireEvent(id);
    const pid = tx(() => createClientPayment(id, body, user));
    return { payment: get(`${PAYMENT_SELECT} WHERE cp.id = ?`, [pid]), summary: paymentSummary(id) };
  });

  r.put('/api/payments/:pid', ({ params, body, user }) => {
    const pid = idParam(params.pid);
    const existing = get('SELECT * FROM client_payments WHERE id = ?', [pid]);
    if (!existing) throw notFound('Payment');
    const data = validate(body, paymentSchema, { partial: true });
    update('client_payments', pid, data, { touch: false });
    audit(user.id, 'UPDATE', 'client_payment', pid, { before: existing, changes: data });
    return { payment: get(`${PAYMENT_SELECT} WHERE cp.id = ?`, [pid]), summary: paymentSummary(existing.event_id) };
  }, ADMIN);

  r.delete('/api/payments/:pid', ({ params, user }) => {
    const pid = idParam(params.pid);
    const existing = get('SELECT * FROM client_payments WHERE id = ?', [pid]);
    if (!existing) throw notFound('Payment');
    run('DELETE FROM client_payments WHERE id = ?', [pid]);
    audit(user.id, 'DELETE', 'client_payment', pid, existing);
    return { summary: paymentSummary(existing.event_id) };
  }, ADMIN);

  r.get('/api/payments/:pid/receipt', ({ params }) => {
    const pid = idParam(params.pid);
    const payment = get(`${PAYMENT_SELECT} WHERE cp.id = ?`, [pid]);
    if (!payment) throw notFound('Payment');
    const ev = get('SELECT e.*, c.name AS client_name, c.mobile AS client_mobile, c.address AS client_address, c.email AS client_email FROM events e JOIN clients c ON c.id = e.client_id WHERE e.id = ?', [payment.event_id]);
    // Totals as of this receipt (payments on or before this one).
    const receivedToDate = Number(scalar(`SELECT COALESCE(SUM(amount),0) FROM client_payments WHERE event_id = ? AND (payment_date < ? OR (payment_date = ? AND id <= ?))`,
      [payment.event_id, payment.payment_date, payment.payment_date, pid]));
    return {
      business: getSettings(),
      payment,
      event: ev,
      booking_amount: round2(ev.booking_amount),
      received_to_date: round2(receivedToDate),
      balance_after: round2(ev.booking_amount - receivedToDate),
    };
  });

  // ---------- Expenses ----------
  r.get('/api/expenses', ({ query }) => {
    const where = ['e.deleted_at IS NULL'];
    const p = [];
    if (query.eventId) { where.push('x.event_id = ?'); p.push(Number(query.eventId)); }
    if (query.vendorId) { where.push('x.vendor_id = ?'); p.push(Number(query.vendorId)); }
    if (query.category) { where.push('x.category = ?'); p.push(query.category); }
    if (query.from) { where.push('x.expense_date >= ?'); p.push(query.from); }
    if (query.to) { where.push('x.expense_date <= ?'); p.push(query.to); }
    if (query.q) { where.push('(x.description LIKE ? OR v.name LIKE ? OR e.name LIKE ?)'); p.push(...Array(3).fill(`%${query.q}%`)); }
    let rows = all(`${EXPENSE_SELECT} WHERE ${where.join(' AND ')} ORDER BY x.expense_date DESC, x.id DESC`, p).map(withExpenseStatus);
    if (query.status) rows = rows.filter((x) => x.payment_status === query.status);
    return rows;
  });

  r.get('/api/events/:id/expenses', ({ params }) => {
    const id = idParam(params.id);
    requireEvent(id);
    const items = all(`${EXPENSE_SELECT} WHERE x.event_id = ? ORDER BY x.expense_date, x.id`, [id]).map(withExpenseStatus);
    const total = round2(items.reduce((s, x) => s + x.total_amount, 0));
    const paid = round2(items.reduce((s, x) => s + x.amount_paid, 0));
    const byCategory = {};
    for (const x of items) byCategory[x.category] = round2((byCategory[x.category] || 0) + x.total_amount);
    return { items, summary: { total, paid, unpaid: round2(total - paid), by_category: byCategory } };
  });

  r.post('/api/events/:id/expenses', ({ params, body, user }) => {
    const id = idParam(params.id);
    requireEvent(id);
    const data = validate(body, expenseSchema);
    if (data.vendor_id && !get('SELECT id FROM vendors WHERE id = ?', [data.vendor_id])) throw new HttpError(400, 'Vendor does not exist', { vendor_id: 'Invalid vendor' });
    const total = round2(data.quantity * data.unit_price); // Total = Quantity x Unit Price
    const paid_direct = resolvePaid(data, total, 0);
    const { payment_status, amount_paid, ...row } = data;
    const xid = insert('expenses', { ...row, event_id: id, total_amount: total, paid_direct, created_by: user.id });
    audit(user.id, 'CREATE', 'expense', xid);
    return withExpenseStatus(get(`${EXPENSE_SELECT} WHERE x.id = ?`, [xid]));
  });

  r.put('/api/expenses/:xid', ({ params, body, user }) => {
    const xid = idParam(params.xid);
    const existing = get('SELECT * FROM expenses WHERE id = ?', [xid]);
    if (!existing) throw notFound('Expense');
    const data = validate(body, expenseSchema, { partial: true });
    if (data.vendor_id && !get('SELECT id FROM vendors WHERE id = ?', [data.vendor_id])) throw new HttpError(400, 'Vendor does not exist', { vendor_id: 'Invalid vendor' });
    const linked = Number(scalar('SELECT COALESCE(SUM(amount),0) FROM vendor_payments WHERE expense_id = ?', [xid]));
    if (linked > 0 && 'vendor_id' in data && data.vendor_id !== existing.vendor_id) throw new HttpError(409, 'Vendor payments are linked to this expense, so its vendor cannot be changed');
    const merged = { ...existing, ...data };
    const total = round2(merged.quantity * merged.unit_price);
    const { payment_status, amount_paid, ...row } = data;
    if (payment_status) row.paid_direct = resolvePaid(data, total, linked);
    else row.paid_direct = Math.min(existing.paid_direct, total);
    row.total_amount = total;
    update('expenses', xid, row);
    audit(user.id, 'UPDATE', 'expense', xid, { before: existing, changes: data });
    return withExpenseStatus(get(`${EXPENSE_SELECT} WHERE x.id = ?`, [xid]));
  });

  r.delete('/api/expenses/:xid', ({ params, user }) => {
    const xid = idParam(params.xid);
    const existing = get('SELECT * FROM expenses WHERE id = ?', [xid]);
    if (!existing) throw notFound('Expense');
    if (scalar('SELECT COUNT(*) FROM vendor_payments WHERE expense_id = ?', [xid]) > 0) throw new HttpError(409, 'Vendor payments are linked to this expense. Delete those payments first.');
    run('DELETE FROM expenses WHERE id = ?', [xid]);
    audit(user.id, 'DELETE', 'expense', xid, existing);
  }, ADMIN);

  // ---------- Vendor payments ----------
  r.get('/api/vendor-payments', ({ query }) => {
    const where = ['1 = 1'];
    const p = [];
    if (query.vendorId) { where.push('vp.vendor_id = ?'); p.push(Number(query.vendorId)); }
    if (query.eventId) { where.push('vp.event_id = ?'); p.push(Number(query.eventId)); }
    if (query.from) { where.push('vp.payment_date >= ?'); p.push(query.from); }
    if (query.to) { where.push('vp.payment_date <= ?'); p.push(query.to); }
    return all(`SELECT vp.*, v.name AS vendor_name, e.name AS event_name, x.description AS expense_description FROM vendor_payments vp
      JOIN vendors v ON v.id = vp.vendor_id LEFT JOIN events e ON e.id = vp.event_id LEFT JOIN expenses x ON x.id = vp.expense_id
      WHERE ${where.join(' AND ')} ORDER BY vp.payment_date DESC, vp.id DESC`, p);
  });

  r.post('/api/vendors/:id/payments', ({ params, body, user }) => {
    const vendorId = idParam(params.id);
    if (!get('SELECT id FROM vendors WHERE id = ?', [vendorId])) throw notFound('Vendor');
    const data = validate(body, vendorPaymentSchema);
    if (data.expense_id) {
      const x = withExpenseStatus(get(`${EXPENSE_SELECT} WHERE x.id = ?`, [data.expense_id]) || {});
      if (!x.id || x.vendor_id !== vendorId) throw new HttpError(400, 'The selected bill does not belong to this vendor', { expense_id: 'Invalid bill' });
      if (data.amount > x.balance + 0.001) throw new HttpError(400, `Amount is more than the bill balance (${x.balance})`, { amount: 'More than balance' });
      data.event_id = x.event_id;
    }
    if (data.event_id && !get('SELECT id FROM events WHERE id = ?', [data.event_id])) throw new HttpError(400, 'Event does not exist', { event_id: 'Invalid event' });
    const id = insert('vendor_payments', { ...data, vendor_id: vendorId, created_by: user.id });
    audit(user.id, 'CREATE', 'vendor_payment', id, { amount: data.amount });
    return get('SELECT * FROM vendor_payments WHERE id = ?', [id]);
  });

  r.delete('/api/vendor-payments/:id', ({ params, user }) => {
    const id = idParam(params.id);
    const existing = get('SELECT * FROM vendor_payments WHERE id = ?', [id]);
    if (!existing) throw notFound('Vendor payment');
    run('DELETE FROM vendor_payments WHERE id = ?', [id]);
    audit(user.id, 'DELETE', 'vendor_payment', id, existing);
  }, ADMIN);

  // Vendors involved in one event with their event-level balances.
  r.get('/api/events/:id/vendors', ({ params }) => {
    const id = idParam(params.id);
    requireEvent(id);
    const vendors = all(`SELECT v.id, v.name, v.contact, v.service_category,
        COALESCE((SELECT SUM(x.total_amount) FROM expenses x WHERE x.event_id = ? AND x.vendor_id = v.id),0) AS billed,
        COALESCE((SELECT SUM(x.paid_direct) FROM expenses x WHERE x.event_id = ? AND x.vendor_id = v.id),0)
          + COALESCE((SELECT SUM(vp.amount) FROM vendor_payments vp WHERE vp.event_id = ? AND vp.vendor_id = v.id),0) AS paid,
        (SELECT COUNT(*) FROM event_materials m WHERE m.event_id = ? AND m.vendor_id = v.id) AS material_count
      FROM vendors v
      WHERE v.id IN (SELECT vendor_id FROM expenses WHERE event_id = ? AND vendor_id IS NOT NULL
                     UNION SELECT vendor_id FROM event_materials WHERE event_id = ? AND vendor_id IS NOT NULL
                     UNION SELECT vendor_id FROM vendor_payments WHERE event_id = ?)
      ORDER BY v.name`, [id, id, id, id, id, id, id]).map((v) => ({ ...v, billed: round2(v.billed), paid: round2(v.paid), pending: round2(v.billed - v.paid) }));
    const payments = all(`SELECT vp.*, v.name AS vendor_name, x.description AS expense_description FROM vendor_payments vp JOIN vendors v ON v.id = vp.vendor_id
      LEFT JOIN expenses x ON x.id = vp.expense_id WHERE vp.event_id = ? ORDER BY vp.payment_date DESC`, [id]);
    return { vendors, payments };
  });
}

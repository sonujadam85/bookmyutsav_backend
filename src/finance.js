// All money calculations live here so every screen and report uses the same formulas.
import { all, get } from './db.js';
import { round2 } from './http.js';

export const SQL_RECEIVED = `(SELECT COALESCE(SUM(cp.amount),0) FROM client_payments cp WHERE cp.event_id = e.id)`;
export const SQL_EXPENSES = `(SELECT COALESCE(SUM(x.total_amount),0) FROM expenses x WHERE x.event_id = e.id)`;

export const EVENT_SELECT = `
  SELECT e.*, c.name AS client_name, c.mobile AS client_mobile,
         t.name AS type_name, t.color AS type_color,
         ${SQL_RECEIVED} AS total_received,
         ${SQL_EXPENSES} AS total_expenses,
         (SELECT COALESCE(SUM(cp.amount),0) FROM client_payments cp WHERE cp.event_id = e.id AND cp.installment = 'ADVANCE') AS advance_received
  FROM events e
  JOIN clients c ON c.id = e.client_id
  LEFT JOIN event_types t ON t.id = e.event_type_id`;

/** Adds derived money fields to an event row. */
export function withMoney(ev) {
  if (!ev) return ev;
  const booking = Number(ev.booking_amount || 0);
  const received = Number(ev.total_received || 0);
  const expenses = Number(ev.total_expenses || 0);
  const profit = booking - expenses;
  return {
    ...ev,
    total_received: round2(received),
    total_expenses: round2(expenses),
    remaining_balance: round2(booking - received), // Remaining = Booking - Total Received
    net_profit: round2(profit), // Net Profit = Revenue - Expenses
    profit_percentage: booking > 0 ? round2((profit / booking) * 100) : 0,
  };
}

/** Expense row with derived paid amount and status. */
export const EXPENSE_SELECT = `
  SELECT x.*, v.name AS vendor_name, e.name AS event_name, e.event_date,
         x.paid_direct + (SELECT COALESCE(SUM(vp.amount),0) FROM vendor_payments vp WHERE vp.expense_id = x.id) AS amount_paid
  FROM expenses x
  JOIN events e ON e.id = x.event_id
  LEFT JOIN vendors v ON v.id = x.vendor_id`;

export function withExpenseStatus(x) {
  const paid = round2(x.amount_paid || 0);
  const total = round2(x.total_amount || 0);
  const status = total <= 0 || paid >= total ? 'PAID' : paid > 0 ? 'PARTIAL' : 'UNPAID';
  return { ...x, amount_paid: paid, balance: round2(Math.max(total - paid, 0)), payment_status: status };
}

/** Vendor totals: billed (expenses), paid (direct + payment history), remaining. */
export const VENDOR_SELECT = `
  SELECT v.*,
    (SELECT COALESCE(SUM(x.total_amount),0) FROM expenses x JOIN events e ON e.id = x.event_id
       WHERE x.vendor_id = v.id AND e.deleted_at IS NULL) AS total_amount,
    (SELECT COALESCE(SUM(x.paid_direct),0) FROM expenses x JOIN events e ON e.id = x.event_id
       WHERE x.vendor_id = v.id AND e.deleted_at IS NULL)
      + (SELECT COALESCE(SUM(vp.amount),0) FROM vendor_payments vp WHERE vp.vendor_id = v.id) AS amount_paid
  FROM vendors v`;

export function withVendorMoney(v) {
  return { ...v, total_amount: round2(v.total_amount), amount_paid: round2(v.amount_paid), remaining: round2(v.total_amount - v.amount_paid) };
}

/** Full profit & loss for one event. */
export function eventPnl(eventId) {
  const ev = withMoney(get(`${EVENT_SELECT} WHERE e.id = ?`, [eventId]));
  if (!ev) return null;
  const byCategory = all(
    `SELECT category, ROUND(SUM(total_amount),2) AS amount, COUNT(*) AS count FROM expenses WHERE event_id = ? GROUP BY category ORDER BY amount DESC`,
    [eventId]
  );
  const vendorBilled = Number(get(`SELECT COALESCE(SUM(total_amount),0) s FROM expenses WHERE event_id = ? AND vendor_id IS NOT NULL`, [eventId]).s);
  const vendorDirect = Number(get(`SELECT COALESCE(SUM(paid_direct),0) s FROM expenses WHERE event_id = ? AND vendor_id IS NOT NULL`, [eventId]).s);
  const vendorPaid = Number(get(`SELECT COALESCE(SUM(amount),0) s FROM vendor_payments WHERE event_id = ?`, [eventId]).s);
  const materialCost = Number(get(`SELECT COALESCE(SUM(total_cost),0) s FROM event_materials WHERE event_id = ?`, [eventId]).s);
  const unpaidExpenses = all(`${EXPENSE_SELECT} WHERE x.event_id = ?`, [eventId]).map(withExpenseStatus).reduce((s, x) => s + x.balance, 0);
  return {
    event_id: ev.id,
    total_revenue: round2(ev.booking_amount),
    total_expenses: ev.total_expenses,
    net_profit: ev.net_profit,
    profit_percentage: ev.profit_percentage,
    total_received: ev.total_received,
    client_pending: ev.remaining_balance,
    vendor_billed: round2(vendorBilled),
    vendor_paid: round2(vendorDirect + vendorPaid),
    vendor_pending: round2(Math.max(vendorBilled - vendorDirect - vendorPaid, 0)),
    unpaid_expenses: round2(unpaidExpenses),
    planned_material_cost: round2(materialCost),
    cash_position: round2(ev.total_received - (ev.total_expenses - unpaidExpenses)),
    expenses_by_category: byCategory,
  };
}

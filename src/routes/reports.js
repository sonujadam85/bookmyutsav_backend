import { all, get } from '../db.js';
import { HttpError, round2, localToday, toISODate } from '../http.js';
import { EVENT_SELECT, withMoney, EXPENSE_SELECT, withExpenseStatus, VENDOR_SELECT, withVendorMoney } from '../finance.js';

const ADMIN = { roles: ['ADMIN'] };
const sum = (rows, k) => round2(rows.reduce((s, r) => s + Number(r[k] || 0), 0));

function monthRange(d = new Date()) {
  const start = new Date(d.getFullYear(), d.getMonth(), 1);
  const end = new Date(d.getFullYear(), d.getMonth() + 1, 0);
  return [toISODate(start), toISODate(end)];
}

function lastMonths(n) {
  const out = [];
  const now = new Date();
  for (let i = n - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
  }
  return out;
}

export function register(r) {
  r.get('/api/dashboard', ({ user }) => {
    const today = localToday();
    const [mStart, mEnd] = monthRange();
    const events = all(`${EVENT_SELECT} WHERE e.deleted_at IS NULL`).map(withMoney);
    const active = events.filter((e) => e.status !== 'CANCELLED');
    const upcoming = events
      .filter((e) => e.event_date >= today && (e.status === 'UPCOMING' || e.status === 'IN_PROGRESS'))
      .sort((a, b) => (a.event_date + (a.start_time || '')).localeCompare(b.event_date + (b.start_time || '')));

    const todaysFunctions = all(`SELECT f.*, e.name AS event_name, c.name AS client_name, COALESCE(f.venue, e.venue) AS venue_name
      FROM event_functions f JOIN events e ON e.id = f.event_id JOIN clients c ON c.id = e.client_id
      WHERE f.function_date = ? AND e.deleted_at IS NULL AND f.status <> 'CANCELLED' ORDER BY f.start_time`, [today]);

    const months = lastMonths(12);
    const revenueRows = all(`SELECT substr(cp.payment_date,1,7) AS m, SUM(cp.amount) AS s FROM client_payments cp JOIN events e ON e.id = cp.event_id
      WHERE e.deleted_at IS NULL AND cp.payment_date >= ? GROUP BY m`, [`${months[0]}-01`]);
    const bookingRows = all(`SELECT substr(event_date,1,7) AS m, SUM(booking_amount) AS s FROM events
      WHERE deleted_at IS NULL AND status <> 'CANCELLED' AND event_date >= ? GROUP BY m`, [`${months[0]}-01`]);
    const expenseRows = all(`SELECT substr(x.expense_date,1,7) AS m, SUM(x.total_amount) AS s FROM expenses x JOIN events e ON e.id = x.event_id
      WHERE e.deleted_at IS NULL AND x.expense_date >= ? GROUP BY m`, [`${months[0]}-01`]);
    const toSeries = (rows) => months.map((m) => round2(rows.find((r) => r.m === m)?.s || 0));

    const totalBooking = sum(active, 'booking_amount');
    const totalReceived = sum(events, 'total_received');
    const totalExpenses = sum(events, 'total_expenses');
    const stats = {
      total_events: events.length,
      upcoming_events: upcoming.length,
      events_this_month: events.filter((e) => e.event_date >= mStart && e.event_date <= mEnd && e.status !== 'CANCELLED').length,
      completed_events: events.filter((e) => e.status === 'COMPLETED').length,
      total_booking_amount: totalBooking,
      total_advance_received: totalReceived,
      total_pending_payments: round2(active.reduce((s, e) => s + Math.max(e.remaining_balance, 0), 0)),
      total_event_expenses: totalExpenses,
      total_profit: round2(totalBooking - sum(active, 'total_expenses')),
    };
    const vendorPending = all(VENDOR_SELECT).map(withVendorMoney).reduce((s, v) => s + Math.max(v.remaining, 0), 0);

    return {
      today,
      stats: user.role === 'ADMIN' ? stats : { ...stats, total_profit: null },
      vendor_pending: round2(vendorPending),
      upcoming_events: upcoming.slice(0, 8),
      todays_events: events.filter((e) => e.event_date === today && e.status !== 'CANCELLED'),
      todays_functions: todaysFunctions,
      recent_payments: all(`SELECT cp.*, e.name AS event_name, c.name AS client_name FROM client_payments cp JOIN events e ON e.id = cp.event_id
        JOIN clients c ON c.id = e.client_id WHERE e.deleted_at IS NULL ORDER BY cp.payment_date DESC, cp.id DESC LIMIT 8`),
      pending_payments: active.filter((e) => e.remaining_balance > 0).sort((a, b) => a.event_date.localeCompare(b.event_date)).slice(0, 8),
      charts: { months, revenue: toSeries(revenueRows), bookings: toSeries(bookingRows), expenses: toSeries(expenseRows) },
    };
  });

  // Calendar entries: main event dates plus every function date.
  r.get('/api/calendar', ({ query }) => {
    if (!query.from || !query.to) throw new HttpError(400, 'from and to are required');
    const ew = ['e.deleted_at IS NULL', 'e.event_date BETWEEN ? AND ?'];
    const fw = ['e.deleted_at IS NULL', 'f.function_date BETWEEN ? AND ?'];
    const ep = [query.from, query.to];
    const fp = [query.from, query.to];
    if (query.typeId) { ew.push('e.event_type_id = ?'); fw.push('e.event_type_id = ?'); ep.push(Number(query.typeId)); fp.push(Number(query.typeId)); }
    if (query.status) { ew.push('e.status = ?'); fw.push('f.status = ?'); ep.push(query.status); fp.push(query.status); }
    const events = all(`SELECT 'event' AS kind, e.id AS event_id, NULL AS function_id, e.name AS title, e.name AS event_name, e.event_date AS date,
        e.start_time, e.end_time, e.venue, e.status, e.is_tentative, c.name AS client_name, c.mobile AS client_mobile,
        t.name AS type_name, COALESCE(t.color, '#6b7280') AS color
      FROM events e JOIN clients c ON c.id = e.client_id LEFT JOIN event_types t ON t.id = e.event_type_id WHERE ${ew.join(' AND ')}`, ep);
    const functions = all(`SELECT 'function' AS kind, e.id AS event_id, f.id AS function_id, f.name AS title, e.name AS event_name, f.function_date AS date,
        f.start_time, f.end_time, COALESCE(f.venue, e.venue) AS venue, f.status, e.is_tentative, c.name AS client_name, c.mobile AS client_mobile,
        t.name AS type_name, COALESCE(t.color, '#6b7280') AS color
      FROM event_functions f JOIN events e ON e.id = f.event_id JOIN clients c ON c.id = e.client_id LEFT JOIN event_types t ON t.id = e.event_type_id
      WHERE ${fw.join(' AND ')}`, fp);
    return [...events, ...functions].sort((a, b) => (a.date + (a.start_time || '')).localeCompare(b.date + (b.start_time || '')));
  });

  // Generic report endpoint -> { title, columns, rows, totals }
  r.get('/api/reports/:kind', ({ params, query }) => {
    const from = query.from || '0000-01-01';
    const to = query.to || '9999-12-31';
    const kind = params.kind;
    const C = (key, label, type = 'text') => ({ key, label, type });

    if (kind === 'events') {
      const p = [from, to];
      let extra = '';
      if (query.status) { extra += ' AND e.status = ?'; p.push(query.status); }
      if (query.typeId) { extra += ' AND e.event_type_id = ?'; p.push(Number(query.typeId)); }
      const rows = all(`${EVENT_SELECT} WHERE e.deleted_at IS NULL AND e.event_date BETWEEN ? AND ? ${extra} ORDER BY e.event_date, e.start_time`, p).map(withMoney);
      return {
        title: 'Events Report',
        columns: [C('event_date', 'Date', 'date'), C('start_time', 'Start'), C('name', 'Event'), C('client_name', 'Client'), C('client_mobile', 'Mobile'), C('type_name', 'Type'),
          C('venue', 'Venue'), C('guests', 'Guests', 'number'), C('status', 'Status', 'status'), C('booking_amount', 'Booking', 'money'), C('total_received', 'Received', 'money'), C('remaining_balance', 'Balance', 'money')],
        rows,
        totals: { booking_amount: sum(rows, 'booking_amount'), total_received: sum(rows, 'total_received'), remaining_balance: sum(rows, 'remaining_balance') },
      };
    }

    if (kind === 'client-payments') {
      const p = [from, to];
      let extra = '';
      if (query.mode) { extra += ' AND cp.mode = ?'; p.push(query.mode); }
      const rows = all(`SELECT cp.*, e.name AS event_name, c.name AS client_name, c.mobile AS client_mobile FROM client_payments cp JOIN events e ON e.id = cp.event_id
        JOIN clients c ON c.id = e.client_id WHERE e.deleted_at IS NULL AND cp.payment_date BETWEEN ? AND ? ${extra} ORDER BY cp.payment_date, cp.id`, p);
      return {
        title: 'Client Payment Report',
        columns: [C('payment_date', 'Date', 'date'), C('receipt_no', 'Receipt'), C('client_name', 'Client'), C('event_name', 'Event'), C('installment', 'Installment', 'status'),
          C('mode', 'Mode', 'status'), C('transaction_id', 'Txn ID'), C('amount', 'Amount', 'money')],
        rows,
        totals: { amount: sum(rows, 'amount') },
      };
    }

    if (kind === 'pending-payments') {
      const rows = all(`${EVENT_SELECT} WHERE e.deleted_at IS NULL AND e.status <> 'CANCELLED' AND e.event_date BETWEEN ? AND ? ORDER BY e.event_date`, [from, to])
        .map(withMoney).filter((e) => e.remaining_balance > 0);
      return {
        title: 'Pending Payment Report',
        columns: [C('event_date', 'Date', 'date'), C('name', 'Event'), C('client_name', 'Client'), C('client_mobile', 'Mobile'), C('status', 'Status', 'status'),
          C('booking_amount', 'Booking', 'money'), C('total_received', 'Received', 'money'), C('remaining_balance', 'Pending', 'money')],
        rows,
        totals: { booking_amount: sum(rows, 'booking_amount'), total_received: sum(rows, 'total_received'), remaining_balance: sum(rows, 'remaining_balance') },
      };
    }

    if (kind === 'expenses') {
      const p = [from, to];
      let extra = '';
      if (query.category) { extra += ' AND x.category = ?'; p.push(query.category); }
      if (query.vendorId) { extra += ' AND x.vendor_id = ?'; p.push(Number(query.vendorId)); }
      const rows = all(`${EXPENSE_SELECT} WHERE e.deleted_at IS NULL AND x.expense_date BETWEEN ? AND ? ${extra} ORDER BY x.expense_date, x.id`, p).map(withExpenseStatus);
      return {
        title: 'Expense Report',
        columns: [C('expense_date', 'Date', 'date'), C('event_name', 'Event'), C('category', 'Category'), C('description', 'Description'), C('vendor_name', 'Vendor'),
          C('quantity', 'Qty', 'number'), C('unit_price', 'Unit Price', 'money'), C('total_amount', 'Total', 'money'), C('amount_paid', 'Paid', 'money'), C('payment_status', 'Status', 'status')],
        rows,
        totals: { total_amount: sum(rows, 'total_amount'), amount_paid: sum(rows, 'amount_paid') },
      };
    }

    if (kind === 'vendor-payments') {
      const rows = all(VENDOR_SELECT + ' ORDER BY v.name').map(withVendorMoney).filter((v) => v.total_amount > 0 || v.amount_paid > 0);
      const payments = all(`SELECT vp.*, v.name AS vendor_name, e.name AS event_name FROM vendor_payments vp JOIN vendors v ON v.id = vp.vendor_id
        LEFT JOIN events e ON e.id = vp.event_id WHERE vp.payment_date BETWEEN ? AND ? ORDER BY vp.payment_date`, [from, to]);
      return {
        title: 'Vendor Payment Report',
        columns: [C('name', 'Vendor'), C('service_category', 'Service'), C('contact', 'Contact'), C('total_amount', 'Total Billed', 'money'), C('amount_paid', 'Paid', 'money'), C('remaining', 'Pending', 'money')],
        rows,
        totals: { total_amount: sum(rows, 'total_amount'), amount_paid: sum(rows, 'amount_paid'), remaining: sum(rows, 'remaining') },
        secondary: {
          title: 'Vendor payments in period',
          columns: [C('payment_date', 'Date', 'date'), C('vendor_name', 'Vendor'), C('event_name', 'Event'), C('mode', 'Mode', 'status'), C('transaction_id', 'Txn ID'), C('amount', 'Amount', 'money')],
          rows: payments,
          totals: { amount: sum(payments, 'amount') },
        },
      };
    }

    if (kind === 'profit-loss') {
      const rows = all(`${EVENT_SELECT} WHERE e.deleted_at IS NULL AND e.status <> 'CANCELLED' AND e.event_date BETWEEN ? AND ? ORDER BY e.event_date`, [from, to]).map(withMoney);
      const revenue = sum(rows, 'booking_amount');
      const exp = sum(rows, 'total_expenses');
      return {
        title: 'Profit & Loss Report',
        columns: [C('event_date', 'Date', 'date'), C('name', 'Event'), C('client_name', 'Client'), C('booking_amount', 'Revenue', 'money'), C('total_expenses', 'Expenses', 'money'),
          C('net_profit', 'Net Profit', 'money'), C('profit_percentage', 'Profit %', 'percent'), C('remaining_balance', 'Client Pending', 'money')],
        rows,
        totals: { booking_amount: revenue, total_expenses: exp, net_profit: round2(revenue - exp), profit_percentage: revenue ? round2(((revenue - exp) / revenue) * 100) : 0, remaining_balance: sum(rows, 'remaining_balance') },
      };
    }

    throw new HttpError(404, 'Unknown report');
  }, ADMIN);
}

import { all, get, insert, update, run, scalar, audit } from '../db.js';
import { hashPassword, signToken, verifyPassword } from '../auth.js';
import { HttpError, validate, idParam, notFound } from '../http.js';
import { getAccount, getCompany, pInsert, pRun, withCompany } from '../platform.js';

// Login users are managed only in the main company; other companies have one login (the owner).
const ADMIN = { roles: ['ADMIN'], mainOnly: true };
const companyInfo = (c) => c && { id: c.id, name: c.company_name, slug: c.slug, is_main: !!c.is_main };
const publicUser = (u) => u && { id: u.id, name: u.name, email: u.email, role: u.role, active: u.active, created_at: u.created_at };

const userSchema = {
  name: { type: 'string', required: true, max: 120 },
  email: { type: 'email', required: true },
  role: { type: 'enum', values: ['ADMIN', 'STAFF'], required: true },
  active: { type: 'bool', default: 1 },
};

// Basic brute-force protection: 10 failed attempts per email per 15 minutes.
const failures = new Map();

export function register(r) {
  r.post('/api/auth/login', async ({ body }) => {
    const { email, password } = validate(body, { email: { type: 'email', required: true }, password: { type: 'string', required: true } });
    const f = failures.get(email);
    if (f && f.count >= 10 && Date.now() - f.first < 15 * 60 * 1000) throw new HttpError(429, 'Too many attempts. Try again in a few minutes.');
    const fail = () => {
      const cur = f && Date.now() - f.first < 15 * 60 * 1000 ? f : { count: 0, first: Date.now() };
      cur.count++;
      failures.set(email, cur);
      return new HttpError(401, 'Invalid email or password');
    };
    const acc = getAccount(email);
    const company = acc && getCompany(acc.company_id);
    if (!company) throw fail();

    // Not approved yet: check the password given at sign-up, then explain the status.
    if (company.status === 'PENDING' || company.status === 'REJECTED') {
      if (!company.owner_password_hash || !verifyPassword(password, company.owner_password_hash)) throw fail();
      failures.delete(email);
      if (company.status === 'PENDING') throw new HttpError(403, 'Your sign-up is waiting for approval. You can log in once the administrator approves it.');
      throw new HttpError(403, `Your sign-up was not approved.${company.status_note ? ` Reason: ${company.status_note}` : ''}`);
    }

    return withCompany(company, () => {
      const user = get('SELECT * FROM users WHERE email = ?', [email]);
      if (!user || !verifyPassword(password, user.password_hash)) throw fail();
      if (company.status === 'SUSPENDED') throw new HttpError(403, `Your company account is suspended.${company.status_note ? ` Reason: ${company.status_note}` : ''} Contact the administrator.`);
      if (!user.active) throw new HttpError(403, 'Your account is disabled. Contact the administrator.');
      failures.delete(email);
      return {
        token: signToken({ sub: user.id, cid: company.id, role: user.role, name: user.name }),
        user: { ...publicUser(user), is_super: !!acc.is_super, company: companyInfo(company) },
      };
    });
  }, { public: true });

  r.get('/api/auth/me', ({ user, company }) => ({
    ...publicUser(get('SELECT * FROM users WHERE id = ?', [user.id])), is_super: user.is_super, company: companyInfo(company),
  }));

  r.put('/api/auth/password', ({ user, body }) => {
    const { current_password, new_password } = validate(body, {
      current_password: { type: 'string', required: true },
      new_password: { type: 'string', required: true, max: 200 },
    });
    if (new_password.length < 8) throw new HttpError(400, 'New password must be at least 8 characters', { new_password: 'Minimum 8 characters' });
    const u = get('SELECT * FROM users WHERE id = ?', [user.id]);
    if (!verifyPassword(current_password, u.password_hash)) throw new HttpError(400, 'Current password is incorrect', { current_password: 'Incorrect password' });
    update('users', user.id, { password_hash: hashPassword(new_password) });
    return { ok: true };
  });

  // ---- Users (admin only) ----
  r.get('/api/users', () => all('SELECT * FROM users ORDER BY name').map(publicUser), ADMIN);

  r.post('/api/users', ({ body, user, company }) => {
    const data = validate(body, { ...userSchema, password: { type: 'string', required: true } });
    if (data.password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters', { password: 'Minimum 8 characters' });
    if (get('SELECT id FROM users WHERE email = ?', [data.email]) || getAccount(data.email)) throw new HttpError(409, 'A user with this email already exists', { email: 'Already in use' });
    const { password, ...rest } = data;
    const id = insert('users', { ...rest, password_hash: hashPassword(password) });
    pInsert('accounts', { email: data.email, company_id: company.id, is_super: 0 });
    audit(user.id, 'CREATE', 'user', id);
    return publicUser(get('SELECT * FROM users WHERE id = ?', [id]));
  }, ADMIN);

  r.put('/api/users/:id', ({ params, body, user }) => {
    const id = idParam(params.id);
    const existing = get('SELECT * FROM users WHERE id = ?', [id]);
    if (!existing) throw notFound('User');
    const data = validate(body, { ...userSchema, password: { type: 'string' } }, { partial: true });
    if (data.email && data.email.toLowerCase() !== existing.email.toLowerCase()
      && (get('SELECT id FROM users WHERE email = ? AND id <> ?', [data.email, id]) || getAccount(data.email))) throw new HttpError(409, 'Email already in use', { email: 'Already in use' });
    if (id === user.id && (data.role === 'STAFF' || data.active === 0)) throw new HttpError(400, 'You cannot demote or disable your own account');
    if (existing.role === 'ADMIN' && (data.role === 'STAFF' || data.active === 0)) {
      if (scalar("SELECT COUNT(*) FROM users WHERE role = 'ADMIN' AND active = 1 AND id <> ?", [id]) === 0) throw new HttpError(400, 'At least one active admin is required');
    }
    const { password, ...rest } = data;
    if (password) {
      if (password.length < 8) throw new HttpError(400, 'Password must be at least 8 characters', { password: 'Minimum 8 characters' });
      rest.password_hash = hashPassword(password);
    }
    update('users', id, rest);
    if (data.email && data.email.toLowerCase() !== existing.email.toLowerCase()) pRun('UPDATE accounts SET email = ? WHERE email = ?', [data.email, existing.email]);
    audit(user.id, 'UPDATE', 'user', id);
    return publicUser(get('SELECT * FROM users WHERE id = ?', [id]));
  }, ADMIN);

  r.delete('/api/users/:id', ({ params, user }) => {
    const id = idParam(params.id);
    if (id === user.id) throw new HttpError(400, 'You cannot delete your own account');
    const u = get('SELECT * FROM users WHERE id = ?', [id]);
    if (!u) throw notFound('User');
    if (u.role === 'ADMIN' && scalar("SELECT COUNT(*) FROM users WHERE role = 'ADMIN' AND id <> ?", [id]) === 0) throw new HttpError(400, 'At least one admin is required');
    // Keep references in history tables valid by disabling instead of hard-deleting if the user has activity.
    const used = scalar('SELECT (SELECT COUNT(*) FROM events WHERE created_by = ?) + (SELECT COUNT(*) FROM client_payments WHERE received_by = ?) + (SELECT COUNT(*) FROM expenses WHERE created_by = ?)', [id, id, id]);
    if (used > 0) {
      update('users', id, { active: 0 });
      audit(user.id, 'DISABLE', 'user', id);
      return { disabled: true };
    }
    if (getAccount(u.email)?.is_super) throw new HttpError(400, 'The Super Admin login cannot be deleted');
    run('DELETE FROM users WHERE id = ?', [id]);
    pRun('DELETE FROM accounts WHERE email = ?', [u.email]);
    audit(user.id, 'DELETE', 'user', id);
  }, ADMIN);
}

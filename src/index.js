import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { config } from './config.js';
import { Router, HttpError } from './http.js';
import { verifyToken } from './auth.js';
import { get } from './db.js';
import { getAccount, getCompany, companyBySlug, mainCompany, withCompany } from './platform.js';
import * as companies from './routes/companies.js';
import * as authUsers from './routes/auth-users.js';
import * as masters from './routes/masters.js';
import * as events from './routes/events.js';
import * as finance from './routes/finance.js';
import * as reports from './routes/reports.js';
import * as services from './routes/services.js';

const router = new Router();
// Order matters: specific paths (e.g. /api/events/check-date) before /api/events/:id
companies.register(router);
reports.register(router);
authUsers.register(router);
masters.register(router);
events.register(router);
finance.register(router);
services.register(router);

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.txt': 'text/plain',
};

function send(res, status, data, headers = {}) {
  const body = data === undefined ? '' : JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > config.maxBodyBytes) { reject(new HttpError(413, 'Request is too large')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'Invalid JSON body')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, pathname) {
  if (!fs.existsSync(config.clientDist)) return false;
  let file = path.normalize(path.join(config.clientDist, pathname));
  if (!file.startsWith(config.clientDist)) return false;
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(config.clientDist, 'index.html'); // SPA fallback
  if (!fs.existsSync(file)) return false;
  const ext = path.extname(file);
  res.writeHead(200, {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable',
  });
  fs.createReadStream(file).pipe(res);
  return true;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  let pathname = url.pathname;

  res.setHeader('Access-Control-Allow-Origin', config.corsOrigin);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (!pathname.startsWith('/api/')) {
    if (req.method === 'GET' && serveStatic(req, res, pathname)) return;
    return send(res, 404, { message: 'Not found' });
  }

  try {
    // Company booking pages: /api/public/c/<slug>/... works like /api/public/... for that company.
    let slugCompany = null;
    const pm = pathname.match(/^\/api\/public\/c\/([^/]+)(\/.*)$/);
    if (pm) {
      slugCompany = companyBySlug(decodeURIComponent(pm[1]));
      if (!slugCompany || slugCompany.status !== 'APPROVED') throw new HttpError(404, 'This booking page does not exist');
      pathname = `/api/public${pm[2]}`;
    }

    const match = router.match(req.method, pathname);
    if (!match) throw new HttpError(404, 'API route not found');
    if (match.methodNotAllowed) throw new HttpError(405, 'Method not allowed');
    const { route, params } = match;
    const query = Object.fromEntries(url.searchParams.entries());

    // Which company this request works on: the logged-in user's company, or the booking page's company.
    let company = slugCompany || mainCompany();
    let payload = null;
    if (!route.opts.public) {
      const header = req.headers.authorization || '';
      const token = header.startsWith('Bearer ') ? header.slice(7) : route.opts.allowQueryToken ? query.token : null;
      payload = verifyToken(token);
      if (!payload) throw new HttpError(401, 'Your session has expired. Please log in again.');
      company = payload.cid ? getCompany(payload.cid) : mainCompany(); // tokens from before companies existed = main company
      if (!company) throw new HttpError(401, 'Account not available');
      if (company.status !== 'APPROVED') throw new HttpError(401, company.status === 'SUSPENDED' ? 'Your company account is suspended. Contact the administrator.' : 'Your company account is not active');
    }

    // Routes marked raw (video upload) read the request stream themselves.
    const body = !route.opts.raw && ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};
    const done = await withCompany(company, async () => {
      let user = null;
      if (payload) {
        user = get('SELECT id, name, email, role, active FROM users WHERE id = ?', [payload.sub]);
        if (!user || !user.active) throw new HttpError(401, 'Account not available');
        const acc = getAccount(user.email);
        if (!acc || acc.company_id !== company.id) throw new HttpError(401, 'Account not available');
        user.is_super = !!acc.is_super;
        user.company_id = company.id;
        if (route.opts.roles && !route.opts.roles.includes(user.role)) throw new HttpError(403, 'You do not have permission for this action');
        if (route.opts.super && !user.is_super) throw new HttpError(403, 'Only the Super Admin can do this');
        if (route.opts.mainOnly && !company.is_main) throw new HttpError(403, 'You do not have permission for this action');
      }
      const ctx = { req, res, params, query, body, user, company, handled: false };
      const result = await route.handler(ctx);
      return { ctx, result };
    });
    if (done.ctx.handled) return;
    if (done.result === undefined) { res.writeHead(204); return res.end(); }
    send(res, req.method === 'POST' ? 201 : 200, done.result);
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { message: err.message, errors: err.errors });
    if (String(err?.message).includes('FOREIGN KEY')) return send(res, 409, { message: 'This record is linked to other data and cannot be changed this way.' });
    if (String(err?.message).includes('UNIQUE')) return send(res, 409, { message: 'A record with these details already exists.' });
    console.error(err);
    send(res, 500, { message: 'Something went wrong on the server' });
  }
});

server.listen(config.port, () => {
  console.log(`BookMyUtsav API running on http://localhost:${config.port}`);
  console.log(`Database: ${config.dbFile}`);
});

export default server;

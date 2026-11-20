// Services & Prices (Event Manager): price list with photos, and the services chosen for each event.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { all, get, insert, update, run, scalar, tx, audit, seedChecklist } from '../db.js';
import { HttpError, validate, idParam, notFound, round2, localToday } from '../http.js';
import { config } from '../config.js';
import { getSettings } from './masters.js';
import { EVENT_SELECT, withMoney } from '../finance.js';
import { mailConfig, sendMail } from '../mailer.js';
import { current } from '../context.js';

const ADMIN = { roles: ['ADMIN'] };
const IMAGE_TYPES = /^image\/(png|jpe?g|gif|webp)$/;
const EXT = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp' };

const serviceSchema = {
  name: { type: 'string', required: true, max: 150 },
  category: { type: 'string', max: 80 },
  price: { type: 'number', min: 0, default: 0 },
  sort_order: { type: 'int', min: 0 },
};
const photoSchema = {
  label: { type: 'string', max: 120 },
  price: { type: 'number', min: 0, default: 0 },
  sort_order: { type: 'int', min: 0 },
};
const imageSchema = {
  mime_type: { type: 'string', required: true, max: 60 },
  data_base64: { type: 'string', required: true },
};

const PHOTO_COLS = 'id, service_id, label, price, sort_order, mime_type, size, created_at';
const VIDEO_COLS = 'id, service_id, provider, video_id, url, label, mime_type, size, sort_order';
const VIDEO_TYPES = { 'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov', 'video/x-m4v': '.m4v', 'video/3gpp': '.3gp' };

/** Send a video file with Range support, so it can be played from the middle and on iPhones. */
function streamVideo(ctx, file, mime) {
  const { size } = fs.statSync(file);
  const m = String(ctx.req.headers.range || '').match(/^bytes=(\d*)-(\d*)$/);
  const head = { 'Content-Type': mime, 'Accept-Ranges': 'bytes', 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'private, max-age=3600' };
  if (m && (m[1] || m[2])) {
    let start = m[1] ? Number(m[1]) : size - Number(m[2]);
    let end = m[1] && m[2] ? Number(m[2]) : size - 1;
    start = Math.max(0, start); end = Math.min(end, size - 1);
    if (start > end) { ctx.res.writeHead(416, { 'Content-Range': `bytes */${size}` }); ctx.res.end(); ctx.handled = true; return; }
    ctx.res.writeHead(206, { ...head, 'Content-Range': `bytes ${start}-${end}/${size}`, 'Content-Length': end - start + 1 });
    fs.createReadStream(file, { start, end }).pipe(ctx.res);
  } else {
    ctx.res.writeHead(200, { ...head, 'Content-Length': size });
    fs.createReadStream(file).pipe(ctx.res);
  }
  ctx.handled = true;
}

/** Save the request body (a video) to the uploads folder, stopping at the size limit. */
function receiveVideo(req, target) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const out = fs.createWriteStream(target);
    const fail = (e) => { out.destroy(); fs.rmSync(target, { force: true }); reject(e); };
    req.on('data', (c) => {
      size += c.length;
      if (size > config.maxVideoBytes) { req.unpipe(out); req.resume(); fail(new HttpError(413, `Video is larger than ${Math.round(config.maxVideoBytes / 1048576)} MB. Upload it to YouTube and add the link instead.`)); }
    });
    req.on('error', fail);
    out.on('error', fail);
    out.on('finish', () => (size > config.maxVideoBytes ? null : size ? resolve(size) : fail(new HttpError(400, 'Video is empty'))));
    req.pipe(out);
  });
}

/** Read a YouTube or Instagram link. Returns { provider, video_id } or null. */
export function parseVideoUrl(raw) {
  let u;
  try { u = new URL(String(raw).trim().replace(/^(?!https?:\/\/)/i, 'https://')); } catch { return null; }
  const host = u.hostname.replace(/^(www\.|m\.|music\.)/, '').toLowerCase();
  const yt = /^[\w-]{11}$/;
  if (host === 'youtu.be') { const id = u.pathname.slice(1).split('/')[0]; return yt.test(id) ? { provider: 'youtube', video_id: id } : null; }
  if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
    const v = u.searchParams.get('v');
    if (v && yt.test(v)) return { provider: 'youtube', video_id: v };
    const m = u.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/);
    return m ? { provider: 'youtube', video_id: m[1] } : null;
  }
  if (host === 'instagram.com') {
    const m = u.pathname.match(/^\/(?:[\w.]+\/)?(p|reel|reels|tv)\/([\w-]{5,40})/);
    return m ? { provider: 'instagram', video_id: `${m[1] === 'reels' ? 'reel' : m[1]}/${m[2]}` } : null;
  }
  return null;
}

/** Service with its (not deleted) photos and a min/max price for display. */
function serviceRow(s, photos, videos) {
  const list = photos ?? all(`SELECT ${PHOTO_COLS} FROM service_photos WHERE service_id = ? AND deleted_at IS NULL ORDER BY sort_order, id`, [s.id]);
  const vids = videos ?? all(`SELECT ${VIDEO_COLS} FROM service_videos WHERE service_id = ? ORDER BY sort_order, id`, [s.id]);
  const prices = list.length ? list.map((p) => p.price) : [s.price];
  return { ...s, photos: list, videos: vids, min_price: Math.min(...prices), max_price: Math.max(...prices) };
}

function listServices() {
  const services = all('SELECT * FROM services WHERE active = 1 ORDER BY sort_order, id');
  const photos = all(`SELECT ${PHOTO_COLS} FROM service_photos WHERE deleted_at IS NULL ORDER BY sort_order, id`);
  const by = new Map();
  for (const p of photos) (by.get(p.service_id) ?? by.set(p.service_id, []).get(p.service_id)).push(p);
  const vby = new Map();
  for (const v of all(`SELECT ${VIDEO_COLS} FROM service_videos ORDER BY sort_order, id`)) (vby.get(v.service_id) ?? vby.set(v.service_id, []).get(v.service_id)).push(v);
  return services.map((s) => serviceRow(s, by.get(s.id) ?? [], vby.get(s.id) ?? []));
}

function requireService(id) {
  const s = get('SELECT * FROM services WHERE id = ? AND active = 1', [id]);
  if (!s) throw notFound('Service');
  return s;
}

function requireEvent(id) {
  const e = get('SELECT id, booking_amount FROM events WHERE id = ? AND deleted_at IS NULL', [id]);
  if (!e) throw notFound('Event');
  return e;
}

/** Decode a base64 image and write it to the uploads folder. Returns the stored file info. */
function saveImage(body) {
  const data = validate(body, imageSchema);
  const mime = data.mime_type.toLowerCase();
  if (!IMAGE_TYPES.test(mime)) throw new HttpError(400, 'Only JPG, PNG, WEBP or GIF images are allowed');
  const buf = Buffer.from(data.data_base64.replace(/^data:[^,]+,/, ''), 'base64');
  if (!buf.length) throw new HttpError(400, 'Image is empty');
  if (buf.length > config.maxUploadBytes) throw new HttpError(413, 'Image is larger than 10 MB');
  const stored = `svc-${crypto.randomUUID()}${EXT[mime] || '.jpg'}`;
  fs.writeFileSync(path.join(config.uploadDir, stored), buf);
  return { stored_name: stored, mime_type: mime, size: buf.length };
}

const removeFile = (name) => name && fs.rmSync(path.join(config.uploadDir, name), { force: true });
const photoInUse = (pid) => scalar('SELECT COUNT(*) FROM event_services WHERE photo_id = ?', [pid]) > 0;

/** Selected services, discount and totals for one event. */
export function eventServices(eventId) {
  const ev = requireEvent(eventId);
  const items = all(
    `SELECT es.*, p.id AS photo_exists FROM event_services es
       LEFT JOIN service_photos p ON p.id = es.photo_id
      WHERE es.event_id = ? ORDER BY es.sort_order, es.id`, [eventId]
  ).map(({ photo_exists, ...i }) => ({ ...i, photo_id: photo_exists ? i.photo_id : null }));
  const discount = Number(scalar('SELECT discount FROM event_service_totals WHERE event_id = ?', [eventId]) || 0);
  const subtotal = round2(items.reduce((a, i) => a + i.amount, 0));
  return { event_id: eventId, items, subtotal, discount, total: round2(Math.max(0, subtotal - discount)), booking_amount: ev.booking_amount };
}

export function register(r) {
  // ---------- Price list ----------
  r.get('/api/services', () => listServices());

  r.post('/api/services', ({ body, user }) => {
    const data = validate(body, serviceSchema);
    data.category ||= 'Other';
    // New service goes to the top of its heading; a new heading goes after the existing ones.
    if (data.sort_order == null) {
      const min = scalar('SELECT MIN(sort_order) FROM services WHERE active = 1 AND category = ?', [data.category]);
      data.sort_order = min != null ? Math.max(0, Number(min) - 1) : Number(scalar('SELECT COALESCE(MAX(sort_order),0) FROM services')) + 100;
    }
    const id = insert('services', data);
    audit(user.id, 'CREATE', 'service', id, { name: data.name });
    return serviceRow(get('SELECT * FROM services WHERE id = ?', [id]));
  }, ADMIN);

  r.get('/api/services/:id', ({ params }) => serviceRow(requireService(idParam(params.id))));

  r.put('/api/services/:id', ({ params, body, user }) => {
    const id = idParam(params.id);
    const before = requireService(id);
    const data = validate(body, serviceSchema, { partial: true });
    if ('category' in data && !data.category) data.category = 'Other';
    update('services', id, data);
    audit(user.id, 'UPDATE', 'service', id, { before, changes: data });
    return serviceRow(get('SELECT * FROM services WHERE id = ?', [id]));
  }, ADMIN);

  // Services used by an event are hidden from the list instead of deleted, so saved events keep their photos.
  r.delete('/api/services/:id', ({ params, user }) => {
    const id = idParam(params.id);
    const s = requireService(id);
    const used = scalar('SELECT COUNT(*) FROM event_services WHERE service_id = ?', [id]) > 0;
    tx(() => {
      if (used) {
        update('services', id, { active: 0 });
        // Photos not shown on any event can go now.
        for (const p of all('SELECT id, stored_name FROM service_photos WHERE service_id = ?', [id])) {
          if (!photoInUse(p.id)) { run('DELETE FROM service_photos WHERE id = ?', [p.id]); removeFile(p.stored_name); }
        }
      } else {
        const files = all('SELECT stored_name FROM service_photos WHERE service_id = ?', [id]);
        const vids = all("SELECT video_id FROM service_videos WHERE service_id = ? AND provider = 'file'", [id]);
        run('DELETE FROM services WHERE id = ?', [id]);
        files.forEach((f) => removeFile(f.stored_name));
        vids.forEach((v) => removeFile(path.basename(v.video_id)));
      }
      audit(user.id, used ? 'DEACTIVATE' : 'DELETE', 'service', id, { name: s.name });
    });
  }, ADMIN);

  // Rename a heading: moves every service under it.
  r.put('/api/service-categories', ({ body, user }) => {
    const { from, to } = validate(body, { from: { type: 'string', required: true, max: 80 }, to: { type: 'string', required: true, max: 80 } });
    const n = run('UPDATE services SET category = ?, updated_at = CURRENT_TIMESTAMP WHERE category = ? AND active = 1', [to, from]).changes;
    if (!n) throw notFound('Heading');
    audit(user.id, 'RENAME', 'service_category', null, { from, to, services: n });
    return listServices();
  }, ADMIN);

  // ---------- Video links (YouTube / Instagram) ----------
  r.post('/api/services/:id/videos', ({ params, body, user }) => {
    const id = idParam(params.id);
    requireService(id);
    const d = validate(body, { url: { type: 'string', required: true, max: 500 }, label: { type: 'string', max: 120 } });
    const v = parseVideoUrl(d.url);
    if (!v) throw new HttpError(400, 'Paste a YouTube or Instagram video link (for example https://youtu.be/... or https://www.instagram.com/reel/...)', { url: 'Not a YouTube or Instagram link' });
    if (scalar('SELECT COUNT(*) FROM service_videos WHERE service_id = ?', [id]) >= 20) throw new HttpError(400, 'A service can have up to 20 videos');
    const vid = insert('service_videos', {
      service_id: id, ...v, url: d.url.trim(), label: d.label,
      sort_order: Number(scalar('SELECT COALESCE(MAX(sort_order),0) FROM service_videos WHERE service_id = ?', [id])) + 1,
    });
    audit(user.id, 'CREATE', 'service_video', vid, { service_id: id, ...v });
    return serviceRow(get('SELECT * FROM services WHERE id = ?', [id]));
  }, ADMIN);

  // Upload a video file. Body = the raw file; ?label= optional. Content-Type must be a video type.
  r.post('/api/services/:id/videos/upload', async ({ req, params, query, user }) => {
    const id = idParam(params.id);
    requireService(id);
    const mime = String(req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
    if (!VIDEO_TYPES[mime]) { req.resume(); throw new HttpError(400, 'Only MP4, MOV, WEBM or 3GP videos can be uploaded'); }
    const len = Number(req.headers['content-length'] || 0);
    if (len > config.maxVideoBytes) { req.resume(); throw new HttpError(413, `Video is larger than ${Math.round(config.maxVideoBytes / 1048576)} MB. Upload it to YouTube and add the link instead.`); }
    if (scalar('SELECT COUNT(*) FROM service_videos WHERE service_id = ?', [id]) >= 20) { req.resume(); throw new HttpError(400, 'A service can have up to 20 videos'); }
    const stored = `svcvid-${crypto.randomUUID()}${VIDEO_TYPES[mime]}`;
    const size = await receiveVideo(req, path.join(config.uploadDir, stored));
    const name = String(query.name || 'video').slice(0, 150);
    const vid = insert('service_videos', {
      service_id: id, provider: 'file', video_id: stored, url: name, mime_type: mime, size,
      label: query.label ? String(query.label).slice(0, 120) : null,
      sort_order: Number(scalar('SELECT COALESCE(MAX(sort_order),0) FROM service_videos WHERE service_id = ?', [id])) + 1,
    });
    audit(user.id, 'CREATE', 'service_video', vid, { service_id: id, size });
    return serviceRow(get('SELECT * FROM services WHERE id = ?', [id]));
  }, { ...ADMIN, raw: true });

  r.get('/api/service-videos/:vid/file', (ctx) => {
    const v = get(`SELECT * FROM service_videos WHERE id = ? AND provider = 'file'`, [idParam(ctx.params.vid)]);
    const file = v && path.join(config.uploadDir, path.basename(v.video_id));
    if (!file || !fs.existsSync(file)) throw notFound('Video');
    streamVideo(ctx, file, v.mime_type);
  }, { allowQueryToken: true });

  r.put('/api/service-videos/:vid', ({ params, body, user }) => {
    const vid = idParam(params.vid);
    const v = get('SELECT * FROM service_videos WHERE id = ?', [vid]);
    if (!v) throw notFound('Video');
    const d = validate(body, { label: { type: 'string', max: 120 } }, { partial: true });
    update('service_videos', vid, d, { touch: false });
    audit(user.id, 'UPDATE', 'service_video', vid, { changes: d });
    return serviceRow(get('SELECT * FROM services WHERE id = ?', [v.service_id]));
  }, ADMIN);

  r.delete('/api/service-videos/:vid', ({ params, user }) => {
    const vid = idParam(params.vid);
    const v = get('SELECT * FROM service_videos WHERE id = ?', [vid]);
    if (!v) throw notFound('Video');
    run('DELETE FROM service_videos WHERE id = ?', [vid]);
    if (v.provider === 'file') removeFile(path.basename(v.video_id));
    audit(user.id, 'DELETE', 'service_video', vid, { service_id: v.service_id });
  }, ADMIN);

  // ---------- Photos ----------
  r.post('/api/services/:id/photos', ({ params, body, user }) => {
    const id = idParam(params.id);
    const s = requireService(id);
    const meta = validate(body, { ...photoSchema, price: { type: 'number', min: 0 } });
    const file = saveImage(body);
    const last = get('SELECT price FROM service_photos WHERE service_id = ? AND deleted_at IS NULL ORDER BY sort_order DESC, id DESC LIMIT 1', [id]);
    const pid = insert('service_photos', {
      service_id: id, ...file, label: meta.label,
      price: meta.price ?? last?.price ?? s.price, // same default as before: last photo's price, else service price
      sort_order: meta.sort_order ?? Number(scalar('SELECT COALESCE(MAX(sort_order),0) FROM service_photos WHERE service_id = ?', [id])) + 1,
    });
    audit(user.id, 'CREATE', 'service_photo', pid, { service_id: id });
    return serviceRow(get('SELECT * FROM services WHERE id = ?', [id]));
  }, ADMIN);

  r.put('/api/service-photos/:pid', ({ params, body, user }) => {
    const pid = idParam(params.pid);
    const p = get('SELECT * FROM service_photos WHERE id = ? AND deleted_at IS NULL', [pid]);
    if (!p) throw notFound('Photo');
    const data = validate(body, photoSchema, { partial: true });
    update('service_photos', pid, data, { touch: false });
    audit(user.id, 'UPDATE', 'service_photo', pid, { changes: data });
    return serviceRow(get('SELECT * FROM services WHERE id = ?', [p.service_id]));
  }, ADMIN);

  // Replace the image of a photo ("Ye photo badlo"). Label and price stay.
  r.post('/api/service-photos/:pid/image', ({ params, body, user }) => {
    const pid = idParam(params.pid);
    const p = get('SELECT * FROM service_photos WHERE id = ? AND deleted_at IS NULL', [pid]);
    if (!p) throw notFound('Photo');
    const file = saveImage(body);
    if (photoInUse(pid)) {
      // Keep the old picture on saved events: retire the old row and point the list at a new one.
      const newId = tx(() => {
        const nid = insert('service_photos', { service_id: p.service_id, ...file, label: p.label, price: p.price, sort_order: p.sort_order });
        update('service_photos', pid, { deleted_at: new Date().toISOString() }, { touch: false });
        return nid;
      });
      audit(user.id, 'REPLACE', 'service_photo', newId, { previous: pid });
    } else {
      update('service_photos', pid, file, { touch: false });
      removeFile(p.stored_name);
      audit(user.id, 'REPLACE', 'service_photo', pid);
    }
    return serviceRow(get('SELECT * FROM services WHERE id = ?', [p.service_id]));
  }, ADMIN);

  r.delete('/api/service-photos/:pid', ({ params, user }) => {
    const pid = idParam(params.pid);
    const p = get('SELECT * FROM service_photos WHERE id = ? AND deleted_at IS NULL', [pid]);
    if (!p) throw notFound('Photo');
    if (photoInUse(pid)) update('service_photos', pid, { deleted_at: new Date().toISOString() }, { touch: false });
    else { run('DELETE FROM service_photos WHERE id = ?', [pid]); removeFile(p.stored_name); }
    audit(user.id, 'DELETE', 'service_photo', pid, { service_id: p.service_id });
  }, ADMIN);

  // Image file; also serves retired photos so old event quotations still show them.
  r.get('/api/service-photos/:pid/file', (ctx) => {
    const p = get('SELECT * FROM service_photos WHERE id = ?', [idParam(ctx.params.pid)]);
    if (!p) throw notFound('Photo');
    const file = path.join(config.uploadDir, p.stored_name);
    if (!fs.existsSync(file)) throw notFound('File');
    ctx.res.writeHead(200, {
      'Content-Type': p.mime_type,
      'Content-Length': p.size,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, max-age=86400',
    });
    fs.createReadStream(file).pipe(ctx.res);
    ctx.handled = true;
  }, { allowQueryToken: true });

  // ---------- Services selected for an event ----------
  r.get('/api/events/:id/services', ({ params }) => eventServices(idParam(params.id)));

  /**
   * Replace the event's service list in one go.
   * body: { discount, items: [{ service_id, photo_id, name, variant_label, unit_price, quantity }], set_booking_amount }
   * set_booking_amount: true also copies the total into the event's booking amount.
   */
  r.put('/api/events/:id/services', ({ params, body, user }) => {
    const id = idParam(params.id);
    requireEvent(id);
    const { discount, set_booking_amount } = validate(body, {
      discount: { type: 'number', min: 0, default: 0 },
      set_booking_amount: { type: 'bool', default: 0 },
    });
    const raw = Array.isArray(body?.items) ? body.items : null;
    if (!raw) throw new HttpError(400, 'items must be a list');
    if (raw.length > 500) throw new HttpError(400, 'Too many services');

    const items = raw.map((it, n) => {
      let row;
      try {
        row = validate(it, {
          service_id: { type: 'int' },
          photo_id: { type: 'int' },
          name: { type: 'string', max: 150 },
          category: { type: 'string', max: 80 },
          variant_label: { type: 'string', max: 120 },
          unit_price: { type: 'number', min: 0, required: true },
          quantity: { type: 'number', min: 0.01, default: 1 },
        });
      } catch (e) {
        throw new HttpError(400, `Service ${n + 1}: ${Object.values(e.errors || {})[0] || e.message}`);
      }
      if (row.service_id) {
        const s = get('SELECT id, name, category FROM services WHERE id = ?', [row.service_id]);
        if (!s) throw new HttpError(400, `Service ${n + 1}: service does not exist`);
        row.name ||= s.name;
        row.category = s.category;
      }
      if (row.photo_id) {
        const p = get('SELECT id, service_id, label FROM service_photos WHERE id = ?', [row.photo_id]);
        if (!p || p.service_id !== row.service_id) throw new HttpError(400, `Service ${n + 1}: photo does not belong to this service`);
        if (row.variant_label == null) row.variant_label = p.label;
      }
      if (!row.name) throw new HttpError(400, `Service ${n + 1}: name is required`);
      row.category ||= 'Other';
      return { ...row, amount: round2(row.unit_price * row.quantity), sort_order: n + 1 };
    });

    const subtotal = round2(items.reduce((a, i) => a + i.amount, 0));
    if (discount > subtotal) throw new HttpError(400, 'Discount cannot be more than the subtotal', { discount: 'Too large' });

    tx(() => {
      run('DELETE FROM event_services WHERE event_id = ?', [id]);
      for (const i of items) insert('event_services', { event_id: id, ...i });
      run(`INSERT INTO event_service_totals (event_id, discount) VALUES (?, ?)
           ON CONFLICT(event_id) DO UPDATE SET discount = excluded.discount, updated_at = CURRENT_TIMESTAMP`, [id, discount]);
      const total = round2(Math.max(0, subtotal - discount));
      if (set_booking_amount) update('events', id, { booking_amount: total });
      audit(user.id, 'UPDATE', 'event_services', id, { count: items.length, subtotal, discount, set_booking_amount: !!set_booking_amount });
    });
    return eventServices(id);
  });

  // Admin: check the email setup by sending a test message.
  r.post('/api/settings/test-email', async () => {
    const to = bookingRecipients();
    if (!mailConfig()) throw new HttpError(400, 'Email is not set up yet. Add SMTP_HOST, SMTP_PORT, SMTP_USER and SMTP_PASS to server/.env and restart the server.');
    if (!to) throw new HttpError(400, 'Enter the Booking email address in Settings first.');
    try {
      await sendMail({ to, subject: 'Test email from BookMyUtsav', text: 'Booking emails are working.', html: '<p>Booking emails are working. ✅</p>' });
    } catch (e) {
      throw new HttpError(502, `Could not send: ${e.message}`);
    }
    return { sent_to: to };
  }, ADMIN);
  r.get('/api/settings/email-status', () => ({ configured: !!mailConfig(), to: bookingRecipients() }), ADMIN);

  // ---------- Booked events list (events that have services) ----------
  // ?q= search  ?when=upcoming|past|all (default upcoming)  ?source=online|staff|all  ?status=
  r.get('/api/bookings', ({ query }) => {
    const where = ['e.deleted_at IS NULL', 'EXISTS (SELECT 1 FROM event_services es WHERE es.event_id = e.id)'];
    const p = [];
    const ONLINE = "EXISTS (SELECT 1 FROM audit_log a WHERE a.entity = 'online_booking' AND a.entity_id = e.id)";
    if (query.q) { where.push('(e.name LIKE ? OR c.name LIKE ? OR c.mobile LIKE ? OR e.venue LIKE ?)'); p.push(...Array(4).fill(`%${query.q}%`)); }
    const when = query.when || 'upcoming';
    if (when === 'upcoming') { where.push('e.event_date >= ?'); p.push(localToday()); }
    if (when === 'past') { where.push('e.event_date < ?'); p.push(localToday()); }
    if (query.source === 'online') where.push(ONLINE);
    if (query.source === 'staff') where.push(`NOT ${ONLINE}`);
    if (query.status) { where.push('e.status = ?'); p.push(query.status); }
    const order = query.sort === 'newest' ? 'e.id DESC' : when === 'past' ? 'e.event_date DESC' : 'e.event_date ASC, e.start_time ASC';

    const events = all(`${EVENT_SELECT.replace('FROM events e', `, ${ONLINE} AS is_online FROM events e`)} WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT 500`, p).map(withMoney);
    if (!events.length) return [];
    const ids = events.map((e) => e.id);
    const marks = ids.map(() => '?').join(',');
    const lines = all(`SELECT es.*, ph.id AS photo_exists FROM event_services es LEFT JOIN service_photos ph ON ph.id = es.photo_id
                        WHERE es.event_id IN (${marks}) ORDER BY es.event_id, es.sort_order, es.id`, ids);
    const disc = new Map(all(`SELECT event_id, discount FROM event_service_totals WHERE event_id IN (${marks})`, ids).map((d) => [d.event_id, d.discount]));
    const by = new Map();
    for (const { photo_exists, ...l } of lines) (by.get(l.event_id) ?? by.set(l.event_id, []).get(l.event_id)).push({ ...l, photo_id: photo_exists ? l.photo_id : null });
    return events.map((e) => {
      const items = by.get(e.id) ?? [];
      const subtotal = round2(items.reduce((a, i) => a + i.amount, 0));
      const discount = Number(disc.get(e.id) || 0);
      return { ...e, is_online: e.is_online ? 1 : 0, items, subtotal, discount, services_total: round2(Math.max(0, subtotal - discount)) };
    });
  });

  // ---------- Public booking page (no login) ----------
  // Clients pick services on /book; submitting creates a tentative event with the services, photos and total.
  // Prices always come from the price list here, never from the browser.

  r.get('/api/public/info', () => {
    const st = getSettings();
    return { business_name: st.business_name, business_phone: st.business_phone, business_email: st.business_email, business_address: st.business_address, slug: current().company.slug };
  }, { public: true });

  r.get('/api/public/services', () =>
    listServices().map(({ id, name, category, price, photos, videos, min_price, max_price }) => ({
      id, name, category, price, min_price, max_price, photos: photos.map(({ id: pid, label, price: pp }) => ({ id: pid, label, price: pp })),
      // Uploaded files are played from /service-videos/<id>/file, so their stored name is not sent.
      videos: videos.map(({ id: vid, provider, video_id, label }) => ({ id: vid, provider, video_id: provider === 'file' ? null : video_id, label })),
    })), { public: true });

  r.get('/api/public/service-photos/:pid/file', (ctx) => {
    const p = get(`SELECT p.* FROM service_photos p JOIN services s ON s.id = p.service_id
                    WHERE p.id = ? AND p.deleted_at IS NULL AND s.active = 1`, [idParam(ctx.params.pid)]);
    if (!p) throw notFound('Photo');
    const file = path.join(config.uploadDir, p.stored_name);
    if (!fs.existsSync(file)) throw notFound('File');
    ctx.res.writeHead(200, { 'Content-Type': p.mime_type, 'Content-Length': p.size, 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'public, max-age=3600' });
    fs.createReadStream(file).pipe(ctx.res);
    ctx.handled = true;
  }, { public: true });

  r.get('/api/public/service-videos/:vid/file', (ctx) => {
    const v = get(`SELECT v.* FROM service_videos v JOIN services s ON s.id = v.service_id
                    WHERE v.id = ? AND v.provider = 'file' AND s.active = 1`, [idParam(ctx.params.vid)]);
    const file = v && path.join(config.uploadDir, path.basename(v.video_id));
    if (!file || !fs.existsSync(file)) throw notFound('Video');
    streamVideo(ctx, file, v.mime_type);
  }, { public: true });

  r.post('/api/public/bookings', ({ req, body }) => {
    limitBookings(req);
    if (body?.website) throw new HttpError(400, 'Booking could not be sent'); // hidden honeypot field filled by bots
    const d = validate(body, {
      name: { type: 'string', required: true, max: 150 },
      mobile: { type: 'mobile', required: true },
      email: { type: 'email' },
      event_date: { type: 'date', required: true },
      venue: { type: 'string', max: 200 },
      guests: { type: 'int', min: 0, max: 100000 },
      notes: { type: 'string', max: 2000 },
      pdf_base64: { type: 'string' },
    });
    // PDF made in the client's browser (same layout as the staff quotation). Optional.
    let pdf = null;
    if (d.pdf_base64) {
      pdf = Buffer.from(d.pdf_base64.replace(/^data:[^,]+,/, ''), 'base64');
      if (pdf.length > 8 * 1024 * 1024 || pdf.subarray(0, 5).toString('latin1') !== '%PDF-') pdf = null;
    }
    delete d.pdf_base64;
    if (d.event_date < localToday()) throw new HttpError(400, 'Please choose today or a future date', { event_date: 'Date is in the past' });
    const raw = Array.isArray(body?.items) ? body.items : [];
    if (!raw.length) throw new HttpError(400, 'Please select at least one service');
    if (raw.length > 100) throw new HttpError(400, 'Too many services');

    const seen = new Set();
    const items = raw.map((it, n) => {
      const row = validate(it, { service_id: { type: 'int', required: true }, photo_id: { type: 'int' }, quantity: { type: 'int', min: 1, max: 1000, default: 1 } });
      if (seen.has(row.service_id)) throw new HttpError(400, 'A service was selected twice');
      seen.add(row.service_id);
      const s = get('SELECT * FROM services WHERE id = ? AND active = 1', [row.service_id]);
      if (!s) throw new HttpError(400, `Service ${n + 1} is no longer available. Please refresh the page.`);
      const photos = all('SELECT id, label, price FROM service_photos WHERE service_id = ? AND deleted_at IS NULL ORDER BY sort_order, id', [s.id]);
      let photo = null;
      if (row.photo_id) {
        photo = photos.find((p) => p.id === row.photo_id);
        if (!photo) throw new HttpError(400, `The photo chosen for ${s.name} is no longer available. Please refresh the page.`);
      } else if (photos.length) photo = photos[0];
      const unit_price = photo ? photo.price : s.price;
      return {
        service_id: s.id, photo_id: photo?.id ?? null, name: s.name, category: s.category || 'Other', variant_label: photo?.label ?? null,
        unit_price, quantity: row.quantity, amount: round2(unit_price * row.quantity), sort_order: n + 1,
      };
    });
    const total = round2(items.reduce((a, i) => a + i.amount, 0));

    const id = tx(() => {
      // Same mobile number = same client. Existing client details are not overwritten from a public form.
      let clientId = scalar('SELECT id FROM clients WHERE mobile = ? ORDER BY id LIMIT 1', [d.mobile]);
      if (!clientId) clientId = insert('clients', { name: d.name, mobile: d.mobile, email: d.email, notes: 'Created from the online booking page.' });
      const eid = insert('events', {
        client_id: clientId, name: `${d.name} – Online booking`, event_date: d.event_date, venue: d.venue, guests: d.guests,
        booking_amount: total, status: 'UPCOMING', is_tentative: 1,
        description: `Online booking from the website by ${d.name} (${d.mobile}${d.email ? `, ${d.email}` : ''}). Confirm the date, services and price with the client.`,
        special_instructions: d.notes,
      });
      seedChecklist(eid);
      insert('event_decor', { event_id: eid });
      for (const i of items) insert('event_services', { event_id: eid, ...i });
      audit(null, 'CREATE', 'online_booking', eid, { client_id: clientId, total, items: items.length });
      return eid;
    });
    const reference = `EV-${String(id).padStart(5, '0')}`;
    let pdfName = null;
    if (pdf) {
      // Keep the PDF with the event (Documents tab).
      pdfName = `Booking-${reference}.pdf`;
      const stored = `${crypto.randomUUID()}.pdf`;
      fs.writeFileSync(path.join(config.uploadDir, stored), pdf);
      insert('documents', { event_id: id, file_name: pdfName, stored_name: stored, mime_type: 'application/pdf', size: pdf.length, caption: 'Online booking (sent by client)' });
    }
    // Tell the owner by email. Never makes the booking fail.
    notifyBooking({ id, reference, d, items, total, pdf, pdfName })
      .then((sent) => { if (sent) { console.log(`Booking email for ${reference} sent to ${sent}`); audit(null, 'EMAIL', 'online_booking', id, { to: sent }); } })
      .catch((e) => { console.error('Booking email failed:', e.message); audit(null, 'EMAIL_FAILED', 'online_booking', id, { error: e.message }); });
    return { reference, event_date: d.event_date, items, total };
  }, { public: true });
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = new Intl.NumberFormat('en-IN', { maximumFractionDigits: 2 });
const rs = (n) => `₹${nf.format(Number(n || 0))}`;
const dmy = (s) => new Date(`${s}T00:00:00`).toLocaleDateString('en-IN', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });

/** Who gets booking emails: Settings → Booking email, else business email, else BOOKING_NOTIFY_TO in .env. */
export function bookingRecipients() {
  const st = getSettings();
  // Last fallback: main company -> the Gmail account that sends the email (SMTP_USER); other companies -> their sign-up email.
  const c = current().company;
  const fallback = c.is_main ? process.env.BOOKING_NOTIFY_TO || process.env.SMTP_USER : c.email;
  return (st.booking_notify_email || st.business_email || fallback || '').trim();
}

/** Email the owner about a new online booking, with the PDF attached. Returns the address or null if email is off. */
async function notifyBooking({ id, reference, d, items, total, pdf, pdfName }) {
  const to = bookingRecipients();
  if (!mailConfig() || !to) {
    const reason = !mailConfig() ? 'SMTP not set up in .env' : 'no booking email in Settings';
    console.log(`New online booking ${reference} (email not sent: ${reason})`);
    audit(null, 'EMAIL_SKIPPED', 'online_booking', id, { reason });
    return null;
  }
  const st = getSettings();
  const appUrl = (process.env.APP_URL || `http://localhost:${config.port}`).replace(/\/$/, '');
  const link = `${appUrl}/events/${id}?tab=services`;
  const groups = new Map();
  for (const i of items) (groups.get(i.category) ?? groups.set(i.category, []).get(i.category)).push(i);
  const rows = [...groups].map(([cat, list]) => `
    <tr><td colspan="3" style="padding:10px 8px 4px;font-weight:700;color:#E65F0A;text-transform:uppercase;font-size:12px;letter-spacing:.05em">${esc(cat)}</td></tr>
    ${list.map((i) => `<tr>
      <td style="padding:6px 8px;border-bottom:1px solid #eee">${esc(i.name)}${i.variant_label ? ` <span style="color:#777">(${esc(i.variant_label)})</span>` : ''}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;color:#777;white-space:nowrap">${rs(i.unit_price)}${i.quantity !== 1 ? ` × ${i.quantity}` : ''}</td>
      <td style="padding:6px 8px;border-bottom:1px solid #eee;text-align:right;font-weight:600;white-space:nowrap">${rs(i.amount)}</td></tr>`).join('')}`).join('');
  const details = [['Client', d.name], ['Mobile', `<a href="tel:${esc(d.mobile)}">${esc(d.mobile)}</a>`, true], ['Email', d.email], ['Event date', dmy(d.event_date)],
    ['Venue', d.venue], ['Guests', d.guests], ['Notes', d.notes]]
    .filter(([, v]) => v).map(([k, v, raw]) => `<tr><td style="padding:3px 12px 3px 0;color:#777">${k}</td><td style="padding:3px 0"><b>${raw ? v : esc(v)}</b></td></tr>`).join('');
  const html = `<div style="font-family:Arial,Helvetica,sans-serif;color:#222;max-width:640px">
    <div style="background:#002453;color:#fff;padding:18px 20px;border-radius:12px 12px 0 0">
      <div style="font-size:12px;letter-spacing:.15em;color:#FF8A3D">NEW ONLINE BOOKING · ${esc(reference)}</div>
      <div style="font-size:22px;font-weight:700;margin-top:4px">${esc(d.name)} – ${esc(dmy(d.event_date))}</div>
    </div>
    <div style="border:1px solid #eee;border-top:0;padding:16px 20px;border-radius:0 0 12px 12px">
      <table style="font-size:14px;margin-bottom:12px">${details}</table>
      <table style="width:100%;border-collapse:collapse;font-size:14px">${rows}
        <tr><td colspan="2" style="padding:12px 8px;text-align:right;font-weight:700">Estimated total</td>
            <td style="padding:12px 8px;text-align:right;font-size:20px;font-weight:700;color:#E65F0A;white-space:nowrap">${rs(total)}</td></tr>
      </table>
      <p style="margin:16px 0 4px"><a href="${esc(link)}" style="background:#002453;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none;font-weight:600">Open booking in ${esc(st.business_name)}</a></p>
      <p style="color:#777;font-size:12px">The booking is saved as a tentative event. Call the client to confirm the date, services and price.${pdf ? ' The client\'s PDF is attached.' : ''}</p>
    </div></div>`;
  const text = [`New online booking ${reference}`, `Client: ${d.name}  Mobile: ${d.mobile}`, `Event date: ${dmy(d.event_date)}`, d.venue && `Venue: ${d.venue}`, '',
    ...items.map((i) => `- [${i.category}] ${i.name}${i.variant_label ? ` (${i.variant_label})` : ''}${i.quantity !== 1 ? ` x ${i.quantity}` : ''}: ${rs(i.amount)}`),
    '', `Estimated total: ${rs(total)}`, `Open: ${link}`].filter((x) => typeof x === 'string').join('\n');
  await sendMail({
    fromName: st.business_name,
    to, subject: `New booking ${reference} – ${d.name} – ${dmy(d.event_date)} – ${rs(total)}`, html, text,
    replyTo: d.email || undefined,
    attachments: pdf ? [{ filename: pdfName, content: pdf, contentType: 'application/pdf' }] : [],
  });
  return to;
}

// Simple in-memory limit so the public form cannot be used to flood the events list.
const BOOKING_LIMIT = Number(process.env.BOOKING_RATE_LIMIT_PER_HOUR || 5);
const BOOKING_WINDOW_MS = 60 * 60 * 1000;
const bookingHits = new Map();
function limitBookings(req) {
  if (process.env.BOOKING_RATE_LIMIT === 'off') return;
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now();
  const hits = (bookingHits.get(ip) || []).filter((t) => now - t < BOOKING_WINDOW_MS);
  if (hits.length >= BOOKING_LIMIT) throw new HttpError(429, 'Too many bookings from this device. Please call us or try again later.');
  hits.push(now);
  bookingHits.set(ip, hits);
}

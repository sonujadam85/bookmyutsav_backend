// Minimal SMTP client (no npm packages). Supports SSL (port 465) and STARTTLS (587), AUTH LOGIN/PLAIN,
// HTML body and attachments. Configure with SMTP_* values in server/.env.
import net from 'node:net';
import tls from 'node:tls';
import os from 'node:os';
import crypto from 'node:crypto';

export function mailConfig() {
  const e = process.env;
  if (!e.SMTP_HOST) return null;
  const port = Number(e.SMTP_PORT || 465);
  return {
    host: e.SMTP_HOST,
    port,
    secure: e.SMTP_SECURE ? e.SMTP_SECURE === 'true' : port === 465,
    user: e.SMTP_USER || '',
    pass: e.SMTP_PASS || '',
    from: e.SMTP_FROM || e.SMTP_USER || '',
    // Only for a local test server without TLS.
    allowInsecure: e.SMTP_ALLOW_INSECURE === 'true',
    timeoutMs: Number(e.SMTP_TIMEOUT_MS || 20000),
  };
}

const b64 = (s) => Buffer.from(s, 'utf8').toString('base64');
const wrap76 = (s) => s.replace(/.{1,76}/g, '$&\r\n');
const encodeHeader = (s) => (/^[\x20-\x7e]*$/.test(s) ? s : `=?UTF-8?B?${b64(s)}?=`);
const addr = (s) => (String(s).match(/<([^>]+)>/)?.[1] || String(s)).trim();

/** Build the raw MIME message. */
function buildMessage({ from, to, subject, html, text, attachments = [], replyTo }) {
  const boundary = `----evpro${crypto.randomBytes(12).toString('hex')}`;
  const alt = `----alt${crypto.randomBytes(12).toString('hex')}`;
  const domain = addr(from).split('@')[1] || 'localhost';
  const head = [
    `From: ${from}`,
    `To: ${to.join(', ')}`,
    ...(replyTo ? [`Reply-To: ${replyTo}`] : []),
    `Subject: ${encodeHeader(subject)}`,
    `Date: ${new Date().toUTCString().replace('GMT', '+0000')}`,
    `Message-ID: <${crypto.randomUUID()}@${domain}>`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
  ];
  const parts = [
    `--${boundary}\r\nContent-Type: multipart/alternative; boundary="${alt}"\r\n\r\n` +
      `--${alt}\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(b64(text || ''))}` +
      `--${alt}\r\nContent-Type: text/html; charset=UTF-8\r\nContent-Transfer-Encoding: base64\r\n\r\n${wrap76(b64(html || ''))}` +
      `--${alt}--\r\n`,
    ...attachments.map((a) => {
      const name = encodeHeader(a.filename);
      return `--${boundary}\r\nContent-Type: ${a.contentType || 'application/octet-stream'}; name="${name}"\r\n` +
        `Content-Transfer-Encoding: base64\r\nContent-Disposition: attachment; filename="${name}"\r\n\r\n${wrap76(Buffer.from(a.content).toString('base64'))}`;
    }),
  ];
  return `${head.join('\r\n')}\r\n\r\n${parts.join('')}--${boundary}--\r\n`;
}

/** Line-based reader for SMTP replies (handles multi-line "250-..." responses). */
function replies(socketRef) {
  let buf = '';
  let lines = [];
  let waiter = null;
  const pending = [];
  const onData = (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '');
      buf = buf.slice(i + 1);
      lines.push(line);
      if (/^\d{3} /.test(line) || /^\d{3}$/.test(line)) {
        const reply = { code: Number(line.slice(0, 3)), lines };
        lines = [];
        if (waiter) { const w = waiter; waiter = null; w.resolve(reply); }
        else pending.push(reply);
      }
    }
  };
  return {
    attach(sock) { sock.on('data', onData); socketRef.sock = sock; },
    detach(sock) { sock.removeListener('data', onData); },
    next(timeoutMs) {
      if (pending.length) return Promise.resolve(pending.shift());
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => { waiter = null; reject(new Error('Email server did not answer in time')); }, timeoutMs);
        waiter = { resolve: (r) => { clearTimeout(t); resolve(r); } };
        socketRef.onError = (e) => { clearTimeout(t); waiter = null; reject(e); };
      });
    },
  };
}

/**
 * Send an email. message: { to: string | string[], subject, html, text, attachments: [{ filename, content: Buffer, contentType }], replyTo }
 * Throws with a readable message on failure.
 */
export async function sendMail(message, cfg = mailConfig()) {
  if (!cfg) throw new Error('Email is not set up. Add SMTP_HOST, SMTP_USER and SMTP_PASS to server/.env');
  const to = (Array.isArray(message.to) ? message.to : String(message.to).split(/[,;]/)).map((s) => s.trim()).filter(Boolean);
  if (!to.length) throw new Error('No email address to send to');
  // Show the company name as sender (the address stays the configured Gmail account).
  const from = message.fromName ? `${encodeHeader(String(message.fromName).replace(/[\r\n"<>]/g, ''))} <${addr(cfg.from)}>` : cfg.from;
  const raw = buildMessage({ ...message, to, from });

  const ref = { sock: null, onError: null };
  const r = replies(ref);
  const connect = () => new Promise((resolve, reject) => {
    const opts = { host: cfg.host, port: cfg.port, servername: cfg.host };
    const s = cfg.secure ? tls.connect(opts, () => resolve(s)) : net.connect(opts, () => resolve(s));
    s.once('error', reject);
  });
  let sock = await connect();
  sock.on('error', (e) => ref.onError?.(e));
  sock.setTimeout(cfg.timeoutMs, () => sock.destroy(new Error('Email server connection timed out')));
  r.attach(sock);

  const cmd = async (line, expect, hide = false) => {
    if (line != null) sock.write(`${line}\r\n`);
    const rep = await r.next(cfg.timeoutMs);
    if (!expect.includes(rep.code)) {
      const what = hide ? 'login' : String(line ?? 'greeting').split(' ')[0];
      throw new Error(`Email server refused ${what}: ${rep.lines.join(' ').slice(0, 200)}`);
    }
    return rep;
  };

  try {
    await cmd(null, [220]);
    const helo = os.hostname().replace(/[^a-zA-Z0-9.-]/g, '') || 'localhost';
    let ehlo = await cmd(`EHLO ${helo}`, [250]);
    if (!cfg.secure && ehlo.lines.some((l) => /STARTTLS/i.test(l))) {
      await cmd('STARTTLS', [220]);
      r.detach(sock);
      sock = await new Promise((resolve, reject) => {
        const t = tls.connect({ socket: sock, servername: cfg.host }, () => resolve(t));
        t.once('error', reject);
      });
      sock.on('error', (e) => ref.onError?.(e));
      r.attach(sock);
      ehlo = await cmd(`EHLO ${helo}`, [250]);
    } else if (!cfg.secure && !cfg.allowInsecure) {
      throw new Error('Email server does not support a secure connection (STARTTLS). Use port 465 or set SMTP_SECURE=true');
    }
    if (cfg.user) {
      const auth = ehlo.lines.join(' ').toUpperCase();
      if (auth.includes('PLAIN') && !auth.includes('LOGIN')) {
        await cmd(`AUTH PLAIN ${Buffer.from(`\0${cfg.user}\0${cfg.pass}`).toString('base64')}`, [235], true);
      } else {
        await cmd('AUTH LOGIN', [334]);
        await cmd(b64(cfg.user), [334], true);
        await cmd(b64(cfg.pass), [235], true);
      }
    }
    await cmd(`MAIL FROM:<${addr(cfg.from)}>`, [250]);
    for (const t of to) await cmd(`RCPT TO:<${addr(t)}>`, [250, 251]);
    await cmd('DATA', [354]);
    // Every body line is base64 or a header, so no line starts with "."; stuff anyway to be safe.
    sock.write(raw.replace(/\r\n\./g, '\r\n..'));
    await cmd('.', [250]);
    sock.write('QUIT\r\n');
  } finally {
    setTimeout(() => sock.destroy(), 200);
  }
}

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { companyContext } from './context.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

// Load a simple KEY=VALUE .env file if present (no external dependency).
const envFile = path.join(ROOT, '.env');
if (fs.existsSync(envFile)) {
  for (const line of fs.readFileSync(envFile, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

process.env.TZ ??= 'Asia/Kolkata';

const dataDir = path.resolve(ROOT, process.env.DATA_DIR || 'data');
fs.mkdirSync(path.join(dataDir, 'uploads'), { recursive: true });

function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  // Generate once and persist so tokens survive restarts.
  const f = path.join(dataDir, '.jwt-secret');
  if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(48).toString('hex'), { mode: 0o600 });
  return fs.readFileSync(f, 'utf8').trim();
}

export const config = {
  port: Number(process.env.PORT || 3000),
  dataDir,
  // Main company (the platform owner) keeps the original files, so existing data needs no move.
  dbFile: path.join(dataDir, 'event-pro.db'),
  mainUploadDir: path.join(dataDir, 'uploads'),
  platformDbFile: path.join(dataDir, 'platform.db'),
  companiesDir: path.join(dataDir, 'companies'),
  kycDir: path.join(dataDir, 'kyc'),
  /** Upload folder of the company handling the current request. */
  get uploadDir() {
    const store = companyContext.getStore();
    if (!store) throw new Error('No company selected for this upload');
    return store.uploadDir;
  },
  jwtSecret: loadSecret(),
  tokenTtlHours: Number(process.env.TOKEN_TTL_HOURS || 12),
  maxBodyBytes: 15 * 1024 * 1024,
  maxUploadBytes: 10 * 1024 * 1024,
  maxVideoBytes: Number(process.env.VIDEO_MAX_MB || 100) * 1024 * 1024,
  clientDist: path.resolve(ROOT, process.env.CLIENT_DIST || '../client/dist/event-pro-erp/browser'),
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:4200',
};

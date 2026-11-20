// Deletes the database file so the next start re-creates it with seed data. Use with care.
import fs from 'node:fs';
import { config } from './config.js';

for (const f of [config.dbFile, `${config.dbFile}-wal`, `${config.dbFile}-shm`]) fs.rmSync(f, { force: true });
console.log('Database removed. Start the server to create a fresh one.');

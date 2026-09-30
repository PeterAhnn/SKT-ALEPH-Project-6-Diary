import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { createSqliteStore } from './src/store-sqlite.mjs';
import { createSupabaseStore } from './src/store-supabase.mjs';
import { createHandler } from './src/http.mjs';

if (existsSync('.env')) process.loadEnvFile('.env');
const origin = process.env.DIARY_RECORD_ORIGIN || 'user';
if (!['user', 'synthetic'].includes(origin)) throw new Error('DIARY_RECORD_ORIGIN must be user or synthetic');
const remote = process.env.SUPABASE_URL && process.env.SUPABASE_PUBLISHABLE_KEY;
const store = remote ? createSupabaseStore({ url: process.env.SUPABASE_URL, key: process.env.SUPABASE_PUBLISHABLE_KEY, recordOrigin: origin })
  : createSqliteStore({ filename: resolve(process.env.DIARY_DB_PATH || '.data/diary.sqlite'), recordOrigin: origin });
const server = createServer(createHandler({ store, recordOrigin: origin, publicDir: fileURLToPath(new URL('./public', import.meta.url)) }));
const port = Number(process.env.PORT || 8006);
server.listen(port, '127.0.0.1', () => console.log(`플랜두씨 다이어리: http://127.0.0.1:${port} (${store.kind}, ${origin})`));
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(async () => { await store.close(); process.exit(0); }));

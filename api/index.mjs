import { createSupabaseStore } from '../src/store-supabase.mjs';
import { createHandler } from '../src/http.mjs';
// Generic @vercel/node helpers consume the IncomingMessage body before this handler.
// Keep the raw stream for the shared JSON parser and its 64KB limit.
export const config = { helpers: false };
let handler;
export default async function api(req, res) {
  if (!handler) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_PUBLISHABLE_KEY;
    if (!url || !key) {
      res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: false, error: { code: 'UNAVAILABLE', message: '저장소 연결을 준비하고 있습니다. 잠시 뒤 다시 열어 주세요.' } }));
    }
    handler = createHandler({ store: createSupabaseStore({ url, key, recordOrigin: 'user' }), recordOrigin: 'user' });
  }
  const parsed = new URL(req.url, 'http://diary.invalid');
  if (parsed.searchParams.has('route')) {
    req.url = `/api/${parsed.searchParams.get('route').replace(/^\/+/, '')}`;
  }
  return handler(req, res);
}

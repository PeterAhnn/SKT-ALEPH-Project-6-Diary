import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { seoulToday } from '../public/core.mjs';
import { problem, validate } from './validation.mjs';

const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/app.mjs': ['app.mjs', 'text/javascript; charset=utf-8'], '/core.mjs': ['core.mjs', 'text/javascript; charset=utf-8'], '/styles.css': ['styles.css', 'text/css; charset=utf-8'] };
const csp = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";
function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
}
async function body(req) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw problem(415, 'JSON 형식으로 요청해 주세요.', 'UNSUPPORTED_MEDIA_TYPE');
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 65536) throw problem(413, '입력 자료가 너무 큽니다. 64KB 이하로 줄여 주세요.', 'PAYLOAD_TOO_LARGE');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw problem(400, '입력 형식을 읽을 수 없습니다.', 'VALIDATION'); }
}
function checkOrigin(req) {
  const origin = req.headers.origin;
  if (!origin) return;
  try {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.host.toLowerCase() !== (req.headers.host || '').toLowerCase()) throw new Error();
  } catch { throw problem(403, '앱 화면을 다시 열고 저장해 주세요.', 'ORIGIN'); }
}
function route(method, path) {
  if (method === 'POST' && path === '/api/plans') return ['plan.create', {}];
  const matches = [
    ['PATCH', /^\/api\/plans\/([^/]+)$/, 'plan.update', 'id'],
    ['POST', /^\/api\/plans\/([^/]+)\/tasks$/, 'task.create', 'plan_id'],
    ['PATCH', /^\/api\/tasks\/([^/]+)$/, 'task.update', 'id'],
    ['DELETE', /^\/api\/tasks\/([^/]+)$/, 'task.delete', 'id'],
    ['POST', /^\/api\/tasks\/([^/]+)\/(complete|reopen|restore)$/, null, 'id'],
    ['POST', /^\/api\/tasks\/([^/]+)\/executions$/, 'execution.create', 'task_id'],
    ['POST', /^\/api\/plans\/([^/]+)\/reviews$/, 'review.create', 'plan_id'],
    ['POST', /^\/api\/reviews\/([^/]+)\/next-plan$/, 'review.next-plan', 'id']
  ];
  for (const [verb, pattern, action, key] of matches) {
    const match = path.match(pattern);
    if (verb === method && match) return [action || `task.${match[2]}`, { [key]: decodeURIComponent(match[1]) }];
  }
  return null;
}
export function createHandler({ store, publicDir, clock = () => new Date().toISOString(), recordOrigin = 'user' }) {
  return async function handler(req, res) {
    res.setHeader('Content-Security-Policy', csp);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Frame-Options', 'DENY');
    try {
      const path = new URL(req.url, 'http://diary.invalid').pathname;
      if (req.method === 'GET' && path === '/api/health') return json(res, 200, { ok: true, storage: store.kind, authentication: false });
      if (req.method === 'GET' && path === '/api/state') return json(res, 200, { ok: true, data: await store.state(), meta: {
        storage: store.kind, timezone: 'Asia/Seoul', time_unit: 'minutes', today: seoulToday(new Date(clock())), authentication: false, record_origin: recordOrigin } });
      if (req.method === 'GET' && path === '/api/export') {
        const exportedAt = clock();
        res.setHeader('Content-Disposition', `attachment; filename="pds-diary-${seoulToday(new Date(exportedAt))}.json"`);
        return json(res, 200, { schema_version: 2, exported_at: exportedAt, timezone: 'Asia/Seoul', time_unit: 'minutes', record_origin: recordOrigin, ...await store.state() });
      }
      const operation = route(req.method, path);
      if (operation) {
        checkOrigin(req);
        const [action, reference] = operation;
        const input = req.method === 'DELETE' ? {} : await body(req);
        if (!input || typeof input !== 'object' || Array.isArray(input)) throw problem(400, '입력 형식은 JSON 객체여야 합니다.', 'VALIDATION');
        if (Object.keys(reference).some(k => Object.hasOwn(input, k) && input[k] !== reference[k])) throw problem(400, '요청 경로와 기록 ID가 다릅니다.', 'VALIDATION');
        const data = await store.mutate(action, validate(action, { ...input, ...reference }));
        return json(res, 200, { ok: true, data });
      }
      const asset = assets[path];
      if (asset && ['GET', 'HEAD'].includes(req.method) && publicDir) {
        const content = await readFile(join(publicDir, asset[0]));
        res.writeHead(200, { 'Content-Type': asset[1] });
        return res.end(req.method === 'HEAD' ? undefined : content);
      }
      return json(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: '요청한 화면이나 기록을 찾을 수 없습니다.' } });
    } catch (error) {
      const status = [400, 403, 404, 409, 413, 415].includes(error.status) ? error.status : 503;
      const message = status === 503 ? '저장소에 연결하지 못했습니다. 입력을 유지한 채 잠시 뒤 다시 시도해 주세요.' : error.message;
      const code = error.code || ({ 400: 'VALIDATION', 403: 'ORIGIN', 404: 'NOT_FOUND', 409: 'CONFLICT', 413: 'PAYLOAD_TOO_LARGE', 415: 'UNSUPPORTED_MEDIA_TYPE' }[status] || 'UNAVAILABLE');
      if (!res.headersSent) json(res, status, { ok: false, error: { code, message } });
      else res.end();
    }
  };
}

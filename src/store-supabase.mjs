// RPC and key behavior verified against https://supabase.com/docs/guides/getting-started/api-keys
// Keys stay in this server-side adapter; T06 stores public-safe data without login.
function failure(status, message) { return Object.assign(new Error(message), { status }); }
function isPublicKey(key) {
  if (typeof key !== 'string') return false;
  if (key.startsWith('sb_publishable_')) return true;
  try { return JSON.parse(Buffer.from(key.split('.')[1], 'base64url').toString()).role === 'anon'; } catch { return false; }
}
export function createSupabaseStore({ url = process.env.SUPABASE_URL, key = process.env.SUPABASE_PUBLISHABLE_KEY || process.env.SUPABASE_ANON_KEY, recordOrigin = 'user', fetchImpl = globalThis.fetch } = {}) {
  let endpoint;
  try { endpoint = new URL(url); } catch { throw failure(500, '공개 저장 서버 설정을 확인해 주세요.'); }
  if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || !isPublicKey(key) || recordOrigin !== 'user') throw failure(500, '공개 저장 서버 설정을 확인해 주세요.');
  const base = endpoint.href.replace(/\/$/, '');
  async function rpc(name, payload) {
    let response;
    try {
      response = await fetchImpl(`${base}/rest/v1/rpc/${name}`, { method: 'POST', headers: { apikey: key, 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(15000) });
    } catch { throw failure(503, '저장 서버에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.'); }
    let body;
    try { body = await response.json(); } catch { throw failure(503, '저장 서버 응답을 확인하지 못했습니다.'); }
    if (!response.ok) {
      const code = body?.code; const status = ['PT400', '22P02', '22007', '23514', '23503'].includes(code) ? 400 : code === 'PT404' ? 404 : ['PT409', '23505', '40001', '40P01'].includes(code) ? 409 : 503;
      const message = status === 400 ? '입력 자료의 형식이나 연결된 기록을 확인해 주세요.' : status === 404 ? '해당 기록을 찾을 수 없습니다.' : status === 409 ? '다른 변경 또는 같은 요청 식별자가 있습니다. 최신 자료를 확인해 주세요.' : '저장 서버에서 작업을 완료하지 못했습니다.';
      throw failure(status, message);
    }
    return body;
  }
  return {
    kind: 'postgres',
    async state() { return rpc('pds_state', {}); },
    async mutate(action, payload) { return rpc('pds_mutate', { p_action: action, p_payload: { ...payload, record_origin: recordOrigin } }); },
    async close() {}
  };
}

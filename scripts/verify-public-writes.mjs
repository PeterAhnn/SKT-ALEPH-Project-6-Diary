// Public rejection checks only. Never create fixture records or submit a current-version edit.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validate } from '../src/validation.mjs';

const base = 'https://skt-aleph-project-6-diary.vercel.app';
const planID = 'ac9cad6d-c16c-4c20-b890-eac7466e6ad2';
const output = fileURLToPath(new URL('../verification/public-write-validation.json', import.meta.url));
const tables = ['plans', 'plan_history', 'tasks', 'executions', 'completion_events', 'request_receipts', 'reviews'];
const planFields = ['title', 'description', 'start_date', 'end_date', 'priority', 'success_criteria', 'expected_minutes'];
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = state => createHash('sha256').update(JSON.stringify(canonical(state))).digest('hex');
const counts = state => Object.fromEntries(tables.map(table => [table, state[table].length]));
const evidence = {
  checked_at: new Date().toISOString(), status: 'RUNNING', public_url: base,
  application_baseline_commit: 'b9de0298cd200961eac56286c6a6a55299947a96',
  deployment_id: 'dpl_EzpXjtay3cRvFr1vJXV2rPwV8JpM',
  deployment_metadata_source: 'Parent verified READY deployment before authorizing this run; this script does not introspect deployment metadata',
  credentials: 'omit; no cookies, Authorization, apikey or deployment bypass headers',
  original_plan_id: planID, requests: [], checks: {},
  scope: 'Rejected writes only. No valid record creation, no current-version update, no deletion, no automatic retry.',
};
let before = null;

async function request(path, { method = 'GET', raw } = {}) {
  const response = await fetch(`${base}${path}`, {
    method, credentials: 'omit', redirect: 'error', cache: 'no-store',
    ...(raw === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: raw }),
    signal: AbortSignal.timeout(20000),
  });
  assert.match(response.headers.get('content-type') || '', /^application\/json/i, 'public response must be JSON');
  const body = await response.json();
  evidence.requests.push({ method, path, status: response.status,
    ...(raw === undefined ? {} : { request_bytes: Buffer.byteLength(raw) }),
    ...(body.error ? { error: { code: body.error.code, message: body.error.message } } : {}),
  });
  return { status: response.status, body };
}
async function readState() {
  const { status, body } = await request('/api/state');
  assert.equal(status, 200); assert.equal(body.ok, true);
  assert.equal(body.meta.storage, 'postgres'); assert.equal(body.meta.authentication, false);
  assert.equal(body.meta.record_origin, 'user'); assert.equal(body.meta.timezone, 'Asia/Seoul');
  assert.equal(body.meta.time_unit, 'minutes');
  assert.deepEqual(Object.keys(body.data).sort(), [...tables].sort());
  for (const table of tables) assert.ok(Array.isArray(body.data[table]), `${table} must be an array`);
  return body.data;
}
async function verify() {
  if (process.argv.length > 2) throw new Error('이 검증은 승인된 공개 주소에서만 실행합니다. 명령 인수를 넣지 마세요.');
  before = await readState();
  const plan = before.plans.find(row => row.id === planID);
  assert.ok(plan && Number.isSafeInteger(plan.version) && plan.version >= 2, 'original Plan must exist at version 2 or newer before any PATCH');
  evidence.original_plan_version_before = plan.version;
  evidence.before_counts = counts(before);
  evidence.before_state_sha256 = hash(before);
  evidence.checks.public_state_without_credentials = true;

  const emptyTitle = await request('/api/plans', { method: 'POST', raw: JSON.stringify({ title: '' }) });
  assert.equal(emptyTitle.status, 400); assert.equal(emptyTitle.body.ok, false);
  assert.equal(emptyTitle.body.error.code, 'VALIDATION');
  assert.match(emptyTitle.body.error.message, /계획 제목/, 'raw JSON must reach field validation instead of an empty stream error');
  evidence.checks.empty_title_400_field_validation = true;

  const malformed = await request('/api/plans', { method: 'POST', raw: '{' });
  assert.equal(malformed.status, 400); assert.equal(malformed.body.ok, false);
  assert.equal(malformed.body.error.code, 'VALIDATION');
  assert.match(malformed.body.error.message, /입력 형식을 읽을 수 없습니다/);
  evidence.checks.malformed_json_400 = true;

  const oversizedBody = JSON.stringify({ title: '', padding: 'x'.repeat(65536) });
  assert.ok(Buffer.byteLength(oversizedBody) > 65536);
  const oversized = await request('/api/plans', { method: 'POST', raw: oversizedBody });
  assert.equal(oversized.status, 413); assert.equal(oversized.body.ok, false);
  assert.equal(oversized.body.error.code, 'PAYLOAD_TOO_LARGE');
  evidence.checks.body_over_64kb_413 = true;

  const stalePayload = { ...Object.fromEntries(planFields.map(field => [field, plan[field]])), expected_version: 1 };
  // Ensure every supplied field is valid, but never permit a matching version.
  validate('plan.update', { ...stalePayload, id: planID });
  assert.ok(stalePayload.expected_version < plan.version);
  const stale = await request(`/api/plans/${planID}`, { method: 'PATCH', raw: JSON.stringify(stalePayload) });
  assert.equal(stale.status, 409); assert.equal(stale.body.ok, false);
  assert.equal(stale.body.error.code, 'CONFLICT');
  evidence.stale_patch = { supplied_expected_version: 1, observed_plan_version: plan.version,
    fields: planFields, changed_field_values: 0,
    inference: 'Valid input passed HTTP validation; the observed 409 is the adapter mapping of database conflict. This script does not inspect private runtime logs.' };
  evidence.checks.stale_valid_plan_patch_409 = true;

  const after = await readState();
  evidence.after_counts = counts(after);
  evidence.after_state_sha256 = hash(after);
  assert.deepStrictEqual(after, before, 'all seven tables and every field must remain unchanged');
  assert.equal(evidence.after_state_sha256, evidence.before_state_sha256);
  evidence.original_plan_version_after = after.plans.find(row => row.id === planID).version;
  evidence.checks.all_seven_tables_deep_equal = true;
  evidence.checks.state_hash_unchanged = true;
  evidence.records_created = 0; evidence.records_changed = 0;
  evidence.status = 'PASS';
}

try { await verify(); }
catch (error) {
  evidence.status = 'FAIL';
  evidence.reason = error instanceof assert.AssertionError
    ? '공개 응답·기대값 또는 기존 자료 보존 검사가 실패했습니다. 원자료는 출력하지 않습니다.'
    : '공개 연결이나 검증 실행을 완료하지 못했습니다. 자동 재시도하지 않았습니다.';
  // Even after a rejection check fails, attempt a final read to expose any unexpected change.
  if (before && !Object.hasOwn(evidence, 'after_state_sha256')) {
    try {
      const after = await readState();
      evidence.after_counts = counts(after); evidence.after_state_sha256 = hash(after);
      try { assert.deepStrictEqual(after, before); evidence.checks.all_seven_tables_deep_equal = true; }
      catch { evidence.checks.all_seven_tables_deep_equal = false; }
      evidence.checks.state_hash_unchanged = evidence.after_state_sha256 === evidence.before_state_sha256;
    } catch { evidence.final_state_read = 'FAILED'; }
  }
  process.exitCode = 1;
}
evidence.finished_at = new Date().toISOString();
await mkdir(fileURLToPath(new URL('../verification/', import.meta.url)), { recursive: true });
await writeFile(output, JSON.stringify(evidence, null, 2) + '\n');
console.log(JSON.stringify({ status: evidence.status, checks: evidence.checks, before_counts: evidence.before_counts,
  after_counts: evidence.after_counts, before_state_sha256: evidence.before_state_sha256,
  after_state_sha256: evidence.after_state_sha256, evidence: 'verification/public-write-validation.json' }, null, 2));

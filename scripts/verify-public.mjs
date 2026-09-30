// Read-only public verification: unauthenticated GET requests only.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { aggregate } from '../public/core.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const base = 'https://skt-aleph-project-6-diary.vercel.app';
const tableNames = ['plans', 'plan_history', 'tasks', 'executions', 'completion_events', 'request_receipts', 'reviews'];
const expectedCounts = { plans: 2, plan_history: 3, tasks: 7, executions: 3, completion_events: 4, request_receipts: 4, reviews: 1 };
const sourcePlanId = 'ac9cad6d-c16c-4c20-b890-eac7466e6ad2';
const reviewId = '0ce0ee26-835e-4d5e-837c-ccbbf146b7b0';
const nextPlanId = 'a38f2070-8f88-413e-b132-58d75ad8f1ae';
const selectedImprovement = '작업 전에 파일 읽기와 검사 실행 권한부터 확인한다';
const publicNotice = '지금은 로그인이 없어 링크를 아는 사람은 누구나 볼 수 있습니다. 남이 봐도 괜찮은 내용만 넣으세요';
const evidenceFile = resolve(root, 'verification/public-verification.json');
const exportFile = resolve(root, 'verification/current-export.json');
const allowAssetMismatch = process.argv.includes('--allow-asset-mismatch');
if (process.argv.slice(2).some(argument => argument !== '--allow-asset-mismatch')) {
  console.error('사용법: node scripts/verify-public.mjs [--allow-asset-mismatch]');
  process.exit(1);
}
const canonical = value => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object'
  ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const digest = value => createHash('sha256').update(typeof value === 'string' || Buffer.isBuffer(value) ? value : JSON.stringify(canonical(value))).digest('hex');
const counts = state => Object.fromEntries(tableNames.map(table => [table, state[table].length]));
const responseChecks = [];
const secretChecks = [];
const checks = {};
const assets = [];
let latestExport;

const forbidden = [
  ['private_key', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['supabase_secret', /sb_secret_[A-Za-z0-9_-]{16,}/],
  ['github_token', /(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,})/],
  ['database_credentials', /postgres(?:ql)?:\/\/[^\s:/]+:[^\s@]+@/],
  ['supabase_client_key', /sb_publishable_[A-Za-z0-9_-]{16,}/],
  ['server_db_configuration', /\bSUPABASE_(?:PUBLISHABLE_KEY|SERVICE_ROLE_KEY|ANON_KEY|URL)\b/],
];
function checkSecrets(text, path) {
  const found = forbidden.filter(([, expression]) => expression.test(text)).map(([label]) => label);
  secretChecks.push({ path, passed: found.length === 0, matched_labels: found });
  assert.equal(found.length, 0, `secret pattern in ${path}; values intentionally omitted`);
}
async function get(path, contentType) {
  const response = await fetch(`${base}${path}`, {
    method: 'GET', redirect: 'manual', credentials: 'omit',
    headers: { Accept: path.startsWith('/api/') ? 'application/json' : '*/*' },
    signal: AbortSignal.timeout(30000),
  });
  responseChecks.push({
    path, method: 'GET', status: response.status, redirected: response.redirected,
    login_redirect: response.status >= 300 && response.status < 400,
    content_type: response.headers.get('content-type'),
    content_security_policy: response.headers.get('content-security-policy'),
    nosniff: response.headers.get('x-content-type-options') === 'nosniff',
    cache_control: response.headers.get('cache-control'),
  });
  assert.equal(response.status, 200, `${path} must be HTTP 200 without redirects or credentials`);
  assert.equal(response.redirected, false);
  assert.match(response.headers.get('content-type') || '', contentType, `${path} content type`);
  const csp = response.headers.get('content-security-policy') || '';
  assert.match(csp, /script-src\s+'self'/, `${path} CSP script policy`);
  assert.match(csp, /object-src\s+'none'/, `${path} CSP object policy`);
  assert.doesNotMatch(csp, /unsafe-inline|unsafe-eval/, `${path} CSP must not allow inline execution`);
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const bytes = Buffer.from(await response.arrayBuffer());
  const text = bytes.toString('utf8');
  checkSecrets(text, path);
  return { response, bytes, text };
}
function parseJSON(result) { return JSON.parse(result.text); }

async function verify() {
  const homepage = await get('/', /text\/html/i);
  assert.ok(homepage.text.includes(publicNotice), 'exact public notice must be present');
  checks.exact_public_notice = true;
  for (const [name, contentType] of [
    ['index.html', /text\/html/i], ['app.mjs', /(?:application|text)\/(?:java|ecma)script/i],
    ['core.mjs', /(?:application|text)\/(?:java|ecma)script/i], ['styles.css', /text\/css/i],
  ]) {
    const remote = await get(`/${name}`, contentType);
    const local = await readFile(resolve(root, 'public', name));
    assets.push({ path: `/${name}`, local_sha256: digest(local), public_sha256: digest(remote.bytes), equal: local.equals(remote.bytes) });
  }
  checks.assets_equal = assets.every(asset => asset.equal);
  checks.all_static_files_accessible = true;
  const health = parseJSON(await get('/api/health', /application\/json/i));
  assert.deepStrictEqual(health, { ok: true, storage: 'postgres', authentication: false });
  checks.postgres_health_without_authentication = true;

  const first = parseJSON(await get('/api/state', /application\/json/i));
  const second = parseJSON(await get('/api/state', /application\/json/i));
  assert.equal(first.ok, true); assert.equal(second.ok, true);
  assert.deepStrictEqual(second.data, first.data, 'repeat GET must preserve every ID/date/value/version');
  assert.deepStrictEqual(second.meta, first.meta, 'repeat GET must preserve units and metadata');
  assert.equal(first.meta.storage, 'postgres'); assert.equal(first.meta.authentication, false);
  assert.equal(first.meta.timezone, 'Asia/Seoul'); assert.equal(first.meta.time_unit, 'minutes');
  assert.equal(first.meta.record_origin, 'user');
  assert.deepStrictEqual(Object.keys(first.data).sort(), [...tableNames].sort());
  assert.deepStrictEqual(counts(first.data), expectedCounts);
  checks.repeat_state_exactly_equal = true;
  checks.counts_equal = true;
  checks.timezone_and_minutes_equal = true;
  const metrics = aggregate(first.data, sourcePlanId, first.meta.today);
  const expectedMetrics = { planned: 7, completed: 4, overdue: 0, blocked: 3, expected_minutes: 300, actual_minutes: 18, delta_minutes: -282 };
  assert.deepStrictEqual(Object.fromEntries(Object.keys(expectedMetrics).map(key => [key, metrics[key]])), expectedMetrics);
  checks.source_plan_metrics_equal = true;
  const review = first.data.reviews.find(item => item.id === reviewId);
  const nextPlan = first.data.plans.find(item => item.id === nextPlanId);
  assert.ok(review && nextPlan, 'selected review and next plan must exist');
  assert.equal(review.plan_id, sourcePlanId);
  assert.equal(review.improvement, selectedImprovement);
  assert.equal(review.next_plan_id, nextPlanId);
  assert.equal(nextPlan.source_review_id, reviewId);
  assert.equal(nextPlan.carried_improvement, selectedImprovement);
  assert.equal(nextPlan.title, 'ALEPH 남은 검증 마무리');
  assert.equal(nextPlan.start_date, '2026-10-01'); assert.equal(nextPlan.end_date, '2026-10-02');
  assert.equal(nextPlan.expected_minutes, 135);
  checks.selected_improvement_and_bidirectional_link_equal = true;

  const exported = await get('/api/export', /application\/json/i);
  assert.match(exported.response.headers.get('content-disposition') || '', /attachment;.*\.json/i);
  latestExport = parseJSON(exported);
  assert.equal(latestExport.schema_version, 2);
  assert.equal(latestExport.timezone, first.meta.timezone);
  assert.equal(latestExport.time_unit, first.meta.time_unit);
  assert.equal(latestExport.record_origin, 'user');
  assert.ok(Number.isFinite(new Date(latestExport.exported_at).getTime()));
  for (const table of tableNames) assert.deepStrictEqual(latestExport[table], first.data[table], `${table} export must equal state`);
  checks.export_all_seven_arrays_equal = true;
  checks.export_units_equal = true;
  checks.no_credentials_or_login_redirects = true;
  checks.response_secret_patterns_clear = true;

  const assetsPending = !checks.assets_equal;
  const evidence = {
    checked_at: new Date().toISOString(), base_url: base,
    status: assetsPending ? 'api_passed_assets_pending' : 'passed',
    scope: 'Unauthenticated GET root, four static files, health, state twice, and complete export. No writes or DOM interaction.',
    limitations: [
      'HTTP GET and CSP checks do not replace DOM/mobile interaction or console inspection.',
      'Secret scans cover the recorded response patterns, not every possible secret format.',
      'Counts and overdue=0 are the approved baseline for 2026-09-30; later user edits or date changes may require updated expectations.',
      ...(assetsPending ? ['Local assets differ from the current deployment; final asset parity remains pending.'] : []),
    ],
    request_credentials: 'none', get_requests: responseChecks.length, baseline_date: '2026-09-30',
    state_today: first.meta.today, counts: counts(first.data), metrics: expectedMetrics,
    review_id: reviewId, next_plan_id: nextPlanId,
    state_sha256: digest(first.data), repeated_state_sha256: digest(second.data),
    export_sha256: digest(latestExport), checks, assets,
    responses: responseChecks, secret_pattern_checks: secretChecks,
    export_file: 'verification/current-export.json',
  };
  await mkdir(dirname(evidenceFile), { recursive: true });
  await writeFile(exportFile, `${JSON.stringify(latestExport, null, 2)}\n`, 'utf8');
  await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify({ status: evidence.status, checked_at: evidence.checked_at, get_requests: evidence.get_requests, counts: evidence.counts, metrics: evidence.metrics, state_sha256: evidence.state_sha256, assets_equal: checks.assets_equal, export_saved: true }));
  if (assetsPending && !allowAssetMismatch) process.exitCode = 1;
}
try { await verify(); }
catch (error) {
  const evidence = {
    checked_at: new Date().toISOString(), base_url: base, status: 'failed',
    scope: 'Unauthenticated read-only GET verification; no writes.',
    reason: error instanceof assert.AssertionError ? 'A public response, baseline, header or data-equality assertion failed. Record values omitted.' : 'Public verification could not complete. Record values and credentials omitted.',
    checks, assets, responses: responseChecks, secret_pattern_checks: secretChecks,
  };
  await mkdir(dirname(evidenceFile), { recursive: true });
  await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.error(JSON.stringify({ status: 'failed', reason: evidence.reason, completed_get_requests: responseChecks.length }));
  process.exitCode = 1;
}

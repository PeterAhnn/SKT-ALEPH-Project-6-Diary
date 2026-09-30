import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join, resolve, relative } from 'node:path';
import { createSqliteStore } from '../src/store-sqlite.mjs';
import { createSupabaseStore } from '../src/store-supabase.mjs';
import { aggregate } from '../public/core.mjs';

const TEST_ROOT = resolve('.test-data');
const PLAN = { title: '합성 검사 계획', description: '실제 사용자 기록이 아닙니다.', start_date: '2026-09-30', end_date: '2026-10-02', priority: 'medium', success_criteria: '합성 검사 완료', expected_minutes: 60 };
const TASK = { title: '합성 검사 할 일', notes: '시험용', due_date: '2026-09-29', priority: 'high', tags: ['시험', '공부'], expected_minutes: 20 };
async function fixture(t) {
  mkdirSync(TEST_ROOT, { recursive: true });
  const folder = mkdtempSync(join(TEST_ROOT, 'store-'));
  const filename = join(folder, 'diary.sqlite'); let tick = 0;
  const clock = () => new Date(Date.UTC(2026, 8, 30, 0, 0, tick++)).toISOString();
  const store = createSqliteStore({ filename, clock, recordOrigin: 'synthetic' });
  t.after(async () => { await store.close(); const inside = relative(TEST_ROOT, folder); if (!inside || inside.startsWith('..') || resolve(TEST_ROOT, inside) !== folder) throw new Error('Unexpected test cleanup path'); rmSync(folder, { recursive: true, force: true }); });
  return { store, filename, clock };
}
const rejectStatus = status => error => error.status === status && !/sqlite|constraint|\.sqlite/i.test(error.message);
async function seeded(store) {
  const plan = (await store.mutate('plan.create', PLAN)).entity;
  const task = (await store.mutate('task.create', { plan_id: plan.id, ...TASK })).entity;
  return { plan, task };
}

test('disk DB starts empty and preserves complete state exactly after reopening', async t => {
  const { store, filename } = await fixture(t);
  assert.equal(store.kind, 'sqlite'); assert.ok(existsSync(filename));
  const empty = await store.state(); assert.equal(Object.keys(empty).length, 7); assert.ok(Object.values(empty).every(rows => rows.length === 0));
  const { plan, task } = await seeded(store);
  await store.mutate('execution.create', { task_id: task.id, started_at: '2026-09-30T00:00:00.000Z', ended_at: '2026-09-30T00:25:00.000Z', actual_minutes: 25, blocked_reason: '합성 장애' });
  await store.mutate('task.complete', { id: task.id, request_id: 'disk-complete' });
  await store.mutate('review.create', { plan_id: plan.id, improvement: '다음에는 분량을 나눈다' });
  const before = await store.state(); await store.close();
  const reopened = createSqliteStore({ filename, recordOrigin: 'synthetic' });
  try { assert.deepEqual(await reopened.state(), before); } finally { await reopened.close(); }
  assert.deepEqual(before.tasks[0].tags, TASK.tags); assert.equal(before.plans[0].record_origin, 'synthetic');
  assert.ok(before.plan_history[0].snapshot); assert.ok(before.request_receipts[0].response); assert.equal(before.tasks[0].tags_json, undefined);
});

test('same Plan ID retains initial and changed snapshots and rejects stale versions', async t => {
  const { store, filename } = await fixture(t); const { plan } = await seeded(store);
  const updated = (await store.mutate('plan.update', { id: plan.id, expected_version: 1, title: '변경한 합성 계획' })).entity;
  assert.equal(updated.id, plan.id); assert.equal(updated.version, 2);
  const before = await store.state();
  assert.deepEqual(before.plan_history.map(row => row.snapshot.title), [PLAN.title, updated.title]);
  await assert.rejects(store.mutate('plan.update', { id: plan.id, expected_version: 1, title: '충돌' }), rejectStatus(409));
  assert.deepEqual(await store.state(), before);
  const direct = new DatabaseSync(filename);
  try {
    assert.throws(() => direct.prepare('UPDATE plan_history SET snapshot_json=? WHERE plan_id=?').run('{}', plan.id), /immutable_history/);
    assert.throws(() => direct.prepare('DELETE FROM plan_history WHERE plan_id=?').run(plan.id), /immutable_history/);
  } finally { direct.close(); }
});

test('executions are separate and literal script-shaped strings survive unchanged', async t => {
  const { store } = await fixture(t); const { plan, task } = await seeded(store); const before = await store.state();
  const literal = '<script>globalThis.shouldNotExecute = true</script>';
  const execution = (await store.mutate('execution.create', { task_id: task.id, started_at: '2026-09-30T09:00:00+09:00', ended_at: '2026-09-30T09:15:00+09:00', actual_minutes: 15, blocked_reason: literal })).entity;
  const after = await store.state();
  assert.deepEqual(after.plans, before.plans); assert.deepEqual(after.plan_history, before.plan_history); assert.deepEqual(after.tasks, before.tasks);
  assert.equal(execution.started_at, '2026-09-30T00:00:00.000Z'); assert.equal(execution.blocked_reason, literal); assert.equal(execution.actual_minutes, 15);
  assert.equal(globalThis.shouldNotExecute, undefined); assert.equal(plan.expected_minutes, 60);
});

test('repeated completion adds one event and keeps current completed count at one', async t => {
  const { store } = await fixture(t); const { task } = await seeded(store);
  const first = await store.mutate('task.complete', { id: task.id, request_id: 'complete-1' });
  const replay = await store.mutate('task.complete', { id: task.id, request_id: 'complete-1' });
  const another = await store.mutate('task.complete', { id: task.id, request_id: 'complete-2' });
  assert.equal(first.changed, true); assert.equal(replay.replayed, true); assert.equal(another.changed, false); assert.equal(first.event.id, another.event.id);
  const state = await store.state(); assert.equal(state.completion_events.length, 1); assert.equal(state.tasks.filter(row => row.status === 'completed').length, 1); assert.equal(state.tasks[0].version, 2); assert.equal(state.request_receipts.length, 2);
});

test('reopen creates a new completion cycle and old completion replay cannot re-complete', async t => {
  const { store } = await fixture(t); const { task } = await seeded(store);
  const completed = await store.mutate('task.complete', { id: task.id, request_id: 'cycle-complete-0' });
  const reopened = await store.mutate('task.reopen', { id: task.id, request_id: 'cycle-reopen-0' });
  assert.equal(reopened.entity.completion_cycle, 1); assert.equal(reopened.entity.status, 'pending');
  assert.equal((await store.mutate('task.reopen', { id: task.id, request_id: 'cycle-reopen-0' })).replayed, true);
  const replay = await store.mutate('task.complete', { id: task.id, request_id: 'cycle-complete-0' });
  assert.equal(replay.entity.version, completed.entity.version); assert.equal(replay.replayed, true);
  assert.equal((await store.state()).tasks[0].status, 'pending');
  assert.equal((await store.mutate('task.reopen', { id: task.id, request_id: 'already-pending' })).changed, false);
  await store.mutate('task.complete', { id: task.id, request_id: 'cycle-complete-1' });
  const state = await store.state(); assert.deepEqual(state.completion_events.map(row => row.cycle), [0, 1]); assert.equal(state.tasks[0].completion_cycle, 1); assert.equal(state.tasks[0].version, 4);
});

test('global request key reuse for another task or action is rejected without mutation', async t => {
  const { store } = await fixture(t); const { plan, task } = await seeded(store);
  const other = (await store.mutate('task.create', { plan_id: plan.id, ...TASK })).entity;
  await store.mutate('task.complete', { id: task.id, request_id: 'globally-unique' }); const before = await store.state();
  await assert.rejects(store.mutate('task.complete', { id: other.id, request_id: 'globally-unique' }), rejectStatus(409));
  await assert.rejects(store.mutate('task.reopen', { id: task.id, request_id: 'globally-unique' }), rejectStatus(409));
  assert.deepEqual(await store.state(), before);
});

test('soft delete preserves linked history, excludes aggregate contributions and restores task', async t => {
  const { store } = await fixture(t); const { plan, task } = await seeded(store);
  await store.mutate('execution.create', { task_id: task.id, started_at: '2026-09-30T00:00:00Z', ended_at: '2026-09-30T00:10:00Z', actual_minutes: 10, blocked_reason: '시험' });
  await store.mutate('task.complete', { id: task.id, request_id: 'before-delete' });
  const deleted = await store.mutate('task.delete', { id: task.id }); assert.ok(deleted.entity.deleted_at); assert.equal(deleted.entity.version, 3);
  assert.equal((await store.mutate('task.delete', { id: task.id })).changed, false);
  await assert.rejects(store.mutate('task.update', { id: task.id, expected_version: 3, title: '삭제 후 변경' }), rejectStatus(404));
  await assert.rejects(store.mutate('task.complete', { id: task.id, request_id: 'after-delete' }), rejectStatus(404));
  await assert.rejects(store.mutate('execution.create', { task_id: task.id }), rejectStatus(404));
  let state = await store.state(); assert.equal(state.executions.length, 1); assert.equal(state.completion_events.length, 1); assert.equal(state.tasks.filter(row => !row.deleted_at).length, 0);
  const deletedMetrics = aggregate(state, plan.id, '2026-09-30');
  for (const key of ['planned', 'completed', 'overdue', 'blocked', 'expected_minutes', 'actual_minutes', 'delta_minutes']) assert.equal(deletedMetrics[key], 0, `deleted task contribution: ${key}`);
  const restored = await store.mutate('task.restore', { id: task.id }); assert.equal(restored.entity.deleted_at, null); assert.equal(restored.entity.version, 4); assert.equal(restored.entity.status, 'completed');
  const restoredMetrics = aggregate(await store.state(), plan.id, '2026-09-30');
  assert.equal(restoredMetrics.completed, 1); assert.equal(restoredMetrics.blocked, 1); assert.equal(restoredMetrics.expected_minutes, 20); assert.equal(restoredMetrics.actual_minutes, 10); assert.equal(restoredMetrics.delta_minutes, -10);
  assert.equal((await store.mutate('task.restore', { id: task.id })).changed, false);
});

test('failed history insertion rolls back the preceding Plan update', async t => {
  const { store, filename } = await fixture(t); const { plan } = await seeded(store);
  const direct = new DatabaseSync(filename);
  direct.exec("CREATE TRIGGER test_reject_history BEFORE INSERT ON plan_history WHEN NEW.version=2 BEGIN SELECT RAISE(ABORT,'history_failure'); END"); direct.close();
  const before = await store.state();
  await assert.rejects(store.mutate('plan.update', { id: plan.id, expected_version: 1, title: '저장돼서는 안 됨' }), error => error.status === 500);
  assert.deepEqual(await store.state(), before);
});

test('review creates one next Plan atomically and carries its source and improvement', async t => {
  const { store } = await fixture(t); const { plan } = await seeded(store);
  const review = (await store.mutate('review.create', { plan_id: plan.id, improvement: '학습 단위를 작게 나눈다' })).entity;
  const first = await store.mutate('review.next-plan', { id: review.id, ...PLAN, title: '다음 계획' });
  const replay = await store.mutate('review.next-plan', { id: review.id, ...PLAN, title: '중복 계획' });
  assert.equal(first.entity.source_review_id, review.id); assert.equal(first.entity.carried_improvement, review.improvement); assert.equal(first.review.next_plan_id, first.entity.id);
  assert.equal(replay.changed, false); assert.equal(replay.entity.id, first.entity.id);
  const state = await store.state(); assert.equal(state.plans.length, 2); assert.equal(state.plan_history.length, 2); assert.equal(state.reviews[0].next_plan_id, first.entity.id);
});

test('failed next Plan history insertion leaves no new Plan or partial review link', async t => {
  const { store, filename } = await fixture(t); const { plan } = await seeded(store);
  const review = (await store.mutate('review.create', { plan_id: plan.id, improvement: '시험 개선' })).entity;
  const direct = new DatabaseSync(filename); direct.exec("CREATE TRIGGER test_reject_next_history BEFORE INSERT ON plan_history WHEN (SELECT source_review_id FROM plans WHERE id=NEW.plan_id) IS NOT NULL BEGIN SELECT RAISE(ABORT,'next_history_failure'); END"); direct.close();
  const before = await store.state();
  await assert.rejects(store.mutate('review.next-plan', { id: review.id, ...PLAN }), error => error.status === 500);
  assert.deepEqual(await store.state(), before);
});

test('invalid inputs cannot mutate or override store-controlled fields', async t => {
  const { store } = await fixture(t); const plan = (await store.mutate('plan.create', { ...PLAN, record_origin: 'user', id: 'caller-id', source_review_id: 'fake' })).entity;
  assert.equal(plan.record_origin, 'synthetic'); assert.notEqual(plan.id, 'caller-id'); assert.equal(plan.source_review_id, null);
  const before = await store.state();
  await assert.rejects(store.mutate('plan.create', { ...PLAN, end_date: '2026-02-30' }), rejectStatus(400));
  await assert.rejects(store.mutate('task.create', { plan_id: plan.id, ...TASK, expected_minutes: -1 }), rejectStatus(400));
  await assert.rejects(store.mutate('task.create', { plan_id: plan.id, ...TASK, tags: ['x'.repeat(41)] }), rejectStatus(400));
  await assert.rejects(store.mutate('review.create', { plan_id: plan.id, improvement: '  ' }), rejectStatus(400));
  await assert.rejects(store.mutate('unknown', {}), rejectStatus(400)); assert.deepEqual(await store.state(), before);
});

test('Supabase RPC adapter keeps key server-side and controls origin on the wire', async () => {
  const calls = []; const key = 'sb_publishable_synthetic_test';
  const store = createSupabaseStore({ url: 'https://example.supabase.co', key, recordOrigin: 'user', fetchImpl: async (url, options) => { calls.push({ url, options }); return new Response(JSON.stringify({ entity: { id: 'test' }, changed: true }), { status: 200 }); } });
  assert.equal(store.kind, 'postgres'); await store.mutate('plan.create', { ...PLAN, record_origin: 'synthetic' });
  assert.equal(calls[0].options.headers.apikey, key); assert.equal(calls[0].options.headers.Authorization, undefined);
  assert.equal(JSON.parse(calls[0].options.body).p_payload.record_origin, 'user'); assert.match(calls[0].url, /\/rest\/v1\/rpc\/pds_mutate$/);
  assert.throws(() => createSupabaseStore({ url: 'https://example.supabase.co', key, recordOrigin: 'synthetic' }), error => error.status === 500);
  assert.throws(() => createSupabaseStore({ url: 'https://example.supabase.co', key: 'sb_secret_never_allowed' }), error => error.status === 500 && !error.message.includes('sb_secret'));
});

test('Supabase errors are safe and preserve the contractual conflict status', async () => {
  const store = createSupabaseStore({ url: 'https://example.supabase.co', key: 'sb_publishable_synthetic_test', fetchImpl: async () => new Response(JSON.stringify({ code: 'PT409', message: 'secret SQL details must not leak', details: 'key material' }), { status: 409 }) });
  await assert.rejects(store.mutate('plan.update', {}), error => error.status === 409 && !/secret|SQL|key material/i.test(error.message));
});

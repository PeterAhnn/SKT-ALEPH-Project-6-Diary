import { readFileSync, writeFileSync, mkdirSync, existsSync, openSync, closeSync, unlinkSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { createSqliteStore } from '../src/store-sqlite.mjs';
import { validate } from '../src/validation.mjs';
import { aggregate, seoulToday } from '../public/core.mjs';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const approvedPath = resolve(projectRoot, 'records/user-approved-recommendation.json');
const planFieldNames = ['title', 'description', 'start_date', 'end_date', 'priority', 'success_criteria', 'expected_minutes'];
const taskFieldNames = ['title', 'notes', 'due_date', 'priority', 'tags', 'expected_minutes'];
const executionFieldNames = ['started_at', 'ended_at', 'actual_minutes', 'blocked_reason'];
const pick = (record, names) => Object.fromEntries(names.map(name => [name, record[name]]));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const planMarker = records => `[승인 가져오기: ${records.recommendation_id}]`;
const taskMarker = (records, key) => `[가져오기 항목: ${records.recommendation_id}/${key}]`;
const executionMarker = (records, key) => `[가져오기 실행: ${records.recommendation_id}/${key}]`;

function validateRecommendation(records) {
  if (records.recommendation_id !== 't06-previous-coursework-20260930-v1' || records.record_origin !== 'user') throw new Error('승인된 추천 기록을 확인해 주세요.');
  if (records.tasks.length !== 7 || records.executions.length !== 3 || records.reviews.length !== 0) throw new Error('승인 범위는 할 일 7개·실측 실행 3건이며 회고는 포함하지 않습니다.');
  if (!records.plan.description.includes(planMarker(records))) throw new Error('계획 가져오기 식별 문구가 없습니다.');
  validate('plan.create', pick(records.plan, planFieldNames));
  const keys = new Set(records.tasks.map(task => task.key));
  if (keys.size !== records.tasks.length || records.tasks.reduce((sum, task) => sum + task.expected_minutes, 0) !== 300) throw new Error('할 일 식별자·승인된 예상 시간 합계를 확인해 주세요.');
  const placeholderId = '00000000-0000-4000-8000-000000000000';
  for (const task of records.tasks) {
    if (!task.notes.includes(taskMarker(records, task.key)) || !['pending', 'completed'].includes(task.status)) throw new Error('할 일의 출처 식별 문구·상태가 올바르지 않습니다.');
    validate('task.create', { plan_id: placeholderId, ...pick(task, taskFieldNames) });
  }
  if (records.tasks.filter(task => task.status === 'completed').length !== 4) throw new Error('완료 상태로 승인된 할 일은 4개입니다.');
  if (new Set(records.executions.map(execution => execution.key)).size !== records.executions.length) throw new Error('실행 식별자가 중복되었습니다.');
  for (const execution of records.executions) {
    if (!keys.has(execution.task_key) || !execution.blocked_reason.includes(executionMarker(records, execution.key))) throw new Error('실행의 할 일 연결·출처 식별 문구를 확인해 주세요.');
    if (!Number.isFinite(execution.source_duration_seconds) || Math.round(execution.source_duration_seconds / 60) !== execution.actual_minutes) throw new Error('원자료 초와 분 반올림 결과가 다릅니다.');
    if (new Date(execution.source_started_at).toISOString() !== execution.started_at || new Date(execution.source_ended_at).toISOString() !== execution.ended_at) throw new Error('원본 시각의 UTC 밀리초 정규화 결과가 다릅니다.');
    validate('execution.create', { task_id: placeholderId, ...pick(execution, executionFieldNames) });
  }
}

/** Idempotent store import; the caller supplies a local store. No network or cloud calls. */
export async function importRecommendation({ store, records, previousResult = null }) {
  validateRecommendation(records);
  const changes = { plans_created: 0, plan_revisions: 0, tasks_created: 0, completions_created: 0, executions_created: 0 };
  let state = await store.state();
  let plan = (previousResult?.recommendation_id === records.recommendation_id ? state.plans.find(item => item.id === previousResult.plan_id) : null)
    || state.plans.find(item => item.description.includes(planMarker(records)));
  if (!plan) {
    plan = (await store.mutate('plan.create', pick(records.plan, planFieldNames))).entity;
    changes.plans_created++;
  }
  // One explicit AI implementation edit: original v1 remains immutable, and later user edits are respected.
  if (plan.version === 1 && !plan.description.includes(records.plan_revision_appendix)) {
    plan = (await store.mutate('plan.update', {
      ...pick(plan, planFieldNames), id: plan.id, expected_version: plan.version,
      description: `${plan.description}\n\n${records.plan_revision_appendix}`,
    })).entity;
    changes.plan_revisions++;
  }
  const taskIds = {};
  const executionIds = {};
  for (const approvedTask of records.tasks) {
    state = await store.state();
    let task = state.tasks.find(item => item.plan_id === plan.id && (
      item.id === previousResult?.task_ids?.[approvedTask.key]
      || item.notes.includes(taskMarker(records, approvedTask.key))
    ));
    if (!task) {
      task = (await store.mutate('task.create', { plan_id: plan.id, ...pick(approvedTask, taskFieldNames) })).entity;
      changes.tasks_created++;
    }
    taskIds[approvedTask.key] = task.id;
    if (approvedTask.status === 'completed' && task.status === 'pending' && !task.deleted_at
      && !state.completion_events.some(event => event.task_id === task.id)) {
      // Current import status, not a fabricated historical button-click timestamp.
      const result = await store.mutate('task.complete', { id: task.id, request_id: randomUUID() });
      if (result.changed) changes.completions_created++;
    }
  }
  for (const approvedExecution of records.executions) {
    state = await store.state();
    const taskId = taskIds[approvedExecution.task_key];
    let execution = state.executions.find(item => item.task_id === taskId && (
      item.id === previousResult?.execution_ids?.[approvedExecution.key]
      || item.blocked_reason.includes(executionMarker(records, approvedExecution.key))
    ));
    if (!execution) {
      execution = (await store.mutate('execution.create', { task_id: taskId, ...pick(approvedExecution, executionFieldNames) })).entity;
      changes.executions_created++;
    }
    executionIds[approvedExecution.key] = execution.id;
  }
  state = await store.state();
  const values = aggregate(state, plan.id, seoulToday());
  const metrics = Object.fromEntries(Object.keys(records.baseline_expected).map(key => [key, values[key]]));
  return {
    recommendation_id: records.recommendation_id,
    imported_at: previousResult?.imported_at || new Date().toISOString(),
    checked_at: new Date().toISOString(),
    plan_id: plan.id, task_ids: taskIds, execution_ids: executionIds,
    changes, metrics,
    counts: {
      plans: state.plans.filter(item => item.id === plan.id).length,
      plan_history: state.plan_history.filter(item => item.plan_id === plan.id).length,
      tasks: Object.keys(taskIds).length,
      executions: Object.keys(executionIds).length,
      completion_events: state.completion_events.filter(item => Object.values(taskIds).includes(item.task_id)).length,
      reviews: state.reviews.filter(item => item.plan_id === plan.id).length,
    },
    source_record: {
      path: 'records/user-approved-recommendation.json',
      sha256: digest(Buffer.from(JSON.stringify(records))),
      sources: records.sources,
      execution_provenance: records.executions.map(item => pick(item, ['key', 'task_key', 'source_started_at', 'source_ended_at', 'source_duration_seconds', 'actual_minutes', 'source_refs'])),
    },
  };
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== '--db')) throw new Error('사용법: node scripts/import-recommendation.mjs [--db SQLite파일]');
  const dbFile = resolve(projectRoot, args[1] || '.data/diary.sqlite');
  const resultFile = resolve(projectRoot, '.data/approved-import-result.json');
  const lockFile = `${dbFile}.approved-import.lock`;
  const records = JSON.parse(readFileSync(approvedPath, 'utf8'));
  validateRecommendation(records);
  // Reject changed source documents before creating or changing any diary records.
  for (const source of records.sources) {
    const sourceFile = resolve(projectRoot, '..', source.path);
    if (!existsSync(sourceFile)) throw new Error(`출처 파일을 찾을 수 없습니다: ${source.path}`);
    if (digest(readFileSync(sourceFile)) !== source.sha256) throw new Error(`출처 파일이 확인 당시와 달라졌습니다: ${source.path}`);
  }
  mkdirSync(dirname(dbFile), { recursive: true });
  mkdirSync(dirname(resultFile), { recursive: true });
  let lock;
  let store;
  try {
    lock = openSync(lockFile, 'wx');
    writeFileSync(lock, String(process.pid));
    store = createSqliteStore({ filename: dbFile, recordOrigin: 'user' });
    const previous = existsSync(resultFile) ? JSON.parse(readFileSync(resultFile, 'utf8')) : null;
    const result = await importRecommendation({ store, records, previousResult: previous?.database_file === dbFile ? previous : null });
    result.database_file = dbFile;
    result.source_record.file_sha256 = digest(readFileSync(approvedPath));
    const temporary = `${resultFile}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`);
    renameSync(temporary, resultFile);
    console.log(JSON.stringify({ plan_id: result.plan_id, task_ids: result.task_ids, execution_ids: result.execution_ids, changes: result.changes, counts: result.counts, metrics: result.metrics }, null, 2));
  } finally {
    await store?.close();
    if (lock !== undefined) { closeSync(lock); unlinkSync(lockFile); }
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}

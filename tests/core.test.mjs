import test from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, selectTasks, seoulToday } from '../public/core.mjs';

// These are synthetic boundary fixtures, never the user's actual diary.
const task = (id, changes = {}) => ({
  id, plan_id: 'plan-a', title: id, notes: '', tags: [],
  due_date: null, priority: 'medium', expected_minutes: 0,
  status: 'pending', deleted_at: null, created_at: '2026-09-01T00:00:00.000Z',
  ...changes,
});
const execution = (id, taskId, actualMinutes, blockedReason = '') => ({
  id, task_id: taskId, actual_minutes: actualMinutes, blocked_reason: blockedReason,
});
const asSet = (values) => [...values].sort();

test('Seoul today changes exactly at UTC 15:00, including year rollover', () => {
  assert.equal(seoulToday(new Date('2026-09-29T14:59:59.999Z')), '2026-09-29');
  assert.equal(seoulToday(new Date('2026-09-29T15:00:00.000Z')), '2026-09-30');
  assert.equal(seoulToday(new Date('2026-12-31T15:00:00.000Z')), '2027-01-01');
});

test('See counts current nondeleted tasks, strict overdue dates and blocked tasks once', () => {
  const state = {
    plans: [{ id: 'plan-a' }, { id: 'plan-b' }],
    tasks: [
      task('overdue', { due_date: '2026-09-29', expected_minutes: 20 }),
      task('complete', { due_date: '2026-01-01', expected_minutes: 40, status: 'completed' }),
      task('today', { due_date: '2026-09-30', expected_minutes: 0 }),
      task('undated', { expected_minutes: 10 }),
      task('future', { due_date: '2026-10-01', expected_minutes: 30 }),
      task('deleted', { due_date: '2026-01-01', status: 'completed', expected_minutes: 999, deleted_at: '2026-09-30T00:00:00.000Z' }),
      task('other-plan', { plan_id: 'plan-b', due_date: '2026-01-01', expected_minutes: 999 }),
    ],
    executions: [
      execution('e1', 'overdue', 15, '환경 설정'),
      execution('e2', 'overdue', 20, '다시 확인'),
      execution('e3', 'complete', 40),
      execution('e4', 'today', 0, '  \n  '),
      execution('e5', 'undated', 30, '문서 확인'),
      execution('e-deleted', 'deleted', 999, '제외'),
      execution('e-other', 'other-plan', 999, '제외'),
      execution('e-orphan', 'missing', 999, '제외'),
    ],
    // Historical completions are deliberately larger than current completed count.
    completion_events: [{ task_id: 'complete' }, { task_id: 'complete' }, { task_id: 'overdue' }],
  };
  const before = structuredClone(state);
  const result = aggregate(state, 'plan-a', '2026-09-30');
  assert.deepEqual({
    planned: result.planned, completed: result.completed,
    overdue: result.overdue, blocked: result.blocked,
    expected_minutes: result.expected_minutes, actual_minutes: result.actual_minutes,
    delta_minutes: result.delta_minutes,
  }, {
    planned: 5, completed: 1, overdue: 1, blocked: 2,
    expected_minutes: 100, actual_minutes: 105, delta_minutes: 5,
  });
  assert.deepEqual(asSet(result.evidence.planned), ['complete', 'future', 'overdue', 'today', 'undated']);
  assert.deepEqual(result.evidence.completed, ['complete']);
  assert.deepEqual(result.evidence.overdue, ['overdue']);
  assert.deepEqual(asSet(result.evidence.blocked), ['overdue', 'undated']);
  assert.deepEqual(asSet(result.evidence.expected_minutes), asSet(result.evidence.planned));
  assert.deepEqual(asSet(result.evidence.actual_minutes), ['e1', 'e2', 'e3', 'e4', 'e5']);
  assert.deepEqual(asSet(result.evidence.delta_minutes), asSet(result.evidence.planned));
  assert.deepEqual(state, before, 'aggregation must not mutate saved records');
});

test('See empty sums are zero and delta can be negative', () => {
  const empty = aggregate({ tasks: [], executions: [] }, 'missing', '2026-09-30');
  for (const key of ['planned', 'completed', 'overdue', 'blocked', 'expected_minutes', 'actual_minutes', 'delta_minutes']) {
    assert.equal(empty[key], 0, key);
    assert.deepEqual(empty.evidence[key], [], key);
  }
  const result = aggregate({ tasks: [task('t', { expected_minutes: 25 })], executions: [] }, 'plan-a', '2026-09-30');
  assert.equal(result.delta_minutes, -25);
  assert.equal(result.actual_minutes, 0);
});

test('search covers title, notes and tags while every filter retains selected plan scope', () => {
  const tasks = [
    task('title', { title: 'ALEPH 공부', priority: 'high', tags: ['공부'] }),
    task('notes', { notes: 'ALEPH 과제 설명 읽기', priority: 'high', tags: ['공부'] }),
    task('tag', { tags: ['ALEPH', '공부'], priority: 'low', status: 'completed' }),
    task('unrelated', { title: '다른 일', priority: 'high', tags: ['공부'] }),
    task('deleted', { title: 'ALEPH 공부', priority: 'high', tags: ['공부'], deleted_at: '2026-09-30T00:00:00.000Z' }),
    task('foreign', { plan_id: 'plan-b', title: 'ALEPH 공부', priority: 'high', tags: ['공부'] }),
  ];
  const before = structuredClone(tasks);
  assert.deepEqual(asSet(selectTasks(tasks, { planId: 'plan-a', search: 'aleph' }).map((t) => t.id)), ['notes', 'tag', 'title']);
  assert.deepEqual(asSet(selectTasks(tasks, {
    planId: 'plan-a', search: 'aleph', priority: 'high', status: 'pending', tag: '공부',
  }).map((t) => t.id)), ['notes', 'title']);
  assert.deepEqual(selectTasks(tasks, { planId: 'plan-a', status: 'completed', tag: 'ALEPH' }).map((t) => t.id), ['tag']);
  assert.deepEqual(tasks, before, 'filtering and sorting must not reorder the source array');
});

test('due and priority sorts use documented tie rules rather than input order', () => {
  const tasks = [
    task('b', { due_date: '2026-09-30', priority: 'high' }),
    task('a', { due_date: '2026-09-30', priority: 'high' }),
    task('older', { due_date: '2026-09-30', priority: 'high', created_at: '2026-08-31T23:59:59.000Z' }),
    task('medium', { due_date: '2026-09-30', priority: 'medium' }),
    task('early-low', { due_date: '2026-09-29', priority: 'low' }),
    task('no-date-high', { priority: 'high' }),
  ];
  const ids = (sort, input = tasks) => selectTasks(input, { planId: 'plan-a', sort }).map((t) => t.id);
  assert.deepEqual(ids('due'), ['early-low', 'older', 'a', 'b', 'medium', 'no-date-high']);
  assert.deepEqual(ids('priority'), ['older', 'a', 'b', 'no-date-high', 'medium', 'early-low']);
  for (const sort of ['due', 'priority']) {
    assert.deepEqual(ids(sort, [...tasks].reverse()), ids(sort), `${sort}: reversed input must preserve ties`);
  }
});

test('created sort is descending with ID tie-break, and leaves deleted tasks excluded', () => {
  const tasks = [
    task('b'), task('a'),
    task('newest', { created_at: '2026-09-30T00:00:00.000Z' }),
    task('older', { created_at: '2026-08-01T00:00:00.000Z' }),
    task('deleted', { created_at: '2026-10-01T00:00:00.000Z', deleted_at: '2026-10-01T00:00:00.000Z' }),
  ];
  assert.deepEqual(selectTasks(tasks, { planId: 'plan-a', sort: 'created' }).map((t) => t.id), ['newest', 'a', 'b', 'older']);
});

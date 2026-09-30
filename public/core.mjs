const priorityRank = { high: 0, medium: 1, low: 2 };
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;

export function seoulToday(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(date);
  const part = type => parts.find(p => p.type === type).value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function aggregate(state, planId, today = seoulToday()) {
  const tasks = state.tasks.filter(t => t.plan_id === planId && !t.deleted_at);
  const ids = new Set(tasks.map(t => t.id));
  const executions = state.executions.filter(e => ids.has(e.task_id));
  const blocked = new Set(executions.filter(e => e.blocked_reason.trim()).map(e => e.task_id));
  const evidence = {
    planned: tasks.map(t => t.id),
    completed: tasks.filter(t => t.status === 'completed').map(t => t.id),
    overdue: tasks.filter(t => t.status !== 'completed' && t.due_date && t.due_date < today).map(t => t.id),
    blocked: tasks.filter(t => blocked.has(t.id)).map(t => t.id),
    expected_minutes: tasks.map(t => t.id),
    actual_minutes: executions.map(e => e.id),
    delta_minutes: tasks.map(t => t.id)
  };
  const expected = tasks.reduce((sum, t) => sum + t.expected_minutes, 0);
  const actual = executions.reduce((sum, e) => sum + e.actual_minutes, 0);
  return { planned: tasks.length, completed: evidence.completed.length, overdue: evidence.overdue.length,
    blocked: evidence.blocked.length, expected_minutes: expected, actual_minutes: actual, delta_minutes: actual - expected, evidence };
}

export function selectTasks(tasks, { planId, search = '', status = 'all', priority = 'all', tag = '', sort = 'due' }) {
  const query = search.trim().toLocaleLowerCase('ko-KR');
  const due = (a, b) => compare(a.due_date || '9999-99-99', b.due_date || '9999-99-99');
  const rank = (a, b) => priorityRank[a.priority] - priorityRank[b.priority];
  const stable = (a, b) => compare(a.created_at, b.created_at) || compare(a.id, b.id);
  return tasks.filter(t => t.plan_id === planId && !t.deleted_at)
    .filter(t => !query || [t.title, t.notes, ...t.tags].join('\n').toLocaleLowerCase('ko-KR').includes(query))
    .filter(t => status === 'all' || t.status === status)
    .filter(t => priority === 'all' || t.priority === priority)
    .filter(t => !tag || t.tags.includes(tag))
    .sort((a, b) => sort === 'created' ? compare(b.created_at, a.created_at) || compare(a.id, b.id)
      : sort === 'priority' ? rank(a, b) || due(a, b) || stable(a, b)
        : due(a, b) || rank(a, b) || stable(a, b));
}

export function problem(status, message, code) {
  return Object.assign(new Error(message), { status, code });
}
const bad = message => { throw problem(400, message, 'VALIDATION'); };
function text(value, field, max, required = false) {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) bad(`${field}을(를) ${required ? '비어 있지 않은 ' : ''}${max}자 이하의 글로 입력해 주세요.`);
  return value;
}
function integer(value, field, min = 0) {
  if (!Number.isSafeInteger(value) || value < min || value > 1000000) bad(`${field}은(는) ${min}~1,000,000 사이 정수여야 합니다.`);
  return value;
}
function date(value, field, optional = false) {
  if (optional && (value === null || value === '')) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) bad(`${field}을(를) YYYY-MM-DD 날짜로 입력해 주세요.`);
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) bad(`${field}의 날짜가 유효하지 않습니다.`);
  return value;
}
function timestamp(value, field) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)) bad(`${field}에 시간대가 포함된 시각을 입력해 주세요.`);
  date(value.slice(0, 10), field);
  const clockParts = value.slice(11).match(/^(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (Number(clockParts[1]) > 23 || Number(clockParts[2]) > 59 || Number(clockParts[3] || 0) > 59) bad(`${field}의 시각이 유효하지 않습니다.`);
  const offset = value.match(/[+-](\d{2}):(\d{2})$/);
  if (offset && (Number(offset[1]) > 23 || Number(offset[2]) > 59)) bad(`${field}의 시간대가 유효하지 않습니다.`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) bad(`${field}의 시각이 유효하지 않습니다.`);
  return parsed.toISOString();
}
function uuid(value, field = '기록 ID') {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) bad(`${field}이(가) 유효하지 않습니다.`);
  return value.toLowerCase();
}
function priority(value) {
  if (!['high', 'medium', 'low'].includes(value)) bad('우선순위를 높음·보통·낮음 중 선택해 주세요.');
  return value;
}
const planFields = ['title', 'description', 'start_date', 'end_date', 'priority', 'success_criteria', 'expected_minutes'];
const taskFields = ['title', 'notes', 'due_date', 'priority', 'tags', 'expected_minutes'];
const allowed = {
  'plan.create': planFields, 'plan.update': ['id', 'expected_version', ...planFields],
  'task.create': ['plan_id', ...taskFields], 'task.update': ['id', 'expected_version', ...taskFields],
  'task.complete': ['id', 'request_id'], 'task.reopen': ['id', 'request_id'], 'task.delete': ['id'], 'task.restore': ['id'],
  'execution.create': ['task_id', 'started_at', 'ended_at', 'actual_minutes', 'blocked_reason'],
  'review.create': ['plan_id', 'improvement'], 'review.next-plan': ['id', ...planFields]
};
export function validate(action, input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) bad('입력 형식은 JSON 객체여야 합니다.');
  const keys = allowed[action];
  if (!keys) bad('지원하지 않는 작업입니다.');
  if (Object.keys(input).some(k => !keys.includes(k))) bad('허용되지 않은 입력 항목이 있습니다.');
  const p = {};
  for (const key of ['id', 'plan_id', 'task_id', 'request_id']) if (keys.includes(key)) p[key] = uuid(input[key], key === 'request_id' ? '요청 ID' : '기록 ID');
  if (keys.includes('expected_version')) p.expected_version = integer(input.expected_version, '기록 버전', 1);
  if (keys.includes('success_criteria')) {
    p.title = text(input.title, '계획 제목', 160, true);
    p.description = text(input.description ?? '', '계획 설명', 4000);
    p.start_date = date(input.start_date, '시작일');
    p.end_date = date(input.end_date, '종료일');
    if (p.start_date > p.end_date) bad('종료일은 시작일보다 앞설 수 없습니다.');
    p.priority = priority(input.priority ?? 'medium');
    p.success_criteria = text(input.success_criteria, '성공 기준', 2000, true);
    p.expected_minutes = integer(input.expected_minutes, '예상 시간');
  } else if (keys.includes('tags')) {
    p.title = text(input.title, '할 일 제목', 160, true);
    p.notes = text(input.notes ?? '', '할 일 메모', 4000);
    p.due_date = date(input.due_date ?? null, '마감일', true);
    p.priority = priority(input.priority ?? 'medium');
    if (!Array.isArray(input.tags ?? []) || (input.tags ?? []).length > 20) bad('태그는 최대 20개까지 입력할 수 있습니다.');
    p.tags = [...new Set((input.tags ?? []).map(t => text(t, '태그', 40, true)))];
    p.expected_minutes = integer(input.expected_minutes, '예상 시간');
  } else if (keys.includes('actual_minutes')) {
    p.started_at = timestamp(input.started_at, '시작 시각');
    p.ended_at = timestamp(input.ended_at, '종료 시각');
    if (p.ended_at < p.started_at) bad('종료 시각은 시작 시각보다 앞설 수 없습니다.');
    p.actual_minutes = integer(input.actual_minutes, '실제 시간');
    p.blocked_reason = text(input.blocked_reason ?? '', '막힌 이유', 4000);
  } else if (keys.includes('improvement')) p.improvement = text(input.improvement, '다음 계획에 반영할 개선', 2000, true);
  return p;
}

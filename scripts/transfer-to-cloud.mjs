// Approved records only. Prepare bounded DML, apply through the Supabase connector,
// then verify. This script never writes the SQLite database or reads API keys.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const tables = ['plans', 'plan_history', 'tasks', 'executions', 'completion_events', 'request_receipts', 'reviews'];
const localURL = 'http://127.0.0.1:8006';
const cloudURL = 'http://127.0.0.1:8008';
const jsonFields = { tasks: ['tags', 'tags_json'], plan_history: ['snapshot', 'snapshot_json'], request_receipts: ['response', 'response_json'] };
const sqlFile = resolve(root, '.data', 'cloud-transfer.sql');
const evidenceFile = resolve(root, 'verification', 'cloud-transfer.json');
const maxRowsPerTable = 5000;
const maxJSONBytes = 1024 * 1024;

const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const counts = state => Object.fromEntries(tables.map(table => [table, state[table].length]));
const quote = value => `'${value.replaceAll("'", "''")}'`;
const isEmpty = state => tables.every(table => state[table].length === 0);
const isEqual = (left, right) => { try { assert.deepStrictEqual(left, right); return true; } catch { return false; } };

async function readJSON(base, path) {
  const response = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(20000) });
  if (!response.ok) throw new Error(`서버 읽기를 완료하지 못했습니다 (${response.status}).`);
  return response.json();
}
function validateState(state) {
  assert.deepStrictEqual(Object.keys(state).sort(), [...tables].sort(), 'state table set must match exactly');
  for (const table of tables) {
    assert.ok(Array.isArray(state[table]) && state[table].length <= maxRowsPerTable, `${table} row limit`);
    for (const row of state[table]) {
      assert.ok(row && typeof row === 'object' && !Array.isArray(row), `${table} row object`);
      if ('record_origin' in row) assert.equal(row.record_origin, 'user', `${table}: synthetic records cannot be transferred`);
    }
  }
  const encoded = JSON.stringify(state);
  assert.ok(Buffer.byteLength(encoded) <= maxJSONBytes, 'transfer size limit');
  assert.ok(!encoded.includes('\\u0000'), 'PostgreSQL JSON does not allow U+0000');
}
async function readSources() {
  const [local, cloud] = await Promise.all([readJSON(localURL, '/api/state'), readJSON(cloudURL, '/api/state')]);
  assert.equal(local.ok, true); assert.equal(cloud.ok, true);
  assert.equal(local.meta.storage, 'sqlite'); assert.equal(cloud.meta.storage, 'postgres');
  for (const meta of [local.meta, cloud.meta]) {
    assert.equal(meta.timezone, 'Asia/Seoul'); assert.equal(meta.time_unit, 'minutes');
    assert.equal(meta.record_origin, 'user'); assert.equal(meta.authentication, false);
  }
  validateState(local.data); validateState(cloud.data);
  assert.ok(local.data.plans.length > 0, 'approved source records must exist');
  return { local, cloud };
}
function readColumns() {
  const filename = resolve(root, '.data', 'diary.sqlite');
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    return Object.fromEntries(tables.map(table => {
      const fields = db.prepare(`PRAGMA table_info(${table})`).all().map(field => field.name);
      assert.ok(fields.length > 0, `${table}: actual SQLite table must exist`);
      return [table, fields];
    }));
  } finally { db.close(); }
}
function toRows(state, columns) {
  return Object.fromEntries(tables.map(table => [table, state[table].map(apiRow => {
    const row = { ...apiRow };
    if (jsonFields[table]) {
      const [apiKey, databaseKey] = jsonFields[table];
      assert.ok(Object.hasOwn(row, apiKey), `${table}: ${apiKey} required`);
      row[databaseKey] = JSON.stringify(row[apiKey]);
      delete row[apiKey];
    }
    assert.deepStrictEqual(Object.keys(row).sort(), [...columns[table]].sort(), `${table}: all actual DB fields must match`);
    return row;
  })]));
}
function createSQL(rows, columns) {
  const schemaChecks = tables.map(table => `  IF (SELECT array_agg(column_name::text ORDER BY column_name) FROM information_schema.columns WHERE table_schema='public' AND table_name=${quote(table)}) IS DISTINCT FROM ARRAY[${[...columns[table]].sort().map(quote).join(',')}]::text[] THEN RAISE EXCEPTION 'cloud schema mismatch: ${table}'; END IF;`);
  const emptyChecks = tables.map(table => `  IF EXISTS (SELECT 1 FROM public.${table}) THEN RAISE EXCEPTION 'cloud destination is not empty: ${table}'; END IF;`);
  const statements = tables.filter(table => rows[table].length > 0).map(table => {
    // Break only the import-time Plan -> Review cycle; restore after Reviews exist.
    const payload = table === 'plans' ? rows.plans.map(row => ({ ...row, source_review_id: null })) : rows[table];
    const fields = columns[table].join(',');
    return `INSERT INTO public.${table} (${fields}) SELECT ${fields} FROM jsonb_populate_recordset(NULL::public.${table}, ${quote(JSON.stringify(payload))}::jsonb);`;
  });
  const linkedPlans = rows.plans.filter(row => row.source_review_id !== null).map(row => ({ id: row.id, source_review_id: row.source_review_id }));
  if (linkedPlans.length > 0) {
    statements.push(`UPDATE public.plans AS destination SET source_review_id=source.source_review_id FROM jsonb_to_recordset(${quote(JSON.stringify(linkedPlans))}::jsonb) AS source(id text,source_review_id text) WHERE destination.id=source.id;`);
  }
  return [
    '-- Approved record transfer. Aborts on any existing destination records.',
    'BEGIN;', "SET LOCAL standard_conforming_strings = on;", "SET LOCAL lock_timeout = '15s';",
    `LOCK TABLE ${tables.map(table => `public.${table}`).join(',')} IN ACCESS EXCLUSIVE MODE;`,
    'DO $transfer_guard$ BEGIN', ...schemaChecks, ...emptyChecks, 'END $transfer_guard$;',
    ...statements, 'COMMIT;', '',
  ].join('\n');
}
async function prepare() {
  const { local, cloud } = await readSources();
  if (isEqual(local.data, cloud.data)) {
    console.log(JSON.stringify({ status: 'already_matches', counts: counts(local.data), state_sha256: hash(local.data), sql_required: false }));
    return;
  }
  if (!isEmpty(cloud.data)) throw new Error('기존 클라우드 자료가 원자료와 다릅니다. 모든 자료를 보존하고 이전을 중단합니다.');
  await stat(resolve(root, '.data', 'diary.sqlite'));
  const columns = readColumns();
  const sql = createSQL(toRows(local.data, columns), columns);
  assert.ok(Buffer.byteLength(sql) <= maxJSONBytes * 2, 'bounded SQL transfer');
  await writeFile(sqlFile, sql, { encoding: 'utf8', mode: 0o600 });
  console.log(JSON.stringify({ status: 'prepared', counts: counts(local.data), state_sha256: hash(local.data), sql_sha256: createHash('sha256').update(sql).digest('hex'), sql_bytes: Buffer.byteLength(sql), sql_required: true }));
}
async function verify() {
  const { local, cloud } = await readSources();
  assert.deepStrictEqual(cloud.data, local.data, 'all seven state arrays and every field must match');
  const [localExport, cloudExport] = await Promise.all([readJSON(localURL, '/api/export'), readJSON(cloudURL, '/api/export')]);
  const exportFields = exportData => Object.fromEntries(Object.entries(exportData).filter(([key]) => key !== 'exported_at'));
  assert.deepStrictEqual(exportFields(cloudExport), exportFields(localExport), 'whole-file data and units must match');
  for (const table of tables) assert.deepStrictEqual(cloudExport[table], cloud.data[table], `${table}: export and stored records match`);
  const evidence = {
    checked_at: new Date().toISOString(), status: 'passed', project_id: 'yynsaokvquggrbdrmalr',
    source_storage: 'sqlite', destination_storage: 'postgres', record_origin: 'user',
    counts: counts(local.data), state_sha256: hash(local.data), cloud_state_sha256: hash(cloud.data),
    export_data_sha256: hash(exportFields(localExport)), cloud_export_data_sha256: hash(exportFields(cloudExport)),
    checks: {
      seven_tables_equal: true, all_ids_dates_values_versions_equal: true,
      export_data_equal_excluding_exported_at: true, timezone_equal: true, time_unit_equal: true,
      authentication_false: true, existing_records_not_overwritten: true,
    },
  };
  await mkdir(dirname(evidenceFile), { recursive: true });
  await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, 'utf8');
  console.log(JSON.stringify(evidence));
}

const action = process.argv[2];
try {
  if (action === 'prepare') await prepare();
  else if (action === 'verify') await verify();
  else throw new Error('사용법: node scripts/transfer-to-cloud.mjs prepare | verify');
} catch (error) {
  // Assertion details can contain full records; do not dump them or credentials.
  console.error(JSON.stringify({ status: 'failed', reason: error instanceof assert.AssertionError ? '원자료·스키마·이전 결과의 동일성 검사가 실패했습니다.' : error.message }));
  process.exitCode = 1;
}

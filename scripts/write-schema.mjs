import { DatabaseSync } from 'node:sqlite';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const filename = resolve(projectRoot, process.env.DIARY_DB_PATH || '.data/diary.sqlite');
const contractPath = resolve(projectRoot, 'contracts/pds-schema-v2.json');
const catalogPath = resolve(projectRoot, 'verification/postgres-catalog.json');
const expectedNames = ['completion_events', 'executions', 'plan_history', 'plans', 'request_receipts', 'reviews', 'tasks'];
const generatedAt = new Date().toISOString();
const quoted = name => '"' + name.replaceAll('"', '""') + '"';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

if (!existsSync(filename)) throw new Error('Initialize the local SQLite DB by starting the diary server before writing its schema contract.');
const db = new DatabaseSync(filename, { readOnly: true });
let localTables, localTriggers;
try {
  const names = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(row => row.name);
  if (JSON.stringify(names) !== JSON.stringify(expectedNames)) throw new Error('Local SQLite table names differ from the seven T06 tables.');
  localTables = names.map(name => {
    const indexes = db.prepare('PRAGMA index_list(' + quoted(name) + ')').all().map(row => ({
      name: row.name, unique: !!row.unique, origin: row.origin, partial: !!row.partial,
      fields: db.prepare('PRAGMA index_info(' + quoted(row.name) + ')').all().map(field => field.name),
    }));
    return {
      name,
      fields: db.prepare('PRAGMA table_info(' + quoted(name) + ')').all().map(row => ({
        name: row.name, type: row.type, nullable: !row.notnull && !row.pk,
        primary_key: !!row.pk, default: row.dflt_value, ordinal_position: row.cid + 1,
      })),
      foreign_keys: db.prepare('PRAGMA foreign_key_list(' + quoted(name) + ')').all().map(row => ({
        field: row.from, references: { table: row.table, field: row.to },
        on_delete: row.on_delete, on_update: row.on_update,
      })),
      indexes, unique_indexes: indexes.filter(index => index.unique),
      create_sql: db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name).sql,
    };
  });
  localTriggers = db.prepare("SELECT name,tbl_name AS table_name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name").all();
} finally { db.close(); }

const previous = existsSync(contractPath) ? JSON.parse(await readFile(contractPath, 'utf8')) : {};
let catalog = null, catalogBytes = null;
if (existsSync(catalogPath)) {
  catalogBytes = await readFile(catalogPath);
  catalog = JSON.parse(catalogBytes);
  if (catalog.engine !== 'PostgreSQL' || catalog.project_id !== 'yynsaokvquggrbdrmalr' || !Number.isFinite(Date.parse(catalog.introspected_at))) throw new Error('Saved production catalog identity or verification timestamp is invalid.');
  const actualNames = catalog.tables.map(table => table.name).sort();
  if (JSON.stringify(actualNames) !== JSON.stringify(expectedNames)
    || JSON.stringify([...catalog.public_table_names].sort()) !== JSON.stringify(expectedNames)) throw new Error('Saved production PostgreSQL does not contain exactly the seven T06 public tables.');
  for (const table of catalog.tables) {
    const local = localTables.find(item => item.name === table.name);
    const postgresFields = table.fields.map(field => field.name);
    const sqliteFields = local.fields.map(field => field.name);
    if (JSON.stringify(postgresFields) !== JSON.stringify(sqliteFields)) throw new Error('PostgreSQL/SQLite field-name mismatch in table ' + table.name + '. The previous contract was retained.');
    if (!table.rls_enabled) throw new Error('Saved production RLS is not enabled for ' + table.name);
    if (table.indexes.some(index => !index.valid || !index.ready)) throw new Error('Saved production index is not valid/ready for ' + table.name);
  }
  if (catalog.functions.some(fn => fn.security_definer || fn.security_mode !== 'INVOKER')) throw new Error('Saved production pds_* function is not SECURITY INVOKER.');
  if (!['pds_state', 'pds_mutate'].every(name => catalog.functions.some(fn => fn.name === name))) throw new Error('Saved production catalog is missing an application RPC.');
}

const tables = catalog ? catalog.tables.map(table => ({
  ...table,
  primary_key: table.constraints.find(constraint => constraint.type === 'PRIMARY KEY'),
  foreign_keys: table.constraints.filter(constraint => constraint.type === 'FOREIGN KEY').map(constraint => ({
    name: constraint.name, fields: constraint.fields,
    ...(constraint.fields.length === 1 ? { field: constraint.fields[0] } : {}),
    references: {
      ...constraint.references,
      ...(constraint.references.fields.length === 1 ? { field: constraint.references.fields[0] } : {}),
    },
    on_delete: constraint.on_delete, on_update: constraint.on_update,
    deferrable: constraint.deferrable, initially_deferred: constraint.initially_deferred,
  })),
  checks: table.constraints.filter(constraint => constraint.type === 'CHECK'),
  unique_indexes: table.indexes.filter(index => index.unique),
})) : localTables;
const fieldCount = tables.reduce((count, table) => count + table.fields.length, 0);
const schema = {
  schema_version: 2, task: 'T06', generated_at: generatedAt,
  actual_database: catalog ? {
    engine: 'PostgreSQL', role: 'production', project_id: catalog.project_id, schema: 'public',
    source: 'Actual Supabase pg_catalog and pg_policies metadata saved in verification/postgres-catalog.json',
    introspected_at: catalog.introspected_at,
    snapshot_sha256: sha256(catalogBytes),
    verification_mode: 'Saved actual cloud snapshot; rerunning this generator does not query or reverify the live cloud',
    verified_table_count: tables.length, verified_field_count: fieldCount,
  } : {
    engine: 'SQLite', role: 'local', source: 'Read-only PRAGMA introspection of initialized disk DB',
    introspected_at: generatedAt, verified_table_count: tables.length, verified_field_count: fieldCount,
  },
  local_database: {
    engine: 'SQLite', role: 'local development and isolated synthetic QA',
    source: 'Read-only PRAGMA introspection of initialized disk DB selected by DIARY_DB_PATH',
    introspected_at: generatedAt, verified_table_count: localTables.length,
    verified_field_count: localTables.reduce((count, table) => count + table.fields.length, 0),
  },
  authentication: false,
  public_data_notice: '지금은 로그인이 없어 링크를 아는 사람은 누구나 볼 수 있습니다. 남이 봐도 괜찮은 내용만 넣으세요',
  tables, triggers: catalog ? catalog.triggers : localTriggers,
  ...(catalog ? { functions: catalog.functions } : {}),
  local_sqlite_tables: localTables, local_sqlite_triggers: localTriggers,
  ...(catalog ? { field_name_match: {
    status: 'matched', tables: tables.length, fields: fieldCount,
    checked_at: generatedAt, postgres_snapshot_at: catalog.introspected_at,
    scope: 'Exact ordered database field names; engine-specific defaults, constraints, indexes and triggers remain separately recorded',
  } } : {}),
  representations: {
    ...previous.representations,
    database: 'tags_json, snapshot_json, response_json are JSON text; production columns use PostgreSQL text/integer, local columns use SQLite TEXT/INTEGER',
    api: 'tags array, snapshot object, response object; IDs/dates/numeric values retained',
    record_origin: 'Production CHECK constraints allow user records only; local SQLite also allows synthetic records in isolated QA databases',
  },
  date_rules: {
    ...previous.date_rules,
    dates: 'YYYY-MM-DD strings representing real calendar dates',
    timestamps: 'UTC ISO 8601 YYYY-MM-DDTHH:mm:ss.sssZ strings',
    storage: 'Production PostgreSQL text and local SQLite TEXT, not native DATE or timestamp columns',
    calendar_validation: 'src/validation.mjs validates calendar dates before API writes; production pds_date validates dates inside pds_mutate RPC. Table CHECK constraints retain date pattern/order rules.',
    displayed_timezone: 'Asia/Seoul',
    overdue: 'nondeleted, pending task due_date strictly before Asia/Seoul today',
    period_scope: 'all nondeleted tasks linked to selected Plan; label is Plan start/end period',
  },
  time_rules: {
    ...previous.time_rules,
    unit: 'minutes', representation: 'integer 0..1000000 per record',
    expected: 'sum selected Plan active task expected_minutes',
    actual: 'sum executions linked to selected Plan active tasks',
    delta: 'actual - expected', empty_sum: 0,
    manual_actual_duration: 'may differ from clock interval; imported second measurements must document rounding',
  },
  integrity_rules: {
    ...previous.integrity_rules,
    plan_history: 'initial and every subsequent version retained; update/delete rejected by immutable-history triggers',
    completions: 'unique(task_id,cycle), unique(request_id), transactional receipt replay',
    task_deletion: 'soft delete; existing executions/events retained; excluded from See',
    next_plan: 'unique source_review_id; improvement and source relation carried transactionally',
  },
  postgres: catalog ? {
    status: 'Actual production schema introspected and recorded',
    project_id: catalog.project_id, catalog: 'verification/postgres-catalog.json',
    checked_at: catalog.introspected_at,
    snapshot_reuse: 'Schema generation retains this verification timestamp; live cloud must be re-introspected explicitly for a newer check',
    bootstrap: 'db/postgres.sql', adapter: 'src/store-supabase.mjs',
    rpc: ['pds_state()', 'pds_mutate(text,jsonb)'],
    access: 'T06 dedicated public-safe DB; actual RLS policies and invoker settings recorded above. Publishable key held on server; no service-role key.',
  } : {
    status: 'Production PostgreSQL catalog is not verified in this checkout; actual local SQLite metadata is recorded',
    bootstrap: 'db/postgres.sql', adapter: 'src/store-supabase.mjs',
    rpc: ['pds_state()', 'pds_mutate(text,jsonb)'],
  },
};
await mkdir(resolve(projectRoot, 'contracts'), { recursive: true });
await writeFile(contractPath, JSON.stringify(schema, null, 2) + '\n');
console.log('Wrote ' + schema.actual_database.engine + ' schema: ' + tables.length + ' tables, ' + fieldCount + ' fields.');
if (catalog) console.log('Retained actual cloud snapshot checked at ' + catalog.introspected_at + '; current local SQLite field names match.');

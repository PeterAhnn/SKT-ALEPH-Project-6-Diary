-- Real PostgreSQL checks. All synthetic fixtures are isolated by fresh UUIDs.
-- No permanent DDL, and every temporary record is ROLLBACKed.
BEGIN;
SET TRANSACTION ISOLATION LEVEL REPEATABLE READ;
SET LOCAL ROLE anon;
DO $verify$
DECLARE
  base jsonb:=public.pds_state(); after_state jsonb; r jsonb; r2 jsonb; saved jsonb;
  plan_input jsonb:=jsonb_build_object('title','합성 PostgreSQL 검증 — 롤백','description','실제 사용자 기록이 아닌 일회성 검사','start_date','2026-09-30','end_date','2026-10-02','priority','medium','success_criteria','검사 후 모두 롤백','expected_minutes',60);
  task_input jsonb:=jsonb_build_object('title','합성 검증 할 일','notes','롤백 전용','due_date','2026-09-29','priority','high','tags',jsonb_build_array('시험','롤백'),'expected_minutes',20);
  p1 text; p2 text; t1 text; t2 text; review_id text;
  q1 text:=gen_random_uuid()::text; q2 text:=gen_random_uuid()::text; q3 text:=gen_random_uuid()::text; q4 text:=gen_random_uuid()::text;
  rejected boolean; n integer; k text; field text; remove_ids text[]; filtered jsonb;
  checks text[]:=ARRAY[]::text[];
BEGIN
  IF current_user<>'anon' THEN RAISE EXCEPTION 'verification_role_not_anon'; END IF;
  checks:=array_append(checks,'anon-role');

  r:=public.pds_mutate('plan.create',plan_input); p1:=r->'entity'->>'id';
  IF NOT (r->>'changed')::boolean OR (r->'entity'->>'version')::integer<>1 OR r->'entity'->>'record_origin'<>'user' THEN RAISE EXCEPTION 'plan_create_contract'; END IF;
  SELECT count(*) INTO n FROM public.plan_history WHERE plan_id=p1;
  IF n<>1 THEN RAISE EXCEPTION 'initial_history_count'; END IF;
  checks:=array_append(checks,'initial-plan-and-history');
  PERFORM set_config('pds.verify_plan_id',p1,true);

  r:=public.pds_mutate('plan.update',plan_input||jsonb_build_object('id',p1,'expected_version',1,'title','수정한 합성 계획 — 롤백'));
  IF r->'entity'->>'id'<>p1 OR (r->'entity'->>'version')::integer<>2 THEN RAISE EXCEPTION 'plan_update_version'; END IF;
  IF (SELECT count(*) FROM public.plan_history WHERE plan_id=p1)<>2 OR (SELECT snapshot_json::jsonb->>'title' FROM public.plan_history WHERE plan_id=p1 AND version=1)<>plan_input->>'title' THEN RAISE EXCEPTION 'history_snapshot_changed'; END IF;
  checks:=array_append(checks,'same-id-immutable-snapshots');
  rejected:=false;
  BEGIN PERFORM public.pds_mutate('plan.update',plan_input||jsonb_build_object('id',p1,'expected_version',1)); EXCEPTION WHEN SQLSTATE 'PT409' THEN rejected:=true; END;
  IF NOT rejected OR (SELECT version FROM public.plans WHERE id=p1)<>2 OR (SELECT count(*) FROM public.plan_history WHERE plan_id=p1)<>2 THEN RAISE EXCEPTION 'optimistic_conflict_not_atomic'; END IF;
  checks:=array_append(checks,'optimistic-plan-conflict');

  r:=public.pds_mutate('task.create',task_input||jsonb_build_object('plan_id',p1)); t1:=r->'entity'->>'id';
  IF r->'entity'->'tags'<>task_input->'tags' OR r->'entity'->>'status'<>'pending' THEN RAISE EXCEPTION 'task_create_contract'; END IF;
  checks:=array_append(checks,'parsed-task-tags');
  r:=public.pds_mutate('task.update',task_input||jsonb_build_object('id',t1,'expected_version',1,'expected_minutes',30));
  rejected:=false;
  BEGIN PERFORM public.pds_mutate('task.update',task_input||jsonb_build_object('id',t1,'expected_version',1)); EXCEPTION WHEN SQLSTATE 'PT409' THEN rejected:=true; END;
  IF NOT rejected OR (SELECT version FROM public.tasks WHERE id=t1)<>2 OR (SELECT expected_minutes FROM public.tasks WHERE id=t1)<>30 THEN RAISE EXCEPTION 'optimistic_task_conflict'; END IF;
  checks:=array_append(checks,'optimistic-task-conflict');

  SELECT to_jsonb(x) INTO saved FROM public.plans x WHERE id=p1;
  r:=public.pds_mutate('execution.create',jsonb_build_object('task_id',t1,'started_at','2026-09-30T00:00:00.000Z','ended_at','2026-09-30T00:25:00.000Z','actual_minutes',25,'blocked_reason','합성 막힘 — 롤백'));
  IF r->'entity'->>'started_at'<>'2026-09-30T00:00:00.000Z' OR (SELECT to_jsonb(x) FROM public.plans x WHERE id=p1)<>saved OR (SELECT expected_minutes FROM public.tasks WHERE id=t1)<>30 OR (SELECT status FROM public.tasks WHERE id=t1)<>'pending' THEN RAISE EXCEPTION 'execution_overwrote_plan_or_task'; END IF;
  checks:=array_append(checks,'separate-utc-execution');

  r:=public.pds_mutate('task.complete',jsonb_build_object('id',t1,'request_id',q1)); saved:=r;
  r2:=public.pds_mutate('task.complete',jsonb_build_object('id',t1,'request_id',q1));
  IF NOT (r2->>'replayed')::boolean OR (r2-'replayed')<>saved THEN RAISE EXCEPTION 'completion_receipt_replay'; END IF;
  r2:=public.pds_mutate('task.complete',jsonb_build_object('id',t1,'request_id',q2));
  IF (r2->>'changed')::boolean OR (SELECT count(*) FROM public.completion_events WHERE task_id=t1)<>1 OR (SELECT count(*) FROM public.tasks WHERE id=t1 AND status='completed')<>1 THEN RAISE EXCEPTION 'double_completion_not_one'; END IF;
  checks:=array_append(checks,'double-completion-one-event-plus-one-count');

  r:=public.pds_mutate('task.reopen',jsonb_build_object('id',t1,'request_id',q3));
  r2:=public.pds_mutate('task.reopen',jsonb_build_object('id',t1,'request_id',q3));
  IF NOT (r2->>'replayed')::boolean OR (SELECT status FROM public.tasks WHERE id=t1)<>'pending' OR (SELECT completion_cycle FROM public.tasks WHERE id=t1)<>1 THEN RAISE EXCEPTION 'reopen_cycle_replay'; END IF;
  checks:=array_append(checks,'reopen-cycle-once');
  r2:=public.pds_mutate('task.complete',jsonb_build_object('id',t1,'request_id',q1));
  IF (r2-'replayed')<>saved OR (SELECT status FROM public.tasks WHERE id=t1)<>'pending' OR (SELECT count(*) FROM public.completion_events WHERE task_id=t1)<>1 THEN RAISE EXCEPTION 'old_receipt_changed_new_cycle'; END IF;
  checks:=array_append(checks,'old-complete-replay-after-reopen-no-mutation');
  PERFORM public.pds_mutate('task.complete',jsonb_build_object('id',t1,'request_id',q4));
  IF (SELECT count(*) FROM public.completion_events WHERE task_id=t1)<>2 OR (SELECT count(*) FROM public.tasks WHERE id=t1 AND status='completed')<>1 OR (SELECT completion_cycle FROM public.tasks WHERE id=t1)<>1 THEN RAISE EXCEPTION 'new_completion_cycle'; END IF;
  checks:=array_append(checks,'new-completion-cycle-retains-old-event');

  rejected:=false;
  BEGIN
    INSERT INTO public.completion_events(id,task_id,cycle,request_id,completed_at) VALUES(gen_random_uuid()::text,t1,1,gen_random_uuid()::text,'2026-09-30T00:00:00.000Z');
  EXCEPTION WHEN unique_violation THEN rejected:=true; END;
  IF NOT rejected THEN RAISE EXCEPTION 'missing_task_cycle_unique_constraint'; END IF;
  checks:=array_append(checks,'db-task-cycle-unique');

  r:=public.pds_mutate('task.create',task_input||jsonb_build_object('plan_id',p1,'title','두 번째 합성 할 일')); t2:=r->'entity'->>'id';
  rejected:=false;
  BEGIN PERFORM public.pds_mutate('task.complete',jsonb_build_object('id',t2,'request_id',q1)); EXCEPTION WHEN SQLSTATE 'PT409' THEN rejected:=true; END;
  IF NOT rejected OR (SELECT status FROM public.tasks WHERE id=t2)<>'pending' THEN RAISE EXCEPTION 'reused_key_other_task'; END IF;
  checks:=array_append(checks,'global-receipt-other-task-conflict');
  rejected:=false;
  BEGIN PERFORM public.pds_mutate('task.reopen',jsonb_build_object('id',t1,'request_id',q1)); EXCEPTION WHEN SQLSTATE 'PT409' THEN rejected:=true; END;
  IF NOT rejected OR (SELECT status FROM public.tasks WHERE id=t1)<>'completed' THEN RAISE EXCEPTION 'reused_key_other_action'; END IF;
  checks:=array_append(checks,'global-receipt-other-action-conflict');

  PERFORM public.pds_mutate('task.delete',jsonb_build_object('id',t1));
  IF (SELECT deleted_at FROM public.tasks WHERE id=t1) IS NULL OR (SELECT count(*) FROM public.executions WHERE task_id=t1)<>1 OR (SELECT count(*) FROM public.completion_events WHERE task_id=t1)<>2 THEN RAISE EXCEPTION 'soft_delete_lost_history'; END IF;
  rejected:=false;
  BEGIN PERFORM public.pds_mutate('execution.create',jsonb_build_object('task_id',t1,'started_at','2026-09-30T00:00:00.000Z','ended_at','2026-09-30T00:25:00.000Z','actual_minutes',25)); EXCEPTION WHEN SQLSTATE 'PT404' THEN rejected:=true; END;

  IF NOT rejected THEN RAISE EXCEPTION 'deleted_execution_not_rejected'; END IF;
  PERFORM public.pds_mutate('task.restore',jsonb_build_object('id',t1));
  IF (SELECT deleted_at FROM public.tasks WHERE id=t1) IS NOT NULL OR (SELECT status FROM public.tasks WHERE id=t1)<>'completed' THEN RAISE EXCEPTION 'restore_changed_task_state'; END IF;
  checks:=array_append(checks,'soft-delete-history-and-restore');

  r:=public.pds_mutate('review.create',jsonb_build_object('plan_id',p1,'improvement','분량을 나눠 다음 계획에 적용 — 롤백')); review_id:=r->'entity'->>'id';
  r:=public.pds_mutate('review.next-plan',plan_input||jsonb_build_object('id',review_id,'title','합성 다음 계획 — 롤백')); p2:=r->'entity'->>'id';
  r2:=public.pds_mutate('review.next-plan',plan_input||jsonb_build_object('id',review_id,'title','만들어지면 안 되는 중복 계획'));
  IF r2->'entity'->>'id'<>p2 OR (r2->>'changed')::boolean OR (SELECT count(*) FROM public.plans WHERE source_review_id=review_id)<>1 OR r->'entity'->>'carried_improvement'<>'분량을 나눠 다음 계획에 적용 — 롤백' OR (SELECT next_plan_id FROM public.reviews WHERE id=review_id)<>p2 OR (SELECT count(*) FROM public.plan_history WHERE plan_id=p2)<>1 THEN RAISE EXCEPTION 'review_carry_or_unique'; END IF;
  checks:=array_append(checks,'one-next-plan-carries-review-improvement');

  rejected:=false;
  BEGIN PERFORM public.pds_mutate('plan.create',plan_input||jsonb_build_object('start_date','2026-02-30')); EXCEPTION WHEN SQLSTATE 'PT400' THEN rejected:=true; END;
  IF NOT rejected THEN RAISE EXCEPTION 'raw_invalid_date'; END IF;
  checks:=array_append(checks,'raw-invalid-date-rejected');
  rejected:=false;
  BEGIN PERFORM public.pds_mutate('task.create',task_input||jsonb_build_object('plan_id',p1,'expected_minutes',-1)); EXCEPTION WHEN SQLSTATE 'PT400' THEN rejected:=true; END;
  IF NOT rejected THEN RAISE EXCEPTION 'raw_negative_minutes'; END IF;
  checks:=array_append(checks,'raw-negative-minutes-rejected');
  rejected:=false;
  BEGIN PERFORM public.pds_mutate('task.create',task_input||jsonb_build_object('plan_id',p1,'expected_minutes',1.5)); EXCEPTION WHEN SQLSTATE 'PT400' THEN rejected:=true; END;
  IF NOT rejected THEN RAISE EXCEPTION 'raw_fractional_minutes'; END IF;
  checks:=array_append(checks,'raw-fractional-minutes-rejected');
  rejected:=false;
  BEGIN PERFORM public.pds_mutate('task.create',task_input||jsonb_build_object('plan_id',p1,'tags','invalid')); EXCEPTION WHEN SQLSTATE 'PT400' THEN rejected:=true; END;
  IF NOT rejected THEN RAISE EXCEPTION 'raw_non_array_tags'; END IF;
  checks:=array_append(checks,'raw-non-array-tags-rejected');
  rejected:=false;
  BEGIN PERFORM public.pds_mutate('task.create',task_input||jsonb_build_object('plan_id',p1,'tags',jsonb_build_array(E'\n\t '))); EXCEPTION WHEN SQLSTATE 'PT400' THEN rejected:=true; END;
  IF NOT rejected THEN RAISE EXCEPTION 'raw_whitespace_tag'; END IF;
  checks:=array_append(checks,'raw-whitespace-tag-rejected');
  rejected:=false;
  BEGIN PERFORM public.pds_mutate('task.complete',jsonb_build_object('id',t1,'request_id','not-a-uuid')); EXCEPTION WHEN SQLSTATE 'PT400' THEN rejected:=true; END;
  IF NOT rejected THEN RAISE EXCEPTION 'raw_non_uuid_request'; END IF;
  checks:=array_append(checks,'raw-non-uuid-request-rejected');
  rejected:=false;
  BEGIN PERFORM public.pds_mutate('review.create',jsonb_build_object('plan_id',p1,'improvement',E'\n\t ')); EXCEPTION WHEN SQLSTATE 'PT400' THEN rejected:=true; END;
  IF NOT rejected THEN RAISE EXCEPTION 'raw_whitespace_improvement'; END IF;
  checks:=array_append(checks,'raw-whitespace-improvement-rejected');
  rejected:=false;
  BEGIN PERFORM public.pds_mutate('plan.create',plan_input||jsonb_build_object('title',E'\n\t ')); EXCEPTION WHEN SQLSTATE 'PT400' THEN rejected:=true; END;
  IF NOT rejected THEN RAISE EXCEPTION 'raw_whitespace_title'; END IF;
  checks:=array_append(checks,'raw-whitespace-title-rejected');
  rejected:=false;
  BEGIN PERFORM public.pds_mutate('plan.create',plan_input||jsonb_build_object('record_origin','synthetic')); EXCEPTION WHEN SQLSTATE 'PT400' THEN rejected:=true; END;
  IF NOT rejected THEN RAISE EXCEPTION 'raw_synthetic_origin'; END IF;
  checks:=array_append(checks,'public-synthetic-origin-rejected');
  rejected:=false;
  BEGIN PERFORM public.pds_mutate('execution.create',jsonb_build_object('task_id',t1,'started_at','2026-09-30T00:00:00','ended_at','2026-09-30T00:25:00.000Z','actual_minutes',25)); EXCEPTION WHEN SQLSTATE 'PT400' THEN rejected:=true; END;
  IF NOT rejected THEN RAISE EXCEPTION 'raw_non_utc_timestamp'; END IF;
  checks:=array_append(checks,'raw-non-utc-timestamp-rejected');

  -- This reset represents a separate raw Data API request, with no RPC write gate.
  PERFORM set_config('pds.mutation','',true);
  rejected:=false;
  BEGIN
    INSERT INTO public.plans(id,title,description,start_date,end_date,priority,success_criteria,expected_minutes,version,source_review_id,carried_improvement,record_origin,created_at,updated_at)
    SELECT gen_random_uuid()::text,title,description,start_date,end_date,priority,success_criteria,expected_minutes,1,NULL,'','user',created_at,updated_at FROM public.plans WHERE id=p1;
  EXCEPTION WHEN insufficient_privilege THEN rejected:=true; END;
  IF NOT rejected THEN RAISE EXCEPTION 'raw_insert_bypassed_rls'; END IF;
  checks:=array_append(checks,'raw-table-insert-rls-rejected');
  rejected:=false;
  BEGIN UPDATE public.plans SET title='직접 변경되면 안 됨' WHERE id=p1; EXCEPTION WHEN insufficient_privilege THEN rejected:=true; END;
  IF NOT rejected THEN RAISE EXCEPTION 'raw_update_bypassed_rls'; END IF;
  checks:=array_append(checks,'raw-table-update-rls-rejected');
  rejected:=false;
  BEGIN DELETE FROM public.tasks WHERE id=t2; EXCEPTION WHEN insufficient_privilege THEN rejected:=true; END;
  IF NOT rejected OR has_table_privilege('anon','public.tasks','DELETE') THEN RAISE EXCEPTION 'raw_delete_privilege'; END IF;
  checks:=array_append(checks,'no-delete-table-privilege');
  rejected:=false;
  BEGIN UPDATE public.plan_history SET snapshot_json='{}' WHERE plan_id=p1; EXCEPTION WHEN insufficient_privilege OR SQLSTATE 'PT409' THEN rejected:=true; END;
  IF NOT rejected THEN RAISE EXCEPTION 'anon_history_update_allowed'; END IF;
  checks:=array_append(checks,'anon-history-alter-rejected');

  after_state:=public.pds_state();
  IF (SELECT count(*) FROM jsonb_array_elements(after_state->'plans') x WHERE x->>'id'=ANY(ARRAY[p1,p2]))<>2 OR (SELECT count(*) FROM jsonb_array_elements(after_state->'plan_history') x WHERE x->>'plan_id'=ANY(ARRAY[p1,p2]))<>3 OR (SELECT count(*) FROM jsonb_array_elements(after_state->'tasks') x WHERE x->>'plan_id'=p1)<>2 OR (SELECT count(*) FROM jsonb_array_elements(after_state->'executions') x WHERE x->>'task_id'=t1)<>1 OR (SELECT count(*) FROM jsonb_array_elements(after_state->'completion_events') x WHERE x->>'task_id'=t1)<>2 OR (SELECT count(*) FROM jsonb_array_elements(after_state->'request_receipts') x WHERE x->>'resource_id'=t1)<>4 OR (SELECT count(*) FROM jsonb_array_elements(after_state->'reviews') x WHERE x->>'plan_id'=p1)<>1 THEN RAISE EXCEPTION 'state_fixture_counts'; END IF;
  checks:=array_append(checks,'state-seven-table-counts');
  IF (SELECT value->'snapshot'->>'title' FROM jsonb_array_elements(after_state->'plan_history') WHERE value->>'plan_id'=p1 AND value->>'version'='1')<>plan_input->>'title' OR (SELECT value->'response'->'entity'->>'id' FROM jsonb_array_elements(after_state->'request_receipts') WHERE value->>'request_id'=q1)<>t1 THEN RAISE EXCEPTION 'state_json_parsing'; END IF;
  checks:=array_append(checks,'parsed-snapshot-and-receipt-response');
  FOREACH k IN ARRAY ARRAY['plans','plan_history','tasks','executions','completion_events','request_receipts','reviews'] LOOP
    IF k='plans' THEN field:='id'; remove_ids:=ARRAY[p1,p2];
    ELSIF k IN ('plan_history','tasks','reviews') THEN field:='plan_id'; remove_ids:=ARRAY[p1,p2];
    ELSIF k='request_receipts' THEN field:='resource_id'; remove_ids:=ARRAY[t1,t2];

    ELSE field:='task_id'; remove_ids:=ARRAY[t1,t2]; END IF;
    SELECT coalesce(jsonb_agg(value ORDER BY ordinality),'[]'::jsonb) INTO filtered FROM jsonb_array_elements(after_state->k) WITH ORDINALITY WHERE NOT (coalesce(value->>field,'')=ANY(remove_ids));
    IF filtered<>base->k THEN RAISE EXCEPTION 'preexisting_records_changed'; END IF;
  END LOOP;
  checks:=array_append(checks,'preexisting-state-preserved');
  PERFORM set_config('pds.verify_checks',to_jsonb(checks)::text,true);
END $verify$;

-- Additionally exercise the unconditional immutability trigger as table owner.
-- anon itself has no UPDATE/DELETE grant on history; both protections are tested.
RESET ROLE;
DO $trigger$
DECLARE p1 text:=current_setting('pds.verify_plan_id'); rejected boolean; checks jsonb:=current_setting('pds.verify_checks')::jsonb;
BEGIN
  rejected:=false;
  BEGIN UPDATE public.plan_history SET snapshot_json='{}' WHERE plan_id=p1 AND version=1; EXCEPTION WHEN SQLSTATE 'PT409' THEN rejected:=true; END;
  IF NOT rejected THEN RAISE EXCEPTION 'immutable_history_trigger_update'; END IF;
  checks:=checks||jsonb_build_array('history-trigger-owner-update-rejected');
  rejected:=false;
  BEGIN DELETE FROM public.plan_history WHERE plan_id=p1 AND version=1; EXCEPTION WHEN SQLSTATE 'PT409' THEN rejected:=true; END;
  IF NOT rejected THEN RAISE EXCEPTION 'immutable_history_trigger_delete'; END IF;
  checks:=checks||jsonb_build_array('history-trigger-owner-delete-rejected');
  PERFORM set_config('pds.verify_checks',checks::text,true);
END $trigger$;
SET LOCAL ROLE anon;
DO $coverage$
BEGIN IF jsonb_array_length(current_setting('pds.verify_checks')::jsonb)<>35 THEN RAISE EXCEPTION 'verification_coverage_incomplete'; END IF; END $coverage$;
ROLLBACK;
SELECT jsonb_build_object(
  'status','PASS','assertions',35,'checks','["anon-role","initial-plan-and-history","same-id-immutable-snapshots","optimistic-plan-conflict","parsed-task-tags","optimistic-task-conflict","separate-utc-execution","double-completion-one-event-plus-one-count","reopen-cycle-once","old-complete-replay-after-reopen-no-mutation","new-completion-cycle-retains-old-event","db-task-cycle-unique","global-receipt-other-task-conflict","global-receipt-other-action-conflict","soft-delete-history-and-restore","one-next-plan-carries-review-improvement","raw-invalid-date-rejected","raw-negative-minutes-rejected","raw-fractional-minutes-rejected","raw-non-array-tags-rejected","raw-whitespace-tag-rejected","raw-non-uuid-request-rejected","raw-whitespace-improvement-rejected","raw-whitespace-title-rejected","public-synthetic-origin-rejected","raw-non-utc-timestamp-rejected","raw-table-insert-rls-rejected","raw-table-update-rls-rejected","no-delete-table-privilege","anon-history-alter-rejected","state-seven-table-counts","parsed-snapshot-and-receipt-response","preexisting-state-preserved","history-trigger-owner-update-rejected","history-trigger-owner-delete-rejected"]'::jsonb,
  'transaction_rolled_back',true,'primary_role','anon','history_trigger_checked_as','owner',
  'post_rollback_counts',jsonb_build_object(
    'plans',(SELECT count(*) FROM public.plans),'plan_history',(SELECT count(*) FROM public.plan_history),
    'tasks',(SELECT count(*) FROM public.tasks),'executions',(SELECT count(*) FROM public.executions),
    'completion_events',(SELECT count(*) FROM public.completion_events),'request_receipts',(SELECT count(*) FROM public.request_receipts),'reviews',(SELECT count(*) FROM public.reviews)
  )
) AS verification;


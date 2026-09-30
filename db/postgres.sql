-- Run once in an EMPTY dedicated T06 project. No seed/user records.
-- Invoker RPCs obey RLS; T06 data is public-safe. Synthetic records stay local.
BEGIN;
CREATE TABLE public.plans (
  id TEXT PRIMARY KEY CHECK(id ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'),
  title TEXT NOT NULL CHECK(char_length(title) BETWEEN 1 AND 160 AND title ~ '[^[:space:]]'),
  description TEXT NOT NULL DEFAULT '' CHECK(char_length(description)<=4000),
  start_date TEXT NOT NULL CHECK(start_date ~ '^\d{4}-\d{2}-\d{2}$'),
  end_date TEXT NOT NULL CHECK(end_date ~ '^\d{4}-\d{2}-\d{2}$' AND end_date>=start_date),
  priority TEXT NOT NULL CHECK(priority IN ('high','medium','low')),
  success_criteria TEXT NOT NULL CHECK(char_length(success_criteria) BETWEEN 1 AND 2000 AND success_criteria ~ '[^[:space:]]'),
  expected_minutes INTEGER NOT NULL CHECK(expected_minutes BETWEEN 0 AND 1000000),
  version INTEGER NOT NULL CHECK(version>=1), source_review_id TEXT UNIQUE,
  carried_improvement TEXT NOT NULL DEFAULT '' CHECK(char_length(carried_improvement)<=2000),
  record_origin TEXT NOT NULL DEFAULT 'user' CHECK(record_origin='user'),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE public.plan_history (
  id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES public.plans(id),
  version INTEGER NOT NULL CHECK(version>=1),
  snapshot_json TEXT NOT NULL CHECK(jsonb_typeof(snapshot_json::jsonb)='object'),
  created_at TEXT NOT NULL, UNIQUE(plan_id,version)
);
CREATE TABLE public.tasks (
  id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES public.plans(id),
  title TEXT NOT NULL CHECK(char_length(title) BETWEEN 1 AND 160 AND title ~ '[^[:space:]]'),
  notes TEXT NOT NULL DEFAULT '' CHECK(char_length(notes)<=4000),
  due_date TEXT CHECK(due_date IS NULL OR due_date ~ '^\d{4}-\d{2}-\d{2}$'),
  priority TEXT NOT NULL CHECK(priority IN ('high','medium','low')),
  tags_json TEXT NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(tags_json::jsonb)='array' AND jsonb_array_length(tags_json::jsonb)<=20),
  expected_minutes INTEGER NOT NULL CHECK(expected_minutes BETWEEN 0 AND 1000000),
  status TEXT NOT NULL CHECK(status IN ('pending','completed')),
  completion_cycle INTEGER NOT NULL DEFAULT 0 CHECK(completion_cycle>=0),
  version INTEGER NOT NULL CHECK(version>=1), deleted_at TEXT,
  record_origin TEXT NOT NULL DEFAULT 'user' CHECK(record_origin='user'),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE INDEX tasks_plan ON public.tasks(plan_id);
CREATE TABLE public.executions (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES public.tasks(id),
  started_at TEXT NOT NULL, ended_at TEXT NOT NULL CHECK(ended_at>=started_at),
  actual_minutes INTEGER NOT NULL CHECK(actual_minutes BETWEEN 0 AND 1000000),
  blocked_reason TEXT NOT NULL DEFAULT '' CHECK(char_length(blocked_reason)<=4000),
  record_origin TEXT NOT NULL DEFAULT 'user' CHECK(record_origin='user'), created_at TEXT NOT NULL
);
CREATE INDEX executions_task ON public.executions(task_id);
CREATE TABLE public.completion_events (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES public.tasks(id), cycle INTEGER NOT NULL CHECK(cycle>=0),
  request_id TEXT NOT NULL UNIQUE CHECK(char_length(request_id) BETWEEN 1 AND 128),
  completed_at TEXT NOT NULL, UNIQUE(task_id,cycle)
);
CREATE TABLE public.request_receipts (
  request_id TEXT PRIMARY KEY CHECK(char_length(request_id) BETWEEN 1 AND 128),
  action TEXT NOT NULL CHECK(action IN ('task.complete','task.reopen')),
  resource_id TEXT NOT NULL REFERENCES public.tasks(id),
  response_json TEXT NOT NULL CHECK(jsonb_typeof(response_json::jsonb)='object'), created_at TEXT NOT NULL
);
CREATE TABLE public.reviews (
  id TEXT PRIMARY KEY, plan_id TEXT NOT NULL REFERENCES public.plans(id),
  improvement TEXT NOT NULL CHECK(char_length(improvement) BETWEEN 1 AND 2000 AND improvement ~ '[^[:space:]]'),
  next_plan_id TEXT UNIQUE REFERENCES public.plans(id),
  record_origin TEXT NOT NULL DEFAULT 'user' CHECK(record_origin='user'), created_at TEXT NOT NULL
);
CREATE INDEX request_receipts_resource ON public.request_receipts(resource_id);
CREATE INDEX reviews_plan ON public.reviews(plan_id);
ALTER TABLE public.plans ADD CONSTRAINT plans_source_review_fk FOREIGN KEY(source_review_id) REFERENCES public.reviews(id);
CREATE FUNCTION public.pds_history_immutable() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
BEGIN RAISE EXCEPTION USING ERRCODE='PT409',MESSAGE='계획 이력은 변경하거나 삭제할 수 없습니다.'; END; $$;
CREATE TRIGGER plan_history_immutable BEFORE UPDATE OR DELETE ON public.plan_history FOR EACH ROW EXECUTE FUNCTION public.pds_history_immutable();

-- Validation also applies to raw RPC calls.
CREATE FUNCTION public.pds_text(p jsonb,k text,lim integer,required boolean DEFAULT false,fallback text DEFAULT '') RETURNS text
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=public AS $$
DECLARE v text; BEGIN
  IF NOT p ? k OR p->k='null'::jsonb THEN v:=fallback;
  ELSIF jsonb_typeof(p->k)<>'string' THEN RAISE EXCEPTION USING ERRCODE='PT400',MESSAGE='문자열 항목을 확인해 주세요.';
  ELSE v:=p->>k; END IF;
  IF v IS NULL OR char_length(v)>lim OR (required AND v !~ '[^[:space:]]') THEN RAISE EXCEPTION USING ERRCODE='PT400',MESSAGE='입력 항목의 내용이나 길이를 확인해 주세요.'; END IF;
  RETURN v;
END; $$;
CREATE FUNCTION public.pds_integer(p jsonb,k text,lo integer,hi integer,fallback integer DEFAULT NULL) RETURNS integer
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=public AS $$
DECLARE v numeric; BEGIN
  IF NOT p ? k OR p->k='null'::jsonb THEN
    IF fallback IS NULL THEN RAISE EXCEPTION USING ERRCODE='PT400',MESSAGE='정수 항목을 확인해 주세요.'; END IF;
    RETURN fallback;
  END IF;
  IF jsonb_typeof(p->k)<>'number' OR p->>k !~ '^\d+$' THEN RAISE EXCEPTION USING ERRCODE='PT400',MESSAGE='0 이상 정수를 입력해 주세요.'; END IF;
  v:=(p->>k)::numeric;
  IF v<lo OR v>hi THEN RAISE EXCEPTION USING ERRCODE='PT400',MESSAGE='정수 입력 범위를 확인해 주세요.'; END IF;
  RETURN v::integer;
END; $$;
CREATE FUNCTION public.pds_date(p jsonb,k text,nullable boolean DEFAULT false) RETURNS text
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=public AS $$
DECLARE v text; BEGIN
  IF nullable AND (NOT p ? k OR p->k='null'::jsonb) THEN RETURN NULL; END IF;
  v:=public.pds_text(p,k,10,true);
  IF v !~ '^\d{4}-\d{2}-\d{2}$' OR to_char(v::date,'YYYY-MM-DD')<>v THEN RAISE EXCEPTION USING ERRCODE='PT400',MESSAGE='존재하는 날짜를 입력해 주세요.'; END IF;
  RETURN v;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RAISE EXCEPTION USING ERRCODE='PT400',MESSAGE='존재하는 날짜를 입력해 주세요.';
END; $$;
CREATE FUNCTION public.pds_instant(p jsonb,k text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=public AS $$
DECLARE v text; BEGIN
  v:=public.pds_text(p,k,24,true);
  IF v !~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$' OR to_char(v::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>v THEN RAISE EXCEPTION USING ERRCODE='PT400',MESSAGE='UTC 실행 시각을 확인해 주세요.'; END IF;
  RETURN v;
EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RAISE EXCEPTION USING ERRCODE='PT400',MESSAGE='UTC 실행 시각을 확인해 주세요.';
END; $$;
CREATE FUNCTION public.pds_tags(p jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=public AS $$
DECLARE v jsonb:=coalesce(p->'tags','[]'::jsonb); item jsonb; BEGIN
  IF jsonb_typeof(v)<>'array' THEN RAISE EXCEPTION USING ERRCODE='PT400',MESSAGE='태그 배열을 확인해 주세요.'; END IF;
  IF jsonb_array_length(v)>20 THEN RAISE EXCEPTION USING ERRCODE='PT400',MESSAGE='태그 개수를 확인해 주세요.'; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(v) LOOP
    IF jsonb_typeof(item)<>'string' OR char_length(item #>> '{}')>40 OR (item #>> '{}') !~ '[^[:space:]]' THEN RAISE EXCEPTION USING ERRCODE='PT400',MESSAGE='태그 내용을 확인해 주세요.'; END IF;
  END LOOP;
  RETURN v::text;
END; $$;
CREATE FUNCTION public.pds_uuid(p jsonb,k text) RETURNS text
LANGUAGE plpgsql IMMUTABLE SECURITY INVOKER SET search_path=public AS $$
DECLARE v text:=public.pds_text(p,k,36,true); BEGIN
  IF v !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN RAISE EXCEPTION USING ERRCODE='PT400',MESSAGE='기록 또는 요청 ID를 확인해 주세요.'; END IF;
  RETURN lower(v);
END; $$;
CREATE FUNCTION public.pds_state() RETURNS jsonb
LANGUAGE sql STABLE SECURITY INVOKER SET search_path=public AS $$
SELECT jsonb_build_object(
  'plans',(SELECT coalesce(jsonb_agg(to_jsonb(p) ORDER BY p.created_at,p.id),'[]'::jsonb) FROM public.plans p),
  'plan_history',(SELECT coalesce(jsonb_agg((to_jsonb(h)-'snapshot_json')||jsonb_build_object('snapshot',h.snapshot_json::jsonb) ORDER BY h.created_at,h.id),'[]'::jsonb) FROM public.plan_history h),
  'tasks',(SELECT coalesce(jsonb_agg((to_jsonb(t)-'tags_json')||jsonb_build_object('tags',t.tags_json::jsonb) ORDER BY t.created_at,t.id),'[]'::jsonb) FROM public.tasks t),
  'executions',(SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.created_at,e.id),'[]'::jsonb) FROM public.executions e),
  'completion_events',(SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.completed_at,c.id),'[]'::jsonb) FROM public.completion_events c),
  'request_receipts',(SELECT coalesce(jsonb_agg((to_jsonb(r)-'response_json')||jsonb_build_object('response',r.response_json::jsonb) ORDER BY r.created_at,r.request_id),'[]'::jsonb) FROM public.request_receipts r),
  'reviews',(SELECT coalesce(jsonb_agg(to_jsonb(v) ORDER BY v.created_at,v.id),'[]'::jsonb) FROM public.reviews v)
); $$;

CREATE FUNCTION public.pds_mutate(p_action text,p_payload jsonb) RETURNS jsonb
LANGUAGE plpgsql SECURITY INVOKER SET search_path=public AS $$
DECLARE
  p jsonb; stamp text:=to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  plan public.plans%ROWTYPE; task public.tasks%ROWTYPE; execution public.executions%ROWTYPE;
  event public.completion_events%ROWTYPE; receipt public.request_receipts%ROWTYPE; review public.reviews%ROWTYPE;
  entity jsonb; result jsonb; changed boolean:=false;
  rid text; resource text; vtitle text; vdescription text; vstart text; vend text; vpriority text;
  vcriteria text; vminutes integer; vtags text; vnotes text; vdue text; vversion integer; vorigin text;
BEGIN
  IF p_payload IS NULL OR jsonb_typeof(p_payload)<>'object' THEN RAISE EXCEPTION USING ERRCODE='PT400',MESSAGE='입력 자료를 확인해 주세요.'; END IF;
  vorigin:=public.pds_text(p_payload,'record_origin',9,false,'user');
  IF vorigin<>'user' THEN RAISE EXCEPTION USING ERRCODE='PT400',MESSAGE='공개 서버에는 본인 자료만 저장합니다.'; END IF;
  -- PostgREST exposes no arbitrary SQL/set_config RPC. Only this validated invoker
  -- entry point enables writes for this transaction; direct table writes fail RLS.
  PERFORM set_config('pds.mutation','enabled',true);
  IF p_action IN ('plan.create','plan.update','review.next-plan') THEN
    p:=p_payload;
    IF p_action='plan.update' THEN
      resource:=public.pds_uuid(p_payload,'id');
      SELECT * INTO plan FROM public.plans WHERE id=resource FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='PT404',MESSAGE='계획을 찾을 수 없습니다.'; END IF;
      vversion:=public.pds_integer(p_payload,'expected_version',1,2147483646);
      IF plan.version<>vversion THEN RAISE EXCEPTION USING ERRCODE='PT409',MESSAGE='최신 계획을 확인해 주세요.'; END IF;
      p:=to_jsonb(plan)||p_payload;
    ELSIF p_action='review.next-plan' THEN
      resource:=public.pds_uuid(p_payload,'id');
      SELECT * INTO review FROM public.reviews WHERE id=resource FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='PT404',MESSAGE='회고를 찾을 수 없습니다.'; END IF;
      IF review.next_plan_id IS NOT NULL THEN
        SELECT * INTO plan FROM public.plans WHERE id=review.next_plan_id;
        RETURN jsonb_build_object('entity',to_jsonb(plan),'changed',false,'review',to_jsonb(review));
      END IF;
    END IF;
    vtitle:=public.pds_text(p,'title',160,true); vdescription:=public.pds_text(p,'description',4000);
    vstart:=public.pds_date(p,'start_date'); vend:=public.pds_date(p,'end_date');
    IF vend<vstart THEN RAISE EXCEPTION USING ERRCODE='PT400',MESSAGE='계획 기간을 확인해 주세요.'; END IF;
    vpriority:=public.pds_text(p,'priority',6,false,'medium');
    IF vpriority NOT IN ('high','medium','low') THEN RAISE EXCEPTION USING ERRCODE='PT400',MESSAGE='우선순위를 확인해 주세요.'; END IF;
    vcriteria:=public.pds_text(p,'success_criteria',2000,true); vminutes:=public.pds_integer(p,'expected_minutes',0,1000000,0);
    IF p_action='plan.update' THEN
      UPDATE public.plans SET title=vtitle,description=vdescription,start_date=vstart,end_date=vend,priority=vpriority,success_criteria=vcriteria,expected_minutes=vminutes,version=version+1,updated_at=stamp WHERE id=resource RETURNING * INTO plan;
    ELSE
      INSERT INTO public.plans(id,title,description,start_date,end_date,priority,success_criteria,expected_minutes,version,source_review_id,carried_improvement,record_origin,created_at,updated_at)
      VALUES(gen_random_uuid()::text,vtitle,vdescription,vstart,vend,vpriority,vcriteria,vminutes,1,CASE WHEN p_action='review.next-plan' THEN review.id ELSE NULL END,CASE WHEN p_action='review.next-plan' THEN review.improvement ELSE '' END,'user',stamp,stamp) RETURNING * INTO plan;
    END IF;
    INSERT INTO public.plan_history(id,plan_id,version,snapshot_json,created_at) VALUES(gen_random_uuid()::text,plan.id,plan.version,to_jsonb(plan)::text,stamp);
    result:=jsonb_build_object('entity',to_jsonb(plan),'changed',true);
    IF p_action='review.next-plan' THEN
      UPDATE public.reviews SET next_plan_id=plan.id WHERE id=review.id RETURNING * INTO review;
      result:=result||jsonb_build_object('review',to_jsonb(review));
    END IF;
    RETURN result;
  END IF;

  IF p_action IN ('task.complete','task.reopen') THEN
    rid:=public.pds_uuid(p_payload,'request_id'); resource:=public.pds_uuid(p_payload,'id');
    -- Global key lock precedes receipt read, then the Task row lock serializes cycles.
    PERFORM pg_advisory_xact_lock(hashtextextended(rid,0));
    SELECT * INTO receipt FROM public.request_receipts WHERE request_id=rid;
    IF FOUND THEN
      IF receipt.action<>p_action OR receipt.resource_id<>resource THEN RAISE EXCEPTION USING ERRCODE='PT409',MESSAGE='요청 식별자가 다른 작업에 사용되었습니다.'; END IF;
      RETURN receipt.response_json::jsonb||jsonb_build_object('replayed',true);
    END IF;
    SELECT * INTO task FROM public.tasks WHERE id=resource AND deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='PT404',MESSAGE='할 일을 찾을 수 없습니다.'; END IF;
    IF p_action='task.complete' THEN
      IF task.status='pending' THEN
        INSERT INTO public.completion_events(id,task_id,cycle,request_id,completed_at) VALUES(gen_random_uuid()::text,task.id,task.completion_cycle,rid,stamp) RETURNING * INTO event;
        UPDATE public.tasks SET status='completed',version=version+1,updated_at=stamp WHERE id=task.id RETURNING * INTO task; changed:=true;
      ELSE SELECT * INTO event FROM public.completion_events WHERE task_id=task.id AND cycle=task.completion_cycle; END IF;
    ELSIF task.status='completed' THEN
      UPDATE public.tasks SET status='pending',completion_cycle=completion_cycle+1,version=version+1,updated_at=stamp WHERE id=task.id RETURNING * INTO task; changed:=true;
    END IF;
    entity:=(to_jsonb(task)-'tags_json')||jsonb_build_object('tags',task.tags_json::jsonb);
    result:=jsonb_build_object('entity',entity,'changed',changed);
    IF event.id IS NOT NULL THEN result:=result||jsonb_build_object('event',to_jsonb(event)); END IF;
    INSERT INTO public.request_receipts(request_id,action,resource_id,response_json,created_at) VALUES(rid,p_action,task.id,result::text,stamp);
    RETURN result;
  END IF;

  IF p_action IN ('task.create','task.update') THEN
    p:=p_payload;
    IF p_action='task.create' THEN
      resource:=public.pds_uuid(p_payload,'plan_id');
      PERFORM 1 FROM public.plans WHERE id=resource;
      IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='PT404',MESSAGE='계획을 찾을 수 없습니다.'; END IF;
    ELSE
      resource:=public.pds_uuid(p_payload,'id');
      SELECT * INTO task FROM public.tasks WHERE id=resource AND deleted_at IS NULL FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='PT404',MESSAGE='할 일을 찾을 수 없습니다.'; END IF;
      vversion:=public.pds_integer(p_payload,'expected_version',1,2147483646);
      IF task.version<>vversion THEN RAISE EXCEPTION USING ERRCODE='PT409',MESSAGE='최신 할 일을 확인해 주세요.'; END IF;
      p:=(to_jsonb(task)-'tags_json')||jsonb_build_object('tags',task.tags_json::jsonb)||p_payload;
    END IF;
    vtitle:=public.pds_text(p,'title',160,true); vnotes:=public.pds_text(p,'notes',4000); vdue:=public.pds_date(p,'due_date',true);
    vpriority:=public.pds_text(p,'priority',6,false,'medium');
    IF vpriority NOT IN ('high','medium','low') THEN RAISE EXCEPTION USING ERRCODE='PT400',MESSAGE='우선순위를 확인해 주세요.'; END IF;
    vtags:=public.pds_tags(p); vminutes:=public.pds_integer(p,'expected_minutes',0,1000000,0);
    IF p_action='task.create' THEN
      INSERT INTO public.tasks(id,plan_id,title,notes,due_date,priority,tags_json,expected_minutes,status,completion_cycle,version,deleted_at,record_origin,created_at,updated_at)
      VALUES(gen_random_uuid()::text,resource,vtitle,vnotes,vdue,vpriority,vtags,vminutes,'pending',0,1,NULL,'user',stamp,stamp) RETURNING * INTO task;
    ELSE
      UPDATE public.tasks SET title=vtitle,notes=vnotes,due_date=vdue,priority=vpriority,tags_json=vtags,expected_minutes=vminutes,version=version+1,updated_at=stamp WHERE id=resource RETURNING * INTO task;
    END IF;
    RETURN jsonb_build_object('entity',(to_jsonb(task)-'tags_json')||jsonb_build_object('tags',task.tags_json::jsonb),'changed',true);
  END IF;

  IF p_action IN ('task.delete','task.restore') THEN
    resource:=public.pds_uuid(p_payload,'id');
    SELECT * INTO task FROM public.tasks WHERE id=resource FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='PT404',MESSAGE='할 일을 찾을 수 없습니다.'; END IF;
    changed:=(p_action='task.delete' AND task.deleted_at IS NULL) OR (p_action='task.restore' AND task.deleted_at IS NOT NULL);
    IF changed THEN UPDATE public.tasks SET deleted_at=CASE WHEN p_action='task.delete' THEN stamp ELSE NULL END,version=version+1,updated_at=stamp WHERE id=resource RETURNING * INTO task; END IF;
    RETURN jsonb_build_object('entity',(to_jsonb(task)-'tags_json')||jsonb_build_object('tags',task.tags_json::jsonb),'changed',changed);
  END IF;
  IF p_action='execution.create' THEN
    resource:=public.pds_uuid(p_payload,'task_id');
    SELECT * INTO task FROM public.tasks WHERE id=resource AND deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='PT404',MESSAGE='할 일을 찾을 수 없습니다.'; END IF;
    vstart:=public.pds_instant(p_payload,'started_at'); vend:=public.pds_instant(p_payload,'ended_at');
    IF vend<vstart THEN RAISE EXCEPTION USING ERRCODE='PT400',MESSAGE='실행 시작·종료 시각을 확인해 주세요.'; END IF;
    INSERT INTO public.executions(id,task_id,started_at,ended_at,actual_minutes,blocked_reason,record_origin,created_at)
    VALUES(gen_random_uuid()::text,resource,vstart,vend,public.pds_integer(p_payload,'actual_minutes',0,1000000),public.pds_text(p_payload,'blocked_reason',4000),'user',stamp) RETURNING * INTO execution;
    RETURN jsonb_build_object('entity',to_jsonb(execution),'changed',true);
  END IF;
  IF p_action='review.create' THEN
    resource:=public.pds_uuid(p_payload,'plan_id');
    PERFORM 1 FROM public.plans WHERE id=resource;
    IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='PT404',MESSAGE='계획을 찾을 수 없습니다.'; END IF;
    INSERT INTO public.reviews(id,plan_id,improvement,next_plan_id,record_origin,created_at)
    VALUES(gen_random_uuid()::text,resource,public.pds_text(p_payload,'improvement',2000,true),NULL,'user',stamp) RETURNING * INTO review;
    RETURN jsonb_build_object('entity',to_jsonb(review),'changed',true);
  END IF;
  RAISE EXCEPTION USING ERRCODE='PT400',MESSAGE='지원하지 않는 작업입니다.';
EXCEPTION
  WHEN unique_violation THEN RAISE EXCEPTION USING ERRCODE='PT409',MESSAGE='중복 또는 충돌하는 저장 요청입니다.';
  WHEN foreign_key_violation OR check_violation OR not_null_violation OR invalid_text_representation OR numeric_value_out_of_range THEN RAISE EXCEPTION USING ERRCODE='PT400',MESSAGE='자료 형식이나 연결된 기록을 확인해 주세요.';
END; $$;

-- Granular grants needed by SECURITY INVOKER. No DELETE privileges.
REVOKE ALL ON public.plans,public.plan_history,public.tasks,public.executions,public.completion_events,public.request_receipts,public.reviews FROM PUBLIC,anon,authenticated;
GRANT USAGE ON SCHEMA public TO anon,authenticated;
GRANT SELECT,INSERT ON public.plans,public.plan_history,public.tasks,public.executions,public.completion_events,public.request_receipts,public.reviews TO anon,authenticated;
GRANT UPDATE(title,description,start_date,end_date,priority,success_criteria,expected_minutes,version,updated_at) ON public.plans TO anon,authenticated;
GRANT UPDATE(title,notes,due_date,priority,tags_json,expected_minutes,status,completion_cycle,version,deleted_at,updated_at) ON public.tasks TO anon,authenticated;
GRANT UPDATE(next_plan_id) ON public.reviews TO anon,authenticated;
DO $$ DECLARE tbl text; BEGIN
  FOREACH tbl IN ARRAY ARRAY['plans','plan_history','tasks','executions','completion_events','request_receipts','reviews'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',tbl);
    EXECUTE format('CREATE POLICY t06_public_read ON public.%I FOR SELECT TO anon,authenticated USING (true)',tbl);
    EXECUTE format('CREATE POLICY t06_public_insert ON public.%I FOR INSERT TO anon,authenticated WITH CHECK ((SELECT current_setting(''pds.mutation'',true)) IS NOT DISTINCT FROM ''enabled'')',tbl);
  END LOOP;
  FOREACH tbl IN ARRAY ARRAY['plans','tasks','reviews'] LOOP
    EXECUTE format('CREATE POLICY t06_public_update ON public.%I FOR UPDATE TO anon,authenticated USING (true) WITH CHECK ((SELECT current_setting(''pds.mutation'',true)) IS NOT DISTINCT FROM ''enabled'')',tbl);
  END LOOP;
END $$;
REVOKE ALL ON FUNCTION public.pds_history_immutable(),public.pds_text(jsonb,text,integer,boolean,text),public.pds_integer(jsonb,text,integer,integer,integer),public.pds_date(jsonb,text,boolean),public.pds_instant(jsonb,text),public.pds_tags(jsonb),public.pds_uuid(jsonb,text),public.pds_state(),public.pds_mutate(text,jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pds_text(jsonb,text,integer,boolean,text),public.pds_integer(jsonb,text,integer,integer,integer),public.pds_date(jsonb,text,boolean),public.pds_instant(jsonb,text),public.pds_tags(jsonb),public.pds_uuid(jsonb,text),public.pds_state(),public.pds_mutate(text,jsonb) TO anon,authenticated;
COMMIT;



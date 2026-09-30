-- Cover the two remaining FK lookups and evaluate the unchanged RLS gate once
-- per statement. No data mutation or extra application grants.
-- https://supabase.com/docs/guides/database/postgres/row-level-security#call-functions-with-select
BEGIN;
CREATE INDEX IF NOT EXISTS request_receipts_resource ON public.request_receipts(resource_id);
CREATE INDEX IF NOT EXISTS reviews_plan ON public.reviews(plan_id);
DO $$ DECLARE tbl text; BEGIN
  FOREACH tbl IN ARRAY ARRAY['plans','plan_history','tasks','executions','completion_events','request_receipts','reviews'] LOOP
    EXECUTE format('ALTER POLICY t06_public_insert ON public.%I WITH CHECK ((SELECT current_setting(''pds.mutation'',true)) IS NOT DISTINCT FROM ''enabled'')',tbl);
  END LOOP;
  FOREACH tbl IN ARRAY ARRAY['plans','tasks','reviews'] LOOP
    EXECUTE format('ALTER POLICY t06_public_update ON public.%I WITH CHECK ((SELECT current_setting(''pds.mutation'',true)) IS NOT DISTINCT FROM ''enabled'')',tbl);
  END LOOP;
END $$;
COMMIT;

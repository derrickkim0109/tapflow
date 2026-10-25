-- 018_flow_run_service_tier.sql
-- The service tier a run asked its device to boot with (`tapflow flow run --service-tier`), as JSON:
-- { "name": "stock" | "lean" | "slim", "keep": [...] }. NULL when the run asked for none and the device booted on its
-- agent's own setting, which is every run before this column and every run without the option. Kept because a flow
-- that fails under slim for want of a service is not the app's regression, and the record is where that is read.
ALTER TABLE flow_runs ADD COLUMN service_tier_json TEXT;

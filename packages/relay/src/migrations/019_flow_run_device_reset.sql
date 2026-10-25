-- 019_flow_run_device_reset.sql
-- What a run's device was reset of before it ran (`tapflow flow run`, on by default, off with `--no-reset`), as JSON:
-- { "requested": bool, "cold": bool | absent, "report": { "done": [...], "failed": [...] } | absent }.
-- `requested` is written when the run is created; `cold` and `report` when its boot answers. A request with no report
-- is a reset nobody confirmed: an agent or relay that predates it drops the request without a word. NULL for every run
-- before this column and every run from a runner that predates it.
ALTER TABLE flow_runs ADD COLUMN device_reset_json TEXT;

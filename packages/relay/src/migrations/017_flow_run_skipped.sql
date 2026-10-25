-- 017_flow_run_skipped.sql
-- A flow the runner chose not to replay is recorded as `skipped`, with why: `app-mismatch` (its appId is not the
-- build's) or `tag-filter`. The human-readable reason goes in failure_message; failure_kind stays NULL.
--
-- SQLite cannot change a CHECK constraint in place, so the table is rebuilt. Nothing references flow_run_flows
-- (videos reference flow_runs), and this runs inside the migration's transaction.

CREATE TABLE flow_run_flows_new (
  run_seq          INTEGER NOT NULL REFERENCES flow_runs(seq) ON DELETE CASCADE,
  idx              INTEGER NOT NULL,
  name             TEXT NOT NULL,
  file             TEXT,
  device_id        TEXT,
  device_name      TEXT,
  platform         TEXT,
  status           TEXT NOT NULL CHECK (status IN ('passed', 'failed', 'skipped')),
  skip_reason      TEXT CHECK ((status = 'skipped') = (skip_reason IS NOT NULL)),
  failure_kind     TEXT,
  failure_message  TEXT,
  duration_ms      INTEGER NOT NULL,
  steps_json       TEXT NOT NULL,
  screenshot_file  TEXT,
  screenshot_mime  TEXT,
  PRIMARY KEY (run_seq, idx)
);

INSERT INTO flow_run_flows_new (run_seq, idx, name, file, device_id, device_name, platform, status, failure_kind,
                                failure_message, duration_ms, steps_json, screenshot_file, screenshot_mime)
SELECT run_seq, idx, name, file, device_id, device_name, platform, status, failure_kind,
       failure_message, duration_ms, steps_json, screenshot_file, screenshot_mime
  FROM flow_run_flows;

DROP TABLE flow_run_flows;
ALTER TABLE flow_run_flows_new RENAME TO flow_run_flows;

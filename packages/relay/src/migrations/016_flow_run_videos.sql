-- 016_flow_run_videos.sql
-- A flow's video, as the flow runner uploads it while the flow runs (A4). The runner opens it, sends chunks of the
-- stream it already receives, and ends it; the relay writes the bytes and never reads them. Kept by a retention
-- policy (team_settings below) and a disk cap enforced on the append path.

CREATE TABLE IF NOT EXISTS flow_run_videos (
  -- A video exists without its flow row: chunks arrive while the flow runs, and a flow cut short by a killed
  -- runner is never reported. The run's rows go with the run; the file is collected first by the deleter.
  run_seq        INTEGER NOT NULL REFERENCES flow_runs(seq) ON DELETE CASCADE,
  idx            INTEGER NOT NULL,
  file           TEXT NOT NULL,
  -- The open call's JSON (format version, platform, codec, geometry, flow-start offset). The only part the relay
  -- reads; the chunks are opaque.
  meta_json      TEXT NOT NULL,
  -- Committed length: chunks are written at this offset, so a write torn by a crash is overwritten by the next.
  bytes          INTEGER NOT NULL DEFAULT 0,
  -- Room reserved by writes in flight, counted in usage so two videos cannot both pass the cap check.
  reserved_bytes INTEGER NOT NULL DEFAULT 0,
  next_seq       INTEGER NOT NULL DEFAULT 0,
  ended_at       TEXT,
  end_reason     TEXT CHECK (end_reason IN ('done', 'cancelled', 'size-limit', 'storage-full', 'runner-lost', 'truncated')),
  -- The last seq the runner sent, from its end call: a lost tail shows as a gap rather than as a shorter video.
  end_last_seq   INTEGER,
  -- Set when the retention policy or the disk cap removed the file. The row stays, so the page can say
  -- "no longer kept" rather than "never recorded".
  evicted_at     TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  last_chunk_at  TEXT,
  PRIMARY KEY (run_seq, idx)
);

CREATE INDEX IF NOT EXISTS idx_flow_run_videos_live ON flow_run_videos(evicted_at, created_at);

-- Each chunk's place in the file. Doubles as the player's seek index: a chunk that starts with a keyframe is a
-- point decoding can begin from.
CREATE TABLE IF NOT EXISTS flow_run_video_chunks (
  run_seq   INTEGER NOT NULL,
  idx       INTEGER NOT NULL,
  seq       INTEGER NOT NULL,
  offset    INTEGER NOT NULL,
  length    INTEGER NOT NULL,
  -- The chunk's first frame on the playback clock (`capturedAt`), as the runner states it.
  start_ms  INTEGER NOT NULL,
  keyframe  INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_seq, idx, seq),
  FOREIGN KEY (run_seq, idx) REFERENCES flow_run_videos(run_seq, idx) ON DELETE CASCADE
);

-- The policy, beside the team's other settings. 0 days keeps no passed flow's video past the next daily purge.
ALTER TABLE team_settings ADD COLUMN video_pass_retention_days INTEGER NOT NULL DEFAULT 3;
ALTER TABLE team_settings ADD COLUMN video_storage_cap_mb INTEGER NOT NULL DEFAULT 20480;

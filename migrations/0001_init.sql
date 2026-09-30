-- hn-new-study: initial schema.
--
-- All times are epoch seconds, UTC. No local time is stored anywhere.
-- The raw responses live in R2; these tables only index and summarise them.

-- One row per HTTP request attempt made by the collector, successful or not.
-- A capture is successful when `error` is NULL. A retried request produces two
-- rows for the same (source, scheduled_at): attempt 1 and attempt 2.
CREATE TABLE captures (
  id           INTEGER PRIMARY KEY,  -- surrogate key, assigned by SQLite
  source       TEXT    NOT NULL,     -- what was fetched: newest_html, shownew_html, newstories_json,
                                     -- showstories_json, algolia_day, algolia_outcome, robots_txt
  url          TEXT,                 -- exact URL requested
  scheduled_at INTEGER,              -- the cron trigger's scheduled time (same for every capture in one run)
  started_at   INTEGER NOT NULL,     -- when this request was sent; also the timestamp in the R2 key
  finished_at  INTEGER,              -- when the body was fully read, or when the attempt failed
  http_status  INTEGER,              -- HTTP status code; NULL if no response was received
  headers      TEXT,                 -- response headers as a JSON object; NULL if no response
  bytes_raw    INTEGER,              -- size of the body as received (after transport decoding)
  bytes_gz     INTEGER,              -- size of the gzip object written to R2
  sha256       TEXT,                 -- hex SHA-256 of the raw body, to verify the R2 object after decompression
  r2_key       TEXT,                 -- R2 object key; NULL when no body was received
  attempt      INTEGER,              -- 1 for the first try, 2 for the single retry
  error        TEXT                  -- NULL on success; otherwise what went wrong (network error, HTTP status, ...)
);
CREATE INDEX captures_source_started ON captures (source, started_at);

-- One row per story, from the daily Algolia fetch of the previous UTC day.
-- Re-fetching a story updates its descriptive fields but never the *_first columns.
CREATE TABLE stories (
  id               INTEGER PRIMARY KEY, -- HN item id (Algolia objectID)
  created_at       INTEGER NOT NULL,    -- submission time (Algolia created_at_i)
  title            TEXT,
  url              TEXT,                -- NULL for text posts (Ask HN, some Show HN)
  author           TEXT,
  is_show          INTEGER NOT NULL,    -- 1 when Algolia's _tags contains "show_hn", else 0
  tags             TEXT,                -- Algolia's _tags array, as raw JSON
  points_first     INTEGER,             -- points at first_fetched_at (roughly 3 to 27 hours after submission)
  comments_first   INTEGER,             -- comment count at first_fetched_at
  first_fetched_at INTEGER              -- when the Algolia page containing this story was first fetched
);
CREATE INDEX stories_created ON stories (created_at);

-- Points and comments for each story, re-measured once the story is about
-- three days old (the full UTC day three days before the fetch).
CREATE TABLE story_outcomes (
  id         INTEGER NOT NULL,  -- HN item id
  fetched_at INTEGER NOT NULL,  -- when the Algolia page containing this story was fetched
  points     INTEGER,           -- points at fetched_at
  comments   INTEGER,           -- comment count at fetched_at
  PRIMARY KEY (id, fetched_at)
);

-- One row per cron invocation, written at start and completed at the end.
-- A row with finished_at NULL means the invocation died before finishing.
CREATE TABLE runs (
  id           INTEGER PRIMARY KEY,
  cron         TEXT,     -- the cron expression that fired (controller.cron)
  scheduled_at INTEGER,  -- controller.scheduledTime
  started_at   INTEGER,  -- when the handler began
  finished_at  INTEGER,  -- when the handler ended; NULL if it never did
  ok           INTEGER,  -- 1 if every step succeeded, else 0
  summary      TEXT      -- JSON with per-step counts and errors
);
CREATE INDEX runs_scheduled ON runs (scheduled_at);

-- One row per failure or recovery alert the collector tried to send.
-- Used to throttle alerts (at most one per source per 6 hours) and as a
-- public record of when the collector knew it was unhealthy.
CREATE TABLE alerts (
  id      INTEGER PRIMARY KEY,
  source  TEXT    NOT NULL,  -- capture source, or "daily" for the daily job
  kind    TEXT    NOT NULL,  -- "failing" or "recovered"
  sent_at INTEGER NOT NULL,  -- when sending was attempted
  ok      INTEGER NOT NULL,  -- 1 if the email was accepted by the Email Service, else 0
  detail  TEXT               -- the error that triggered the alert, or the send error when ok = 0
);
CREATE INDEX alerts_source_sent ON alerts (source, sent_at);

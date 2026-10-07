// hn-new-study collector.
//
// Two scheduled jobs, no HTTP surface:
//   - every 10 minutes, snapshot the official API's story lists and store each
//     response raw;
//   - once a day, record yesterday's stories from Algolia and re-measure stories
//     from three days ago.
//
// The rule throughout: store every response body exactly as received (gzipped
// in R2), and keep D1 as an index of what was captured. Nothing is parsed here
// that the analysis might want to parse differently later. The only parsing is
// of Algolia pages, to fill the `stories` tables, and those pages are kept raw too.
//
// All stored times are epoch seconds, UTC.

const USER_AGENT = "hn-new-study/0.1 (+https://github.com/levimbraga/hn-new-study)";

// Must match the snapshot entry in wrangler.jsonc. Any other cron runs the daily job,
// which lets a one-off cron expression trigger the daily job without an HTTP endpoint.
const SNAPSHOT_CRON = "*/10 * * * *";

// news.ycombinator.com answers every request from Cloudflare Workers with HTTP 419
// "Sorry" (see the amendment in docs/METHOD.md), so the Worker does not request
// that host at all. The snapshots come from APIs instead:
//   - newstories.json is the list behind /newest (newest first, up to 500 ids);
//   - showstories.json is the list behind /show (ranked), kept for comparison;
//   - the 50 most recent Show HN stories from Algolia, to reconstruct /shownew
//     independently of the 500-id limit of newstories.json.
const SNAPSHOT_SOURCES = [
  { source: "newstories_json", url: "https://hacker-news.firebaseio.com/v0/newstories.json", ext: "json" },
  { source: "showstories_json", url: "https://hacker-news.firebaseio.com/v0/showstories.json", ext: "json" },
  { source: "algolia_shownew", url: "https://hn.algolia.com/api/v1/search_by_date?tags=story%2Cshow_hn&hitsPerPage=50", ext: "json" },
];

const RETRY_DELAY_MS = 20_000;
const FETCH_TIMEOUT_MS = 30_000;

// Algolia returns at most 1000 hits per query regardless of paging, and a UTC day
// has more stories than that, so a day is split into hours when needed.
const ALGOLIA_HITS_PER_PAGE = 1000;

const FAILURES_BEFORE_ALERT = 3;
const ALERT_MIN_INTERVAL_S = 6 * 3600;
// If sending an alert fails, try again no more than hourly rather than every run.
const ALERT_RETRY_AFTER_FAILED_SEND_S = 3600;
// Dead-man check, run by the daily job on the previous UTC day.
const SLOTS_PER_DAY = 144;
const DEADMAN_MIN_CAPTURES = 140;
const DEADMAN_UNFINISHED_AFTER_S = 30 * 60;
const ALERT_FROM ={ email: "notify@ormaos.com", name: "hn-new-study" };
const ALERT_TO = "alerts@ormaos.com";

export default {
  async scheduled(controller, env, ctx) {
    const job = controller.cron === SNAPSHOT_CRON ? snapshotJob : dailyJob;
    await runJob(env, controller, job);
  },
};

// Records one `runs` row around a job, so a missing or unfinished row shows
// exactly when the collector was not working.
async function runJob(env, controller, job) {
  const scheduledAt = sec(controller.scheduledTime);
  const startedAt = nowSec();
  let runId = null;
  try {
    const row = await env.DB.prepare(
      "INSERT INTO runs (cron, scheduled_at, started_at) VALUES (?, ?, ?) RETURNING id",
    ).bind(controller.cron, scheduledAt, startedAt).first();
    runId = row.id;
  } catch (err) {
    console.error("could not insert runs row", err);
  }

  let ok = false;
  let summary;
  try {
    summary = await job(env, controller);
    ok = summary.ok;
  } catch (err) {
    summary = { ok: false, error: String(err?.stack || err) };
    console.error("job threw", err);
  }

  if (runId !== null) {
    try {
      await env.DB.prepare("UPDATE runs SET finished_at = ?, ok = ?, summary = ? WHERE id = ?")
        .bind(nowSec(), ok ? 1 : 0, JSON.stringify(summary), runId).run();
    } catch (err) {
      console.error("could not update runs row", err);
    }
  }

  if (controller.cron !== SNAPSHOT_CRON && !ok) {
    await alertDailyFailure(env, controller.cron, scheduledAt, summary);
  }
  console.log(JSON.stringify({ cron: controller.cron, scheduledAt, ok, summary }));
}

// ---------------------------------------------------------------------------
// Job 1: snapshots every 10 minutes.

async function snapshotJob(env, controller) {
  const scheduledAt = sec(controller.scheduledTime);
  const results = {};
  for (const s of SNAPSHOT_SOURCES) {
    const res = await capture(env, {
      source: s.source,
      url: s.url,
      scheduledAt,
      keyFor: (startedMs) => `raw/${s.source}/${datePath(startedMs)}/${stamp(startedMs)}.${s.ext}.gz`,
    });
    results[s.source] = res.ok ? "ok" : res.error;
  }

  // Alerting is best effort: whatever happens here, the captures above are already stored.
  for (const s of SNAPSHOT_SOURCES) {
    try {
      await checkSourceHealth(env, s.source);
    } catch (err) {
      console.error("health check failed", s.source, err);
    }
  }

  return { ok: Object.values(results).every((r) => r === "ok"), captures: results };
}

// ---------------------------------------------------------------------------
// Job 2: daily record.

async function dailyJob(env, controller) {
  const scheduledAt = sec(controller.scheduledTime);
  const today = Math.floor(scheduledAt / 86400) * 86400;
  const summary = { ok: true };

  // Yesterday's stories, first sighting.
  try {
    const day = today - 86400;
    const r = await fetchAlgoliaDay(env, "algolia_day", day, scheduledAt);
    await upsertStories(env, r.hits);
    summary.stories = { day: isoDate(day), ...r.report, stored: r.hits.length, show: r.hits.filter(isShow).length };
    if (!r.complete) summary.ok = false;
  } catch (err) {
    summary.ok = false;
    summary.stories = { error: String(err?.stack || err) };
  }

  // Stories from three days ago, re-measured.
  try {
    const day = today - 3 * 86400;
    const r = await fetchAlgoliaDay(env, "algolia_outcome", day, scheduledAt);
    await insertOutcomes(env, r.hits);
    summary.outcomes = { day: isoDate(day), ...r.report, stored: r.hits.length };
    if (!r.complete) summary.ok = false;
  } catch (err) {
    summary.ok = false;
    summary.outcomes = { error: String(err?.stack || err) };
  }

  // Dead-man check of the previous day. It reports problems by email but never
  // changes this job's own ok, so a failing check can't mask or cause a daily failure.
  try {
    summary.deadman = await deadmanCheck(env, today - 86400, today);
  } catch (err) {
    summary.deadman = { error: String(err?.stack || err) };
  }

  return summary;
}

// Checks the UTC day [dayStart, dayEnd) for problems the per-run alerts can't see:
// snapshot sources short of captures, runs that died without finishing, and a
// daily job that did not succeed. Sends at most one email per problem type per
// UTC day. Each check catches its own errors.
async function deadmanCheck(env, dayStart, dayEnd) {
  const report = {};
  const checks = {
    // Successful captures per source, counted once per 10-minute slot: a slot that
    // Cloudflare re-ran after a run died has two captures and must not count twice.
    captures: async () => {
      const short = [];
      for (const s of SNAPSHOT_SOURCES) {
        const row = await env.DB.prepare(
          `SELECT COUNT(DISTINCT scheduled_at / 600) AS n FROM captures
           WHERE source = ? AND error IS NULL AND scheduled_at >= ? AND scheduled_at < ?`,
        ).bind(s.source, dayStart, dayEnd).first();
        report[s.source] = row.n;
        if (row.n < DEADMAN_MIN_CAPTURES) short.push(`${s.source}: ${row.n} of ${SLOTS_PER_DAY}`);
      }
      return short.length ? short : null;
    },
    unfinished: async () => {
      const { results } = await env.DB.prepare(
        `SELECT id, cron, scheduled_at, started_at FROM runs
         WHERE finished_at IS NULL AND scheduled_at >= ? AND scheduled_at < ? AND started_at < ?`,
      ).bind(dayStart, dayEnd, nowSec() - DEADMAN_UNFINISHED_AFTER_S).all();
      report.unfinished = results.length;
      return results.length ? results.map((r) => `run ${r.id} (${r.cron}) scheduled ${fmt(r.scheduled_at)}`) : null;
    },
    daily: async () => {
      const row = await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM runs
         WHERE cron != ? AND ok = 1 AND scheduled_at >= ? AND scheduled_at < ?`,
      ).bind(SNAPSHOT_CRON, dayStart, dayEnd).first();
      report.daily_ok = row.n;
      return row.n === 0 ? ["no daily run recorded ok = 1"] : null;
    },
  };

  for (const [type, check] of Object.entries(checks)) {
    try {
      const problems = await check();
      if (problems === null) continue;
      report[`${type}_problem`] = problems;
      await alertDeadman(env, type, dayStart, problems);
    } catch (err) {
      report[`${type}_error`] = String(err?.message || err);
    }
  }
  return { day: isoDate(dayStart), ...report };
}

async function alertDeadman(env, type, dayStart, problems) {
  const source = `deadman_${type}`;
  const today = Math.floor(nowSec() / 86400) * 86400;
  const sentToday = await env.DB.prepare(
    "SELECT 1 FROM alerts WHERE source = ? AND ok = 1 AND sent_at >= ? LIMIT 1",
  ).bind(source, today).first();
  if (sentToday) return;
  const text = [
    `Dead-man check of ${isoDate(dayStart)} (UTC) found a problem: ${type}.`,
    "",
    ...problems,
    "",
    `Thresholds: at least ${DEADMAN_MIN_CAPTURES} of ${SLOTS_PER_DAY} slots per snapshot source,`,
    `no run unfinished after ${DEADMAN_UNFINISHED_AFTER_S / 60} minutes, one daily run with ok = 1.`,
  ].join("\n");
  await sendAlert(env, source, "failing", `[hn-new-study] dead-man check ${isoDate(dayStart)}: ${type}`, text, problems.join("; "));
}

// Fetches every story created in [dayStart, dayStart + 1 day) from Algolia.
// Tries the whole day first; if Algolia reports more hits than one query can
// return, fetches each hour separately instead. Every page is captured raw,
// including the whole-day page that turned out to be insufficient.
async function fetchAlgoliaDay(env, source, dayStart, scheduledAt) {
  const dayEnd = dayStart + 86400;
  const whole = await fetchAlgoliaWindow(env, source, "day", dayStart, dayEnd, scheduledAt);
  if (whole.failed || whole.hits.length >= whole.nbHits) {
    return {
      hits: whole.hits,
      complete: !whole.failed,
      report: { windows: "day", nbHits: whole.nbHits, pages: whole.pages, failed: whole.failed },
    };
  }

  const hits = [];
  let complete = true;
  const short = [];
  let pages = whole.pages;
  for (let h = 0; h < 24; h++) {
    const name = `h${String(h).padStart(2, "0")}`;
    const w = await fetchAlgoliaWindow(env, source, name, dayStart + h * 3600, dayStart + (h + 1) * 3600, scheduledAt);
    hits.push(...w.hits);
    pages += w.pages;
    if (w.failed || w.hits.length < w.nbHits) {
      complete = false;
      short.push(`${name}: got ${w.hits.length} of ${w.nbHits}${w.failed ? " (fetch failed)" : ""}`);
    }
  }
  return {
    hits,
    complete,
    report: { windows: "hourly", nbHitsDay: whole.nbHits, pages, incomplete: short.length ? short : undefined },
  };
}

// Pages through one time window until Algolia says there are no more pages.
// Each hit is tagged with the fetch time of the page it came from.
async function fetchAlgoliaWindow(env, source, windowName, start, end, scheduledAt) {
  const filters = encodeURIComponent(`created_at_i>=${start},created_at_i<${end}`);
  const hits = [];
  let nbHits = 0;
  let page = 0;
  let nbPages = 1;
  while (page < nbPages) {
    const n = page;
    const res = await capture(env, {
      source,
      url: `https://hn.algolia.com/api/v1/search_by_date?tags=story&numericFilters=${filters}&hitsPerPage=${ALGOLIA_HITS_PER_PAGE}&page=${n}`,
      scheduledAt,
      keyFor: (startedMs) => `raw/${source}/${datePath(start * 1000)}/${windowName}-p${n}.json.gz`,
    });
    if (!res.ok) return { hits, nbHits, pages: page, failed: true };
    const body = JSON.parse(new TextDecoder().decode(res.body));
    nbHits = body.nbHits;
    nbPages = body.nbPages;
    for (const hit of body.hits) hits.push({ hit, fetchedAt: res.startedAt });
    page++;
  }
  return { hits, nbHits, pages: page, failed: false };
}

async function upsertStories(env, hits) {
  const stmt = env.DB.prepare(
    `INSERT INTO stories (id, created_at, title, url, author, is_show, tags, points_first, comments_first, first_fetched_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       created_at = excluded.created_at, title = excluded.title, url = excluded.url,
       author = excluded.author, is_show = excluded.is_show, tags = excluded.tags`,
  );
  await batchInChunks(env, hits.map(({ hit, fetchedAt }) => stmt.bind(
    Number(hit.objectID), hit.created_at_i, hit.title ?? null, hit.url ?? null, hit.author ?? null,
    isShow({ hit }) ? 1 : 0, JSON.stringify(hit._tags ?? []), hit.points ?? null, hit.num_comments ?? null, fetchedAt,
  )));
}

async function insertOutcomes(env, hits) {
  const stmt = env.DB.prepare(
    "INSERT OR IGNORE INTO story_outcomes (id, fetched_at, points, comments) VALUES (?, ?, ?, ?)",
  );
  await batchInChunks(env, hits.map(({ hit, fetchedAt }) => stmt.bind(
    Number(hit.objectID), fetchedAt, hit.points ?? null, hit.num_comments ?? null,
  )));
}

function isShow({ hit }) {
  return Array.isArray(hit._tags) && hit._tags.includes("show_hn");
}

// ---------------------------------------------------------------------------
// Capturing: fetch, gzip, store in R2, index in D1.

// Fetches `url` with at most one retry. Every attempt gets its own `captures`
// row. Returns the raw body of the successful attempt, if any.
async function capture(env, spec) {
  let res = await captureAttempt(env, spec, 1);
  if (!res.ok) {
    await sleep(RETRY_DELAY_MS);
    res = await captureAttempt(env, spec, 2);
  }
  return res;
}

async function captureAttempt(env, spec, attempt) {
  const startedMs = Date.now();
  const row = {
    source: spec.source, url: spec.url, scheduled_at: spec.scheduledAt, started_at: sec(startedMs),
    finished_at: null, http_status: null, headers: null, bytes_raw: null, bytes_gz: null,
    sha256: null, r2_key: null, attempt, error: null,
  };
  let body = null;

  try {
    const response = await fetch(spec.url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: "manual",
    });
    row.http_status = response.status;
    row.headers = JSON.stringify(Object.fromEntries(response.headers));
    body = new Uint8Array(await response.arrayBuffer());
    row.finished_at = nowSec();
    if (!response.ok) row.error = `HTTP ${response.status}`;
  } catch (err) {
    row.finished_at = nowSec();
    row.error = `fetch failed: ${err?.name}: ${err?.message}`;
  }

  // Non-2xx bodies are stored too: an error page is evidence worth keeping.
  if (body !== null) {
    try {
      const gz = await gzip(body);
      row.bytes_raw = body.byteLength;
      row.bytes_gz = gz.byteLength;
      row.sha256 = await sha256Hex(body);
      const key = await freeKey(env, spec.keyFor(startedMs), startedMs);
      await env.RAW.put(key, gz, {
        httpMetadata: { contentType: "application/gzip" },
        customMetadata: {
          url: spec.url,
          http_status: String(row.http_status),
          content_type: JSON.parse(row.headers)["content-type"] ?? "",
          started_at: String(row.started_at),
          sha256_raw: row.sha256,
        },
      });
      row.r2_key = key;
    } catch (err) {
      row.error = [row.error, `store failed: ${err?.message || err}`].filter(Boolean).join("; ");
    }
  }

  try {
    await env.DB.prepare(
      `INSERT INTO captures (source, url, scheduled_at, started_at, finished_at, http_status, headers,
         bytes_raw, bytes_gz, sha256, r2_key, attempt, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(row.source, row.url, row.scheduled_at, row.started_at, row.finished_at, row.http_status, row.headers,
      row.bytes_raw, row.bytes_gz, row.sha256, row.r2_key, row.attempt, row.error).run();
  } catch (err) {
    // The R2 object (if any) still exists and carries its own metadata.
    console.error("could not insert captures row", row, err);
  }

  return { ok: row.error === null, error: row.error, body, startedAt: row.started_at };
}

// Never overwrite a stored object. Snapshot keys are unique by construction; Algolia
// keys are not (a re-run of the same day, or a retry after an error page), so a
// second object for the same key gets the fetch time appended.
async function freeKey(env, key, startedMs) {
  if ((await env.RAW.head(key)) === null) return key;
  return key.replace(/(\.[a-z]+\.gz)$/, `-${stamp(startedMs)}$1`);
}

// ---------------------------------------------------------------------------
// Alerts. Best effort: every path here catches its own errors.

// Sends "failing" after FAILURES_BEFORE_ALERT consecutive failed captures of a
// snapshot source, and "recovered" once it succeeds again, at most one alert per
// source per ALERT_MIN_INTERVAL_S. A capture failed when every attempt failed.
async function checkSourceHealth(env, source) {
  const { results: recent } = await env.DB.prepare(
    `SELECT scheduled_at, MIN(error IS NOT NULL) AS failed FROM captures
     WHERE source = ? AND scheduled_at IS NOT NULL
     GROUP BY scheduled_at ORDER BY scheduled_at DESC LIMIT ?`,
  ).bind(source, FAILURES_BEFORE_ALERT).all();
  if (recent.length === 0) return;

  const failing = recent.length === FAILURES_BEFORE_ALERT && recent.every((r) => r.failed === 1);
  const healthy = recent[0].failed === 0;
  const lastSent = await env.DB.prepare(
    "SELECT kind, sent_at FROM alerts WHERE source = ? AND ok = 1 ORDER BY sent_at DESC LIMIT 1",
  ).bind(source).first();
  const state = lastSent?.kind ?? "recovered";

  let kind = null;
  if (failing && state === "recovered") kind = "failing";
  else if (healthy && state === "failing") kind = "recovered";
  if (kind === null || !(await mayAlert(env, source, lastSent))) return;

  const lastError = await env.DB.prepare(
    "SELECT started_at, error FROM captures WHERE source = ? AND error IS NOT NULL ORDER BY started_at DESC LIMIT 1",
  ).bind(source).first();
  const lastOk = await env.DB.prepare(
    "SELECT started_at FROM captures WHERE source = ? AND error IS NULL ORDER BY started_at DESC LIMIT 1",
  ).bind(source).first();

  const subject = kind === "failing"
    ? `[hn-new-study] ${source} failing (${FAILURES_BEFORE_ALERT} consecutive captures)`
    : `[hn-new-study] ${source} recovered`;
  const text = [
    `Source: ${source}`,
    `State: ${kind}`,
    `Last error: ${lastError?.error ?? "none"}`,
    `Last error at: ${fmt(lastError?.started_at)}`,
    `Last successful capture at: ${fmt(lastOk?.started_at)}`,
    `Recent captures (newest first): ${recent.map((r) => `${fmt(r.scheduled_at)} ${r.failed ? "failed" : "ok"}`).join(", ")}`,
    "",
    "Alerts for a source are limited to one per 6 hours.",
  ].join("\n");
  await sendAlert(env, source, kind, subject, text, lastError?.error ?? null);
}

async function alertDailyFailure(env, cron, scheduledAt, summary) {
  try {
    const lastSent = await env.DB.prepare(
      "SELECT kind, sent_at FROM alerts WHERE source = 'daily' AND ok = 1 ORDER BY sent_at DESC LIMIT 1",
    ).first();
    if (!(await mayAlert(env, "daily", lastSent))) return;
    const text = [
      `The daily job (cron "${cron}") scheduled at ${fmt(scheduledAt)} did not complete cleanly.`,
      `Finished at: ${fmt(nowSec())}`,
      "",
      "Summary:",
      JSON.stringify(summary, null, 2),
    ].join("\n");
    await sendAlert(env, "daily", "failing", "[hn-new-study] daily job failed", text, JSON.stringify(summary));
  } catch (err) {
    console.error("daily alert failed", err);
  }
}

async function mayAlert(env, source, lastSent) {
  const now = nowSec();
  if (lastSent && now - lastSent.sent_at < ALERT_MIN_INTERVAL_S) return false;
  const lastFailedSend = await env.DB.prepare(
    "SELECT sent_at FROM alerts WHERE source = ? AND ok = 0 ORDER BY sent_at DESC LIMIT 1",
  ).bind(source).first();
  return !(lastFailedSend && now - lastFailedSend.sent_at < ALERT_RETRY_AFTER_FAILED_SEND_S);
}

async function sendAlert(env, source, kind, subject, text, detail) {
  let ok = 1;
  try {
    await env.ALERT.send({ from: ALERT_FROM, to: ALERT_TO, subject, text });
  } catch (err) {
    ok = 0;
    detail = `send failed: ${err?.message || err}`;
    console.error("alert send failed", err);
  }
  try {
    await env.DB.prepare("INSERT INTO alerts (source, kind, sent_at, ok, detail) VALUES (?, ?, ?, ?, ?)")
      .bind(source, kind, nowSec(), ok, detail).run();
  } catch (err) {
    console.error("could not record alert", err);
  }
}

// ---------------------------------------------------------------------------
// Helpers.

async function gzip(bytes) {
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function sha256Hex(bytes) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (b) => b.toString(16).padStart(2, "0")).join("");
}

// D1 batches run as one transaction; chunking keeps each one small.
async function batchInChunks(env, statements, size = 100) {
  for (let i = 0; i < statements.length; i += size) {
    await env.DB.batch(statements.slice(i, i + size));
  }
}

function sleep(ms) {
  return ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve();
}

function sec(ms) {
  return Math.floor(ms / 1000);
}

function nowSec() {
  return sec(Date.now());
}

// "2026-09-30T16:20:05Z" -> "20260930T162005Z"
function stamp(ms) {
  return new Date(ms).toISOString().replace(/\.\d{3}/, "").replace(/[-:]/g, "");
}

// "YYYY/MM/DD" in UTC.
function datePath(ms) {
  return new Date(ms).toISOString().slice(0, 10).replace(/-/g, "/");
}

function isoDate(s) {
  return new Date(s * 1000).toISOString().slice(0, 10);
}

function fmt(s) {
  return s == null ? "never" : `${new Date(s * 1000).toISOString()} (${s})`;
}

# hn-new-study

How long does a new Hacker News submission stay on the first page of
[/newest](https://news.ycombinator.com/newest), and of
[/shownew](https://news.ycombinator.com/shownew), depending on the hour of the
week it is submitted?

This repository is the data collector for that question. It is a small
Cloudflare Worker that snapshots the lists behind those pages every 10 minutes,
through Hacker News's official API and the Algolia HN Search API, and keeps a daily
record of all submitted stories, from 2026-09-30 until the end of November 2026. The analysis will be written later, by hand, following the plan in
[docs/METHOD.md](docs/METHOD.md), which was written and committed before any data
was looked at.

**Status:** collecting since 2026-09-30. The analysis and the dataset will be
published with the write-up.

## The question

A new story on HN appears at the top of /newest and is pushed down as newer
stories arrive. Once 30 newer stories have arrived, it drops off the first page,
where most readers of /newest see it. The same happens on /shownew, with Show HN
posts only. So the time a story spends on the first page depends on how busy
the site is when it is submitted, which varies by hour and day of the week.

The goal is a table: for each hour of the week, the median time a story spends on
the first page of /newest and of /shownew, with its spread and sample size.
[docs/METHOD.md](docs/METHOD.md) has the details.

## What is collected

Every response is stored **raw, gzipped, exactly as received**, in a private R2
bucket. A D1 database indexes the captures and holds a per-story table built from
the Algolia responses. Nothing that the analysis might want to parse differently
is parsed at collection time.

### Every 10 minutes (cron `*/10 * * * *`)

Three requests, in this order, within a few seconds:

| source | URL | role |
|---|---|---|
| `newstories_json` | `https://hacker-news.firebaseio.com/v0/newstories.json` | the list behind /newest, newest first (500 ids); its first 30 ids are the first page |
| `showstories_json` | `https://hacker-news.firebaseio.com/v0/showstories.json` | the list behind /show (ranked), kept for comparison |
| `algolia_shownew` | `https://hn.algolia.com/api/v1/search_by_date?tags=story%2Cshow_hn&hitsPerPage=50` | the 50 most recent Show HN stories, to reconstruct the first page of /shownew |

The first page of /shownew is reconstructed from these, as defined in
[docs/METHOD.md](docs/METHOD.md) (Amendment 1).

#### Why not the pages themselves

The collector was built to fetch the HTML of /newest and /shownew. Once deployed,
every request from the Worker to `news.ycombinator.com` was answered with HTTP 419
and a 6-byte body, `Sorry`, while the same request from a home connection
succeeded. HN appears to refuse traffic from Cloudflare Workers. The collector
does not try to get around that; since 2026-09-30 about 17:00 UTC it sends no
requests to `news.ycombinator.com` at all. The refused responses are kept in
the data, and the evidence and the effect on the method are in
[docs/METHOD.md](docs/METHOD.md), Amendment 1.

For the same reason, HN's `robots.txt` is not captured by the Worker. It is saved
by hand at the start and at the end of the study, in [docs/robots/](docs/robots/).

### Once a day (cron `20 3 * * *`, UTC)

1. **Yesterday's stories.** All stories created from yesterday 00:00:00 UTC to
   today 00:00:00 UTC, from the [Algolia HN Search API](https://hn.algolia.com/api):
   `search_by_date?tags=story&numericFilters=created_at_i>=START,created_at_i<END&hitsPerPage=1000&page=N`.
   Algolia returns at most 1000 hits per query, and a day usually has more (2026-09-29
   had 1272), so when the whole-day query is incomplete the day is re-fetched as
   24 one-hour windows. Every page is stored raw, including the incomplete
   whole-day page. Each story is written to the `stories` table, with its points
   and comment count at that first fetch.
2. **Outcomes.** Stories created on the full UTC day three days earlier are
   fetched again the same way, and their points and comments at that moment go
   into `story_outcomes`.

## Request volume

All requests send
`User-Agent: hn-new-study/0.1 (+https://github.com/levimbraga/hn-new-study)`.
A request that fails (network error or non-2xx status) is retried once, after 20
seconds. The failure is then recorded, and the collector moves on.

| host | per hour | per day | what |
|---|---|---|---|
| `hacker-news.firebaseio.com` | 12 | 288 | two JSON lists every 10 minutes |
| `hn.algolia.com` | 6, plus the daily burst | 146 to 194 | the latest 50 Show HN stories every 10 minutes (144 a day); once a day, one whole-day query for each of two days, plus 24 hourly queries for a day with more than 1000 stories (most weekdays) |
| `news.ycombinator.com` | 0 | 0 | none since 2026-09-30 about 17:00 UTC (see above) |

With retries, the worst case is twice these numbers.

## Storage layout

### R2 (bucket `hn-new-study-raw`, private)

Every object is gzip-compressed. Once decompressed, it is byte-for-byte the response body.

```
raw/{source}/{YYYY}/{MM}/{DD}/{YYYYMMDD}T{HHMMSS}Z.json.gz   snapshots (UTC fetch start time)
raw/algolia_day/{YYYY}/{MM}/{DD}/{window}-p{n}.json.gz        yesterday's stories (date = the day covered)
raw/algolia_outcome/{YYYY}/{MM}/{DD}/{window}-p{n}.json.gz    re-fetch three days later (date = the day covered)
```

The bucket also holds the refused responses from 2026-09-30, 16:20 to 16:52 UTC,
under `raw/newest_html/`, `raw/shownew_html/` and `raw/robots_txt/` (6-byte
`Sorry` bodies, with `.html.gz` and `.txt.gz` extensions).

`{window}` is `day` for the whole-day query, or `h00` to `h23` for hourly windows.
Objects are never overwritten: if an Algolia key already exists (for example a
manual re-run of the same day), the new object gets the fetch time appended,
as in `h07-p0-20260930T161215Z.json.gz`. Each object also carries metadata with
the URL, HTTP status, original content type, fetch time and the SHA-256 of the
decompressed body.

### D1 (database `hn-new-study`)

The full schema, with a comment on every column, is in
[migrations/0001_init.sql](migrations/0001_init.sql). All times are epoch seconds
in UTC.

- `captures`: one row per HTTP attempt, successful or not: source, URL,
  scheduled and actual times, HTTP status, response headers, raw and gzipped
  sizes, SHA-256 of the raw body, R2 key, attempt number, error. A retried
  request has two rows.
- `stories`: one row per story (HN item id), from the daily Algolia fetch:
  submission time, title, URL, author, whether it is a Show HN, raw Algolia tags,
  points and comments at first fetch.
- `story_outcomes`: points and comments per story, re-measured about three days
  after submission.
- `runs`: one row per cron invocation, with a JSON summary. A row whose
  `finished_at` is empty means that invocation died.
- `alerts`: every failure or recovery email the collector tried to send.

The `source` values in use are `newstories_json`, `showstories_json`,
`algolia_shownew`, `algolia_day` and `algolia_outcome`. The comment in the
migration also lists `newest_html`, `shownew_html` and `robots_txt`, which were
only captured (and refused) on 2026-09-30. `algolia_shownew` was added after the
migration was applied.

## Checking health

With access to the Cloudflare account:

```sh
# Last runs and whether they succeeded
npx wrangler d1 execute hn-new-study --remote --command \
  "SELECT id, cron, datetime(scheduled_at,'unixepoch') AS scheduled, ok, summary FROM runs ORDER BY id DESC LIMIT 10"

# Failed attempts in the last 24 hours
npx wrangler d1 execute hn-new-study --remote --command \
  "SELECT source, datetime(started_at,'unixepoch') AS at, attempt, http_status, error FROM captures
   WHERE error IS NOT NULL AND started_at > unixepoch() - 86400 ORDER BY started_at DESC"

# Successful captures per source per day
npx wrangler d1 execute hn-new-study --remote --command \
  "SELECT source, date(started_at,'unixepoch') AS day, COUNT(*) FROM captures
   WHERE error IS NULL GROUP BY source, day ORDER BY day DESC, source"

# Stories per day, and how many are Show HN
npx wrangler d1 execute hn-new-study --remote --command \
  "SELECT date(created_at,'unixepoch') AS day, COUNT(*), SUM(is_show) FROM stories GROUP BY day ORDER BY day DESC"
```

A healthy day has 144 successful captures of each snapshot source. The
collector emails an alert when a snapshot source fails three captures in a row,
another when it recovers (at most one email per source per 6 hours), and one
when the daily job fails.

## Running your own copy

You need a Cloudflare account on the Workers Paid plan, with R2 enabled, and
Node.js for `npx wrangler`. There are no npm dependencies.

```sh
npx wrangler d1 create hn-new-study --location enam
# put the printed database_id into wrangler.jsonc
npx wrangler r2 bucket create hn-new-study-raw
npx wrangler d1 migrations apply hn-new-study --remote
npx wrangler deploy
```

Before you deploy:

- Change the `User-Agent` in `src/index.js` so it points to your own contact.
- Replace the `send_email` binding and the `ALERT_FROM` / `ALERT_TO` addresses. The sender
  must be on a domain onboarded to Cloudflare Email Service, and the destination
  must be a verified address. You can also remove the alert code entirely.

To test locally, run `npx wrangler d1 migrations apply hn-new-study --local`, then
`npx wrangler dev --test-scheduled`, and trigger a run:

```sh
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=*%2F10+*+*+*+*"   # snapshots
curl "http://localhost:8787/cdn-cgi/local/scheduled?cron=20+3+*+*+*"       # daily job
```

Add `&time=<epoch milliseconds>` to set the scheduled time explicitly; the daily
job works on the days before that time.

The deployed Worker has no HTTP endpoint, so there is no URL to trigger a run.
To run the daily job once outside its schedule, deploy with one extra cron
expression a few minutes ahead (any cron other than `*/10 * * * *` runs the
daily job), then deploy again without it. The `runs` table records which
cron fired.

## License

[Apache License 2.0](LICENSE).

# hn-new-study

How long does a new Hacker News submission stay on the first page of
[/newest](https://news.ycombinator.com/newest), and of
[/shownew](https://news.ycombinator.com/shownew), depending on the hour of the
week it is submitted?

This repository is the data collector for that question. It is a small
Cloudflare Worker that takes snapshots of those pages every 10 minutes and keeps
a daily record of all submitted stories, from 2026-09-30 until the end of
November 2026. The analysis will be written later, by hand, following the plan in
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

Four requests, in this order:

| source | URL |
|---|---|
| `newest_html` | `https://news.ycombinator.com/newest` |
| `shownew_html` | `https://news.ycombinator.com/shownew` |
| `newstories_json` | `https://hacker-news.firebaseio.com/v0/newstories.json` |
| `showstories_json` | `https://hacker-news.firebaseio.com/v0/showstories.json` |

The two HTML pages are the measurement itself: the first 30 items as a visitor
sees them. The Firebase lists are captured alongside to cross-check the HTML
(`showstories_json` in particular, to verify which page it mirrors).

HN's `robots.txt` asks for `Crawl-delay: 30`. The collector waits at least 30
seconds after one request to `news.ycombinator.com` finishes before sending the
next, so `/shownew` is fetched about 30 seconds after `/newest`. Each capture
records its own start time, so this offset is visible in the data.

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
3. **Policy on record.** HN's `robots.txt` is captured, 5 minutes after the cron
   time. This keeps it clear of the 03:20 snapshot run's requests to the same host,
   so any policy change during the study is documented.

## Request volume

All requests send
`User-Agent: hn-new-study/0.1 (+https://github.com/levimbraga/hn-new-study)`.
A request that fails (network error or non-2xx status) is retried once: after 30
seconds for `news.ycombinator.com` (its crawl delay), after 20 seconds for the
other hosts. The failure is then recorded, and the collector moves on.

| host | per hour | per day | what |
|---|---|---|---|
| `news.ycombinator.com` | 12 | 289 | /newest and /shownew every 10 minutes, robots.txt once a day |
| `hacker-news.firebaseio.com` | 12 | 288 | two JSON lists every 10 minutes |
| `hn.algolia.com` | 0 (all in one burst, once a day) | 2 to 50 | one whole-day query for each of the two days; for a day with more than 1000 stories (most weekdays), 24 hourly queries in addition |

With retries, the worst case is twice these numbers. Requests to
`news.ycombinator.com` are never less than 30 seconds apart within a run, and
runs are 10 minutes apart.

## Storage layout

### R2 (bucket `hn-new-study-raw`, private)

Every object is gzip-compressed. Once decompressed, it is byte-for-byte the response body.

```
raw/{source}/{YYYY}/{MM}/{DD}/{YYYYMMDD}T{HHMMSS}Z.{html|json}.gz   snapshots (UTC fetch start time)
raw/algolia_day/{YYYY}/{MM}/{DD}/{window}-p{n}.json.gz               yesterday's stories (date = the day covered)
raw/algolia_outcome/{YYYY}/{MM}/{DD}/{window}-p{n}.json.gz           re-fetch three days later (date = the day covered)
raw/robots_txt/{YYYY}/{MM}/{DD}/{YYYYMMDD}T{HHMMSS}Z.txt.gz
```

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

The daily job waits until 5 minutes after its scheduled time before fetching
robots.txt. Add `&time=<epoch milliseconds>` to set the scheduled time in the past.

## License

[Apache License 2.0](LICENSE).

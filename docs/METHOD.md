# Analysis plan

Written on 2026-09-30, before data collection started, and committed to this
public repository so it can't later be changed to fit the results. The only data seen
at that point were test captures made to check that the collector works: a few
snapshots, and the story counts for 2026-09-27 (715) and 2026-09-29 (1272).

Any change to this plan after data collection starts will be listed under
[Deviations](#deviations) at the end, with a date and a reason. Nothing above
that section will be edited except to fix typos.

## Question

For a story submitted to Hacker News at a given hour of the week, how long does
it stay on the first page (the first 30 items) of `/newest`? And for a Show HN
story, how long on the first page of `/shownew`?

## Study period

- Collection: from the first snapshot on 2026-09-30 until 2026-11-30 23:59:59 UTC.
- Stories included: submitted (`created_at`) from the first full UTC day of
  collection, 2026-10-01 00:00:00 UTC, onwards, and early enough that their
  first-page dwell ends before collection stops. In practice, stories whose
  modelled exit time is after the last successful snapshot are excluded as
  censored.

## Definitions

- **Submission time**: the story's `created_at` from Algolia (epoch seconds, UTC).
- **First page**: the first 30 items of the page as served to a logged-out
  visitor, which is what the collector fetches.
- **First-page dwell**: the time from submission until the story is no longer
  among the first 30 items.

## The model

`/newest` lists stories newest first. So a story drops off its first page when
30 newer stories have been submitted after it. Its modelled dwell is:

> dwell_newest(s) = created_at(the 30th story submitted after s) - created_at(s)

using every story in the `stories` table, ordered by HN item id. Item ids are assigned
in submission order, so they break ties between equal `created_at` values.

For `/shownew` the same, counting only Show HN stories (`is_show = 1`):

> dwell_shownew(s) = created_at(the 30th Show HN story submitted after s) - created_at(s)

The model is computed for every story, so its sample sizes are much larger and
its time resolution (one second) much finer than the snapshots allow. That is
why it is the primary estimate, subject to the validation below.

The assumption that `/shownew` is a newest-first list of Show HN stories is checked
directly: in each `/shownew` snapshot, are the items in descending id order, and
are they all Show HN? The same check is applied to `/newest`. The captured
`showstories_json` list is compared with the `/shownew` snapshots to see which
page it mirrors, but the analysis does not depend on the answer.

## Validation against the snapshots

The snapshots give a direct but coarse observation. For each story that appears
on a first page in at least one snapshot:

- **last seen**: the start time of the last snapshot in which it is on the first page;
- **first gone**: the start time of the next successful snapshot of the same page,
  where it is not on the first page.

The observed dwell lies between `last seen - created_at` and
`first gone - created_at`. The point estimate is the midpoint. If a snapshot is
missing between those two times, the interval simply widens. If there is no
successful snapshot after "last seen" within 60 minutes, the story is excluded
from validation as unobserved.

The model is validated against this interval for each page separately:

- the share of stories whose modelled dwell falls inside the observed interval;
- the error of the model against the midpoint: median and mean signed error
  (bias), and median absolute error, in minutes;
- the same numbers by hour of the week, to see whether the error depends on how
  busy the site is.

**Decision rule, fixed now:** the model stays the primary estimate if its median
absolute error against the midpoint is at most 10 minutes (one sampling interval)
and its median signed error is within 5 minutes of zero, on each page. If it fails
either test on a page, the observed midpoint becomes the primary estimate for that
page. The model is then reported as secondary, with its error.

### Stories that leave early

Some stories leave the first page before 30 newer ones arrive: they are flagged,
killed, deleted, or removed by moderators. Using only the snapshots, a story is
counted as **vanished early** when it is on the first page at rank `r` in one
snapshot and absent from the next successful snapshot of that page, even though
the number of newer items in that next snapshot is less than `31 - r`, so it
should still have been within the first 30. For each vanished story the report notes
whether it appears in the Algolia `stories` table, whether it appears in
`story_outcomes` three days later, and its tags there. This splits vanished
stories into roughly "flagged or dead but still indexed" and "deleted or
not indexed". HN item states are not fetched individually. That limit is stated,
not worked around.

The number and share of vanished-early stories are reported by page and by hour
of the week. They are excluded from the model error figures above and reported
separately, because the model cannot predict them by design. The output tables
describe stories that were not removed. A story that is flagged spends less time
on the page than the table suggests.

The reverse also exists: items that are on the first page but not in Algolia (or
not at the expected position). Their count is reported. They enter the model
only through Algolia's list, so any such gap is part of the model error.

## Outputs

For each page (`/newest`, `/shownew`), a table with one cell per day of week
(Monday to Sunday) and hour (00 to 23), 168 cells. Each cell has:

- the median first-page dwell of the stories submitted in that hour of the week,
  in minutes;
- the interquartile range (25th and 75th percentiles);
- the number of stories in the cell.

Cells are not suppressed for small samples. Cells with fewer than 20 stories are
marked. For `/shownew`, where there are fewer stories, the same table is also
given by 3-hour block (8 per day) as a coarser, more stable view.

### Time zones

All stored times are UTC, and binning is done on UTC timestamps. The primary
table uses **UTC** day of week and hour.

The same tables are also shown in **US Pacific time** (`America/Los_Angeles`,
where HN is run) and **US Eastern time** (`America/New_York`). Each story's
timestamp is converted individually with the IANA time zone database before
binning, never by shifting the finished UTC table by a fixed offset. That matters
because US daylight saving time ends during the study, on **2026-11-01**:

- Before 2026-11-01 09:00 UTC, Pacific time is UTC-7 (PDT). From then on it is UTC-8 (PST).
- Before 2026-11-01 06:00 UTC, Eastern time is UTC-4 (EDT). From then on it is UTC-5 (EST).
- On 2026-11-01, local 01:00 to 01:59 happens twice. Stories from both occurrences
  go into the Sunday 01:00 local cell, which therefore covers two hours of real time on
  that one day. This is noted in the table, and the count of affected stories is given.

A local-time table is used because people post by their local clock, and a site
with many US users could follow US local time more closely than UTC. Whether it
does is visible by comparing weeks before and after 2026-11-01. The primary result
does not depend on this choice, since the UTC table is always reported.

## Known limitations

- **Sampling interval.** Snapshots are 10 minutes apart. At the busiest hours a
  story can leave the first page of `/newest` in under 20 minutes, so the
  observed dwell is only known to within 10 minutes. A story that enters and leaves
  between two snapshots is never observed. This is why the model, not the
  snapshots, is the primary estimate, provided it validates.
- **Offset between pages.** Because of HN's 30-second crawl delay, `/shownew` is
  fetched about 30 seconds after `/newest` in each run. The Firebase lists are
  fetched a second or two after that. All comparisons use each capture's own start time.
- **Missing captures.** Network errors, HN errors, or Cloudflare problems can
  lose a snapshot. Every attempt, failed or not, is recorded in `captures`, and
  the report gives the number of missing snapshots per page and per week. A
  missing snapshot widens observed intervals as described above. It does not
  affect the model.
- **Algolia completeness.** The model is only as complete as Algolia's index at
  03:20 UTC the next day. Stories that were deleted before then, or never indexed,
  are missing. Stories killed or flagged may still be indexed. The report compares
  story counts per hour against the ids seen in the snapshots and in
  `newstories_json`, to estimate how many stories Algolia misses.
- **Ranking changes by HN.** If HN changes how `/newest` or `/shownew` work (for
  example, filtering new accounts or holding stories back), the model's
  assumptions can break without warning. The order checks above run for every
  snapshot, and any sustained break is reported with its dates.
- **Logged-out view.** The collector sees what a logged-out visitor sees.
  Logged-in users with `showdead` on, or with different settings, may see a
  different first page.
- **Two months, one season.** The study covers October and November 2026 only,
  so seasonal effects and holidays (for example US Thanksgiving, 2026-11-26) are
  in the data and are not controlled for. As a sensitivity check, the tables are
  also given without the week of 2026-11-23.
- **Points and comments.** These are recorded, at first fetch and after about
  three days, to describe the stories, not to answer the main question. Any
  analysis relating dwell to outcomes is exploratory and will be labelled as such.

## Deviations

None yet.

## Amendment 1, 2026-09-30: no HTML snapshots

This is the first deviation from the plan above. The "None yet" above was true
when the plan was committed (commit `9b9b65b`), and the plan above is left as it
was written. Where this amendment conflicts with it, this amendment applies.

### What happened

The collector was deployed on 2026-09-30 at about 16:15 UTC. From the deployed
Cloudflare Worker, every request to `news.ycombinator.com` was refused:

- 18 attempts between 16:20:28 and 16:52:00 UTC (`/newest`, `/shownew`, and
  `/robots.txt`, first attempts and retries), all answered with **HTTP 419**.
- Every body was the same 6 bytes, `Sorry\n` (SHA-256 `21676075593979e03a80a302b8c0abfc39a1fe1302f1e9b24c87ca8ccc12c5fb`).
- Response headers: `content-type: text/plain; charset=utf-8`,
  `content-length: 6`, `etag: "6aa07eca-6"`, `server: cloudflare`, and a
  `cf-ray` ending in `-BOM` (the request left Cloudflare from Mumbai). The etag has
  nginx's format (file modification time and size in hex). It decodes to a
  6-byte file last modified on 2026-09-08, so this looks like a static refusal
  page served by HN's own server.
- The first request of the day was already refused. The collector sent at most
  two requests per minute to that host, below the `Crawl-delay: 30` in
  robots.txt. So the refusal is not a response to our rate.
- The same request, with the same User-Agent, from the maintainer's home connection
  (Brazil, residential IPv6) at 16:57:53 UTC returned HTTP 200 and the full page,
  with `server: nginx` and no Cloudflare headers.

This is consistent with HN refusing requests that come from Cloudflare Workers.
The data can't tell whether it keys on Cloudflare's egress IP addresses or on the
`CF-Worker` header that Cloudflare adds to Worker requests. Finding out would take
more requests to a site that had just refused us, so we didn't make them. The
raw 419 responses and their `captures` rows are kept as evidence. The
collector does not try to work around the refusal.

HN's `robots.txt` as fetched from the maintainer's machine on 2026-09-30 allowed
`/newest` and `/shownew` and set `Crawl-delay: 30`. Its disallowed paths
were `/collapse?`, `/context?`, `/fave?`, `/flag?`, `/hide?`, `/login`, `/logout`,
`/r?`, `/reply?`, `/submitlink?`, `/vote?` and `/x?`. The Worker's daily capture of
robots.txt was refused like everything else, so that capture was removed from the
Worker on 2026-09-30. Its two refused responses are kept with the other 419s. From
then on, robots.txt is saved by hand (see the addendum below).

### What changed

From 2026-09-30 about 17:07 UTC, the snapshots every 10 minutes are:

| source | request | role |
|---|---|---|
| `newstories_json` | `hacker-news.firebaseio.com/v0/newstories.json` | the list behind `/newest`, newest first, up to 500 ids |
| `showstories_json` | `hacker-news.firebaseio.com/v0/showstories.json` | the list behind `/show` (ranked), kept for comparison only |
| `algolia_shownew` | `hn.algolia.com/api/v1/search_by_date?tags=story,show_hn&hitsPerPage=50` | the 50 most recent Show HN stories, to reconstruct `/shownew` |

`newest_html`, `shownew_html` and `robots_txt` are no longer requested. The daily
Algolia record is unchanged.

### Evidence that the API lists stand in for the pages

Before deploying, one local test run fetched all four original sources within
33 seconds (2026-09-30, 16:05:37 to 16:06:10 UTC, from the maintainer's
machine). In that one aligned sample:

- The 30 ids on `/newest` were exactly `newstories.json[1:31]`. The one-item
  offset is a story (id 49910726) submitted in the 32 seconds between the two
  requests.
- All 30 ids on `/shownew` were in `newstories.json`, in the same order, at positions
  2 to 251 (of 500), and in descending id order.
- `showstories.json` is not `/shownew`: only 2 of its first 30 ids were on `/shownew`.

That is one sample, not a proof. The analysis reports this comparison as
the only direct check of the page-to-API correspondence, and treats the correspondence as an assumption.

### Revised definitions

- **First page of `/newest`** at a snapshot: the first 30 ids of that
  snapshot's `newstories.json`.
- **First page of `/shownew`** at a snapshot: the first 30 ids of that snapshot's
  `newstories.json` whose story has `is_show = 1` in the `stories` table
  (reconstruction A). If fewer than 30 such ids are among the 500, the snapshot
  is marked incomplete for `/shownew`.
- **Cross-check for `/shownew`** (reconstruction B): the first 30 hits of
  that snapshot's `algolia_shownew` response whose ids are also present in
  the same snapshot's `newstories.json`. The filter drops stories that Algolia
  still lists but that are no longer live. A and B are compared at every snapshot,
  and the share of snapshots where they agree exactly is reported. Where A is
  incomplete, B is used and the count of such snapshots is reported. The Algolia list can
  lag new submissions by a short indexing delay. Disagreements caused by the
  newest story alone are counted separately.

### Effect on the validation

- The model is unchanged. It is still computed from the daily Algolia record, and
  is still the primary estimate under the same decision rule.
- The observed dwell ("last seen" and "first gone") is now measured on the
  API lists defined above instead of on the HTML pages. The 10-minute interval,
  the midpoint, the 60-minute rule for missing snapshots, and the definition of
  "vanished early" all stay the same, applied to those lists.
- The validation is now less independent than planned. The model and the
  `/shownew` reconstruction both depend on Algolia's `show_hn` tag. The
  `/newest` observation comes from HN's own API rather than from what a visitor
  sees. What it still tests is whether "30 later submissions" predicts when a
  story leaves the live list, including removals the model can't see.
  What it no longer tests is whether the rendered pages behave like the API
  lists. The single aligned sample above is the only evidence on that point.
- The "Logged-out view" limitation becomes an "API view" limitation. The
  "Offset between pages" limitation no longer applies: the three snapshot requests
  are sent within a few seconds of each other, and each capture keeps its own
  start time.
- The "Ranking changes by HN" check (ids in descending order on each first page)
  is applied to `newstories.json`. For `/shownew` it holds by construction, so
  it can't detect a change there.
- The study period and inclusion rule are unchanged. The HTML captures
  from 2026-09-30 (all refused) contribute nothing to the analysis.

### Addendum, 2026-09-30: robots.txt recorded by hand

Because the Worker no longer contacts `news.ycombinator.com`, HN's crawl policy
is no longer captured daily. Instead, the maintainer saves `robots.txt` from their
own machine at the start and at the end of the study, and commits each copy to
[docs/robots/](robots/) with its date, fetch time and SHA-256. The first copy was
saved on 2026-09-30 at 17:14:39 UTC. It is identical to the policy quoted above.
A policy change between those two dates would not be detected.

## Observations during collection

Facts about the collected data noticed while collection is running, and how the
analysis handles them. The plan above is unchanged except where an entry says
it is a deviation.

### 2026-10-07: scheduled_at is offset from the slot

`scheduled_at` (Cloudflare's `scheduledTime` for the cron run) is not on the
10-minute boundary. It arrives with a fixed offset: 28 seconds for the ten runs
from 2026-09-30 16:20 to 17:50 UTC, and 38 seconds for every run since 18:00
UTC that day. The analysis therefore assigns each capture to its 10-minute slot,
`scheduled_at / 600 * 600`, and groups by slot. It never matches `scheduled_at`
by equality to a slot time.

### 2026-10-07: a slot can be run twice

Run 1018 (slot 2026-10-07 16:30 UTC) started at 16:31:36, captured
`newstories_json` and `showstories_json`, and then died before `algolia_shownew`.
Its `runs` row has no `finished_at`. Cloudflare ran the same slot again at
16:38:16 (run 1019), which captured all three sources. Nothing was lost, but
that slot has two successful captures of two sources. The analysis
deduplicates captures per source per slot. Both captures are kept in the
data. The analysis uses the first successful one, and reports how many slots
had more than one.

### 2026-10-07: dead and deleted stories missing from Algolia (deviation)

Between 2026-10-01 and 2026-10-06, 5,964 distinct ids appeared in at least one
`newstories_json` snapshot within the id range of that period's stories
(49916067 to 49985932). Of these, 71 (1.2%) are not in the `stories` table. On
2026-10-07 the official item API returned all 71 as type `story`: 50 dead, 20
deleted, and 1 live. The live one, 49957602 (submitted 2026-10-04 20:42 UTC),
was missing from the next day's Algolia fetch (746 hits) and present in the
outcome fetch three days later (747 hits).

This is the gap the "Algolia completeness" limitation anticipated. It matters
because a dead or deleted story still sits on `/newest` until it is removed,
pushing other stories down. This is a **deviation** from the model as defined
above, which counts only stories in the `stories` table, and from "HN item
states are not fetched individually":

- `newstories.json` is the reference for which stories existed. The model counts
  every id seen in any `newstories_json` snapshot, plus every story in the
  `stories` table.
- Items missing from the `stories` table are fetched from the official item
  API (`/v0/item/{id}.json`) at analysis time, for their submission time and
  their dead or deleted state. The number of such items, and any the API can't
  return, are reported.
- The model's dwell is reported both ways, counting all stories and counting
  only Algolia's, so the effect of this change is visible.

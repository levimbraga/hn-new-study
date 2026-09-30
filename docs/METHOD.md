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

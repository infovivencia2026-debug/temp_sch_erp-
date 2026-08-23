# Bento widget visualisation spec

The design direction for every widget on the bento boards. Written by the
product owner; this file is the source of truth, not any paraphrase of it.

## Core rule

Design every widget as a **dense information instrument**, not a card
containing a metric.

There must be **no visually dead area** inside a widget. Empty space exists
only to create hierarchy or to separate two meaningful pieces of information.
Do not enlarge a metric and leave the rest of the card blank.

## The mental model

    1x1  ->  SIGNAL
    1x2  ->  SIGNAL + MOVEMENT
    2x1  ->  SIGNAL + STRUCTURE
    2x2  ->  SIGNAL + MOVEMENT + STRUCTURE + EXPLANATION

**Every added area must add information, not whitespace.** A larger size is
never the smaller one scaled up.

## "Modern" means

NOT "fewer things on screen". It means **more information expressed with fewer
visual primitives**. A modern widget can be visually dense and still clean.

Use: thin tracks · compact dot fields · dense grids · micro timelines ·
proportional blocks · direct labels · inline annotations · restrained
typography · small reference markers · compact sparklines · data-dense
matrices · semantic emphasis.

Avoid: giant empty metric areas · decorative circles · generic donut charts ·
unnecessary gauges · giant single-number cards · oversized chart padding ·
legends where direct labels work · card-within-card structures · gradients used
purely for decoration · charts that communicate less than the number would.

## The honesty rule, which outranks density

**Do not fabricate denominators or invent data.** Three invented denominators
have already shipped and been removed from this product. If an endpoint truly
returns one number and nothing else, keep the cell typographic and dense
through HIERARCHY — size, weight, grouping, direct labels — never through a
chart with a made-up base. "Dense" is not a licence to derive.

Where this spec says "if available", it means exactly that: check the handler,
and if the field is not there, leave that element out and say so.

## Per widget

### pulse
- 1x1 — current value dominant, change vs previous period, direction mark,
  compact sparkline in the lower/side region, above/below median.
- 1x2 — value, change, 28-day trajectory given real space, median reference
  line, current endpoint, recent high and low.
- 2x1 — value, trend, subject/class distribution as compact horizontal bands
  or small multiples, median comparison, best and worst segment.
- 2x2 — large value, 28-day trajectory, median band, class x subject field,
  current marker, best/worst segment, outliers, period-over-period change.

### syllabus-behind
The primary visual is **distance between expected and actual**, not a progress bar.
- 1x1 — classes behind, completion %, compact track, change, severity.
- 1x2 — lag, completion %, expected marker, actual marker, short trajectory,
  count of contributing subjects.
- 2x1 — dense subject-progress field: expected position, actual position, gap
  and direction per subject; furthest behind highlighted.
- 2x2 — expected vs actual trajectory, subject x class matrix, lag ranking,
  completion %, periods behind, recent movement, largest lagging subject.

### mark-moderation
Core language is **distribution**.
- 1x1 — pending count, % reviewed, tiny density field, status.
- 1x2 — pending, % reviewed, compact mark distribution, mean/median, threshold.
- 2x1 — density dots, mean, median, moderation threshold, low/high bounds,
  outliers. Not a bar chart.
- 2x2 — full distribution, mean, median, threshold, outliers, subject-level
  distributions, suspicious clustering, highest deviation, % outside bands.
  The principal must be able to see whether marks are normal, compressed,
  inflated or anomalous.

### pass-rate
- 1x1 — rate, period change, reference track, small trend.
- 1x2 — rate, change, trend line, target/reference, endpoint, recent high/low.
- 2x1 — per subject: pass %, difference from overall, best/worst, compact bands.
- 2x2 — rate, trend, reference, subject x class heat strip (dense, directly
  labelled, no chart furniture), best/worst, largest improvement and
  deterioration, failing concentration.

### at-risk
Core concept is **risk concentration and severity**. Not a warning card.
- 1x1 — total, severity, high-risk count, small density visual.
- 1x2 — total, change, high/medium/low split, density field, direction.
- 2x1 — severity distribution with % of total and change per band.
- 2x2 — class/grade x severity matrix, total, high-risk count, change, largest
  concentration, below-pass population, risk contributions where available.

### grievances-open
Core concept is **queue + ageing**.
- 1x1 — open count, new count, queue-density mark, direction.
- 1x2 — open, new, active, waiting, small ageing field.
- 2x1 — continuous age distribution new->old, concentration, median age,
  oldest, light category indication.
- 2x2 — age x department/category matrix, open total, new, median age, oldest,
  nearing SLA, category and department concentration.

### grievances-overdue
Same grammar, focused on **SLA failure**.
- 1x1 — overdue count, oldest age, count beyond SLA, severity.
- 1x2 — count, change, age bands, SLA threshold, beyond-threshold count.
- 2x1 — ageing field 0-7 / 8-14 / 15-30 / 30+, SLA boundary.
- 2x2 — department x age matrix, SLA boundary, oldest, median overdue age,
  severely overdue count, category concentration, trend.

### my-leave
**No decorative ring as the primary visual.** Balance + usage history.
- 1x1 — remaining, used, compact remaining/used track, next relevant date.
- 1x2 — balance, per-type breakdown, used vs remaining, utilisation.
- 2x1 — proportional bars per leave type showing used and remaining.
- 2x2 — yearly timeline filling the area: months, leave events, type, used,
  remaining, upcoming leave, utilisation by type.

### my-pay
Core concept is **money flow** — explain how gross became net.
- 1x1 — net, change from previous month, small historical trace, period.
- 1x2 — net, gross, deductions, proportional relationship, monthly change.
- 2x1 — compact decomposition: gross, tax, other deductions, net as
  proportional blocks.
- 2x2 — 24-month net trajectory, current gross/deductions/net, deduction
  composition, MoM change, recent high/low, significant change.

### setup-progress
- 1x1 — completed/total, %, compact 15-step field, current blocking step.
- 1x2 — the full 15-step sequence as a dot/segment field with per-step state:
  completed, active, pending, blocked.
- 2x1 — steps grouped by domain (academic, staff, finance, admin, system) with
  progress per group.
- 2x2 — full field, overall %, group progress, blocking step, recently
  completed, remaining.

### cover-uncovered
Core concept is **time coverage**. Should read as an operational instrument.
- 1x1 — coverage %, uncovered count, state, compact time strip.
- 1x2 — real time axis: covered, uncovered, uncoverable, current-time marker,
  start/end times.
- 2x1 — horizontal temporal lanes: period, time, section, state, teacher.
- 2x2 — full timetable coverage field with real clock times, period
  boundaries, all three states, section, teacher, duration, now marker.

### AttentionCell (x15) — ONE attention grammar, not fifteen styles
The card must visually answer: **what happened -> how serious -> why -> what
should I care about?**
- 1x1 — label, figure, severity, tiny contextual cue, tiny directional/age
  visual.
- 1x2 — + short headline, change, micro-visual, one supporting statistic.
- 2x1 — figure, breakdown by cause/category, composition visual, severity,
  change.
- 2x2 — figure, headline, cause breakdown, trend, supporting evidence,
  oldest/largest/worst item, action-relevant detail.

### SourceCell (x10) — fact + provenance + context
- 1x1 — source label, figure, cue, small source indicator.
- 1x2 — + two-line explanation, change, micro-visual.
- 2x1 — + composition, main source, supporting context.
- 2x2 — figure, explanation, compact drawing that EXPLAINS the source data
  rather than decorating, breakdown, trend, most important supporting fact.

### Flat widgets
One number from the endpoint does not mean the widget looks empty.
- `students` — count, change if available, enrolment trace if history exists,
  grade distribution if available, largest cohort, newest admissions.
- `staff` — count, change, staff-type composition if available, department
  distribution if available.
- `approvals` — pending, queue age if available, type distribution if available.
- `applications` — count, recent change, stage composition if the endpoint
  supports it.

### Finance
- `collection` — 1x1 current + change + received/target relation; 1x2 +
  overdue + compact ageing; 2x1 + ageing distribution + largest bucket; 2x2 +
  target progress + trend + concentration. Financial decomposition and
  proportional blocks, not generic charts.
- `today` — 1x1 amount + change; 1x2 + position in period + mini trend; 2x1
  today vs period; 2x2 + daily distribution + current-day marker. Only show
  the today/period comparison when today is inside the selected range.
- `outstanding` — 1x1 amount + change + age cue; 1x2 + ageing distribution;
  2x1 age bands + concentration; 2x2 + the 48 largest as a dense RANKED FIELD,
  not a giant bar chart, + trend.

### My Work
- `outstanding` — work queue composition: 1x1 count + severity; 1x2 + by type;
  2x1 type distribution + change; 2x2 + age + priority + largest queue.
- `overdue` — queue ageing: 1x1 count + oldest age; 1x2 + ageing rail; 2x1
  age x type; 2x2 + priority + oldest items.

---
name: dwd-warning-briefing
description: >
  Produce a single ranked severe-weather briefing for Germany from the official
  DWD warning feeds, using the dwd-cli. Trigger when the user asks "any weather
  warnings in Germany right now?", "is there a storm/thunderstorm warning?",
  "what severe weather is DWD warning about?", "weather alerts for the coast",
  or wants a quick read on current official warnings. Merges the nowcast,
  Gemeinde (municipality) and coast feeds, ranks by severity, states DWD's own
  warning level (1 of 4 to 4 of 4), and reports plain-language headlines instead
  of three raw JSON envelopes.
compatibility: >
  Requires the `dwd` CLI (npm package @maschinenlesbar.org/dwd-cli) on PATH,
  installed by the user; the skill never installs it. Uses jq for JSON
  filtering. Network access to app-prod-ws.warnwetter.de and
  s3.eu-central-1.amazonaws.com (DWD static data).
---

# DWD Warning Briefing

Give the user one ranked briefing of the **official** German weather warnings that are
live right now — merging the three published warning feeds (**nowcast**, **Gemeinde**,
**coast**) into a single severity-ordered list, instead of three separate envelopes the
user has to read and reconcile.

## Tooling

This skill drives the `dwd` command. **Before anything else, validate it is available** — run `command -v dwd` (or `dwd --version`). If it is not on your PATH, STOP and inform the user that the `dwd` CLI (`@maschinenlesbar.org/dwd-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

This skill also filters JSON with `jq`. **Validate it too** — run `command -v jq`. If it is missing, inform the user that `jq` is not installed — installing it is their responsibility; never install it yourself — and carry on without it: filter the CLI output with `node -e` instead (Node is already on your PATH, since the CLI runs on it).

All data comes from the `dwd` CLI — read-only, no API key, each feed is **one command**. The job of this skill is the cross-feed merge and the severity ranking the CLI deliberately doesn't do.

Always pass `--compact` so each feed is one line, easy to pipe into `jq`. Bump
`--timeout 60000` if a feed times out. An **empty `warnings` array (or empty coast object)
with exit `0` is normal** — it means the weather is calm, which is itself the answer.

## Step 1 — Pull all three feeds

They are independent; fan them out. Default to German; pass `--lang en` only if the user
wants English (in `en`, gemeinde and coast translate `event`, the headline, description and
`instruction`; nowcast translates `event` + `descriptionText` and has **no** `headLine` at
all, so build nowcast headlines from `event`):

```bash
dwd --compact warnings nowcast
dwd --compact warnings gemeinde
dwd --compact warnings coast
```

`nowcast` and `gemeinde` share the envelope `{ time, warnings: [...], binnenSee }`.
`binnenSee` holds inland-lake warnings; with none, it came back as `null` in nowcast and `{}`
in gemeinde — both mean "nothing", so check for either.
`coast` is different: `{ time, warnings: { <zoneId>: [ ... ] }, vorabInformation }` — its
`warnings` is an **object keyed by coastal-zone id**, not an array.

The CLI adds **`staleFeed`** to each of the three: `true` when the feed's `time` (when DWD
published it, epoch ms) is more than 60 minutes old — DWD republishes every few minutes, so
publishing has stopped and newer warnings are missing — and then also logs a note on
stderr (an `INFO` record, `… INFO  [dwd.api] coast warnings: the feed was published …`). With `staleFeed: true`, say so up front ("the coast feed is 2 h old") and
don't present an empty feed as "no warnings".

## Step 2 — The fields that matter

The warning items carry (checked live on 2026-09-15 — note what **coast** items lack):

| Field | Meaning |
|---|---|
| `event` | The phenomenon, e.g. `GEWITTER`, `BÖEN`, `LEICHTER SCHNEEFALL` (uppercase in gemeinde/coast; lower/sentence case in nowcast, e.g. `starkes Gewitter`). The headline noun. |
| `level` | The feed's **severity number** — higher = worse, the primary ranking key (see Step 3). **It is not DWD's warning level**: it is DWD's level **+ 1**. Checked live on 2026-10-21 in all 18 Gemeinde warnings, twice: `level` 2 = DWD level 1 of 4 (Wetterwarnung), `level` 3 = DWD level 2 of 4 (markante Wetterwarnung). The English texts say it: `descriptionText` ends "(level 1 of 4)". Never print the raw `level` as "level N" (see Step 4). |
| `type` | DWD warning *kind* code (0 = thunderstorm group, 1 = wind, 3 = snow/frost, …). Secondary; don't over-interpret. |
| `start` / `end` | **Unix epoch in milliseconds** (nowcast/gemeinde). Divide by 1000 for a normal timestamp; an item whose `end` is in the past is stale — drop it. **Coast items have no `start`/`end`.** |
| `headLine` | German one-line headline on gemeinde, e.g. `Amtliche WARNUNG vor GEWITTER`. **Nowcast's `headLine` is just the product name `NowCastMIX`** (and absent in `--lang en`) — use `event` there. **Coast uses lowercase `headline`** — check both keys. |
| `descriptionText` / `description` | Plain-text detail (wind speeds, snow line). Use for the body. |
| `instruction` | Safety advice (gemeinde/coast; `instructionHtml` is the HTML twin) — surface it for high-level warnings. Can be an empty string. |
| `isVorabinfo` | `true` = advance *information*, not yet an active warning — tag it, rank it below real warnings (nowcast/gemeinde; not on coast items). |
| `regions` | Array of polygons only (geometry, no readable place name) — nowcast/gemeinde; **coast items have none**, the zone id is their only location. **There is NO `regionName` field** — don't try to filter on one (see traps). |

## Step 3 — Classify and rank

1. **Drop stale items**: `end` (ms) earlier than now. Coast items have no `end` — keep them.
2. **Split advance info from active**: `isVorabinfo === true` → "advance info", listed after
   real warnings.
3. **Rank active warnings by `level` descending** (most severe first; the order is right even
   though the number is DWD's level + 1). Within equal level,
   order by soonest `start`, then by feed: coast and nowcast (short-fuse) above gemeinde.
4. **De-duplicate**: the same storm often appears as multiple nowcast entries with
   near-identical `event`/`level`/`start`/`end` (the `warnId` shares a prefix before the
   `_` suffix). Collapse those into one line with a count. On the coast, one warning (same
   `warnId`) can be listed under several zones — show it once with its zone ids.

## Step 4 — Brief the user

Lead with a verdict line carrying totals across all feeds, then the ranked list:

```
Germany — ⚠ 6 active DWD warnings (4 thunderstorm, 1 snow, 1 coastal gale)

  ⚠⚠ STURMBÖEN (DWD level 2 of 4, markant)  until 18:35  — Sturmböen bis 75 km/h
       Advice: Aufenthalt im Freien vermeiden; lose Gegenstände sichern
  ⚠  GEWITTER (DWD level 1 of 4)  until 18:35  — einzelne Gewitter, Böen bis 60 km/h
  ⚠  BÖEN (DWD level 1 of 4, coast zones 501000006, 501000007) — Gewitterböen 7 Bft W–SW
  ⚠  LEICHTER SCHNEEFALL (DWD level 1 of 4)  above 2000 m
  ℹ  1 advance info (Vorabinformation) — listed for awareness
```

**DWD's level, not the feed's number.** DWD warns in four stages: 1 Wetterwarnung (yellow),
2 markante Wetterwarnung (orange), 3 Unwetterwarnung (red), 4 extreme Unwetterwarnung
(purple). State that stage, never the raw `level`: "level 3" reads as an Unwetter to anyone
who knows the scale, while the feed's 3 is DWD's markant stage 2. Take the stage from the
text where it is stated (the English feeds, `--lang en`: "(level 2 of 4)" in
`descriptionText`); otherwise it is `level − 1`. A `level` of 1 or lower is none of the four
stages (seen for no warning so far): show it as a notice, not as a warning level.

Rules:
- **Lead with the count and the worst level.** If everything is empty, say plainly "No
  active DWD warnings right now" — that's a complete, useful answer, unless a feed has
  `staleFeed: true`: then name that feed and its age instead of calling it calm.
- Per warning show: `event`, DWD's level ("DWD level 2 of 4", from the text or `level − 1`),
  the human end time when there is one (convert `end`/1000; coast has none — don't invent
  one), and a short body from `descriptionText`.
  Add `instruction` for DWD level 2 and up (feed `level` ≥ 3) when it isn't empty.
- Cap thunderstorm noise — nowcast routinely emits several near-identical Gewitter entries;
  collapse and count them, don't list each.
- For coast, label the **zone id** (the object key) since there's no place name.
- Tag `isVorabinfo` items as advance info, never as active warnings.
- Don't invent severity wording the `level`/`event` don't support; if `level` is low and
  the item is advance info, it's informational.

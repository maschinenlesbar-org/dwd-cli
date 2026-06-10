---
name: dwd-warning-briefing
description: >
  Produce a single ranked severe-weather briefing for Germany from the official
  DWD warning feeds, using the dwd-cli. Trigger when the user asks "any weather
  warnings in Germany right now?", "is there a storm/thunderstorm warning?",
  "what severe weather is DWD warning about?", "weather alerts for the coast",
  or wants a quick read on current official warnings. Merges the nowcast,
  Gemeinde (municipality) and coast feeds, ranks by DWD severity level, and
  reports plain-language headlines instead of three raw JSON envelopes.
version: 1.0.0
userInvocable: true
---

# DWD Warning Briefing

Give the user one ranked briefing of the **official** German weather warnings that are
live right now — merging the three published warning feeds (**nowcast**, **Gemeinde**,
**coast**) into a single severity-ordered list, instead of three separate envelopes the
user has to read and reconcile.

## Tooling

All data comes from the `dwd` CLI — read-only, no API key, each feed is **one command**. The job of this skill is the cross-feed merge and the severity ranking the CLI deliberately doesn't do.

This skill drives the `dwd` command. **Before anything else, validate it is available** — run `command -v dwd` (or `dwd --version`). If it is not on your PATH, STOP and inform the user that the `dwd` CLI (`@maschinenlesbar.org/dwd-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

Always pass `--compact` so each feed is one line, easy to pipe into `jq`. Bump
`--timeout 60000` if a feed times out. An **empty `warnings` array (or empty coast object)
with exit `0` is normal** — it means the weather is calm, which is itself the answer.

## Step 1 — Pull all three feeds

They are independent; fan them out. Default to German; pass `--lang en` only if the user
wants English (note: in `en`, only `event` + `descriptionText` translate — `headLine`
comes back undefined, so build the English headline from `event`):

```bash
dwd --compact warnings nowcast
dwd --compact warnings gemeinde
dwd --compact warnings coast
```

`nowcast` and `gemeinde` share the envelope `{ time, warnings: [...], binnenSee }`.
`coast` is different: `{ time, warnings: { <zoneId>: [ ... ] }, vorabInformation }` — its
`warnings` is an **object keyed by coastal-zone id**, not an array.

## Step 2 — The fields that matter

Each warning item (in any feed) carries:

| Field | Meaning |
|---|---|
| `event` | The phenomenon, e.g. `GEWITTER`, `BÖEN`, `LEICHTER SCHNEEFALL` (uppercase in gemeinde/coast, title-case in nowcast). The headline noun. |
| `level` | DWD **severity level** — higher = worse. The primary ranking key (see Step 3). |
| `type` | DWD warning *kind* code (0 = thunderstorm group, 1 = wind, 3 = snow/frost, …). Secondary; don't over-interpret. |
| `start` / `end` | **Unix epoch in milliseconds.** Divide by 1000 for a normal timestamp; an item whose `end` is in the past is stale — drop it. |
| `headLine` | German one-line headline, e.g. `Amtliche WARNUNG vor GEWITTER` (nowcast/gemeinde). **Coast uses lowercase `headline`** — check both keys. Undefined in `--lang en`. |
| `descriptionText` / `description` | Plain-text detail (wind speeds, snow line). Use for the body. |
| `instruction` | Safety advice (gemeinde/coast) — surface it for high-level warnings. |
| `isVorabinfo` | `true` = advance *information*, not yet an active warning — tag it, rank it below real warnings. |
| `regions` | Array of polygons only (geometry, no readable place name). **There is NO `regionName` field** — don't try to filter on one (see traps). |

## Step 3 — Classify and rank

1. **Drop stale items**: `end` (ms) earlier than now.
2. **Split advance info from active**: `isVorabinfo === true` → "advance info", listed after
   real warnings.
3. **Rank active warnings by `level` descending** (most severe first). Within equal level,
   order by soonest `start`, then by feed: coast and nowcast (short-fuse) above gemeinde.
4. **De-duplicate**: the same storm often appears as multiple nowcast entries with
   near-identical `event`/`level`/`start`/`end` (the `warnId` shares a prefix before the
   `_` suffix). Collapse those into one line with a count.

## Step 4 — Brief the user

Lead with a verdict line carrying totals across all feeds, then the ranked list:

```
Germany — ⚠ 6 active DWD warnings (4 thunderstorm, 1 snow, 1 coastal gale)

  ⚠⚠ GEWITTER (level 2)  until 18:35  — einzelne Gewitter, Böen bis 60 km/h
       Advice: Aufenthalt im Freien vermeiden; lose Gegenstände sichern
  ⚠⚠ BÖEN (level 2, coast zone 501000001)  until 16:00 — Gewitterböen 7 Bft W–SW
  ⚠  LEICHTER SCHNEEFALL (level 2)  above 2000 m
  ℹ  1 advance info (Vorabinformation) — listed for awareness
```

Rules:
- **Lead with the count and the worst level.** If everything is empty, say plainly "No
  active DWD warnings right now" — that's a complete, useful answer.
- Per warning show: `event`, `level`, the human end time (convert `end`/1000), and a short
  body from `descriptionText`. Add `instruction` for level ≥ 2.
- Cap thunderstorm noise — nowcast routinely emits several near-identical Gewitter entries;
  collapse and count them, don't list each.
- For coast, label the **zone id** (the object key) since there's no place name.
- Tag `isVorabinfo` items as advance info, never as active warnings.
- Don't invent severity wording the `level`/`event` don't support; if `level` is low and
  the item is advance info, it's informational.

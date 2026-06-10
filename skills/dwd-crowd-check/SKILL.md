---
name: dwd-crowd-check
description: >
  Cross-check official DWD warnings against crowd-sourced weather reports near a
  place, using the dwd-cli. Trigger when the user asks "are people reporting
  hail/rain/thunder near <city>?", "what's the crowd-sourced weather right now?",
  "is the storm warning actually happening on the ground?", "any reports of
  flooding/lightning around me?", or wants ground-truth observations from the DWD
  Warnwetter crowd feed. Filters reports by location and category and summarises
  what users are actually seeing.
version: 1.0.0
userInvocable: true
---

# DWD Crowd Report Check

Surface what people on the ground are actually reporting — and optionally cross-check it
against the official warnings — from the DWD Warnwetter **crowd** feed (`Meldungen`,
user-submitted reports). The value of this skill is **filtering by place + category and
summarising**, since the raw feed is thousands of unsorted points.

## Tooling

This skill drives the `dwd` command. **Before anything else, validate it is available** — run `command -v dwd` (or `dwd --version`). If it is not on your PATH, STOP and inform the user that the `dwd` CLI (`@maschinenlesbar.org/dwd-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

Pass `--compact`. The feed is large (often **3000+ reports**) — bump `--timeout 60000` if
it times out, and never dump it raw.

## Step 1 — Fetch the crowd overview

```bash
dwd --compact crowd
```

Envelope: `{ start, end, windowsSizeHours, highestSeverities, meldungen: [ … ] }`.

- `start` / `end` — epoch ms; the window the reports cover.
- `windowsSizeHours` — the window length (observed `1`, i.e. **reports are last-hour only**;
  this is live "right now" ground truth, not history).
- `highestSeverities` — the worst `auspraegung` seen per category in the window — a fast
  one-line "what's the most extreme thing reported".
- `meldungen` — the report array.

## Step 2 — The report fields

Each `meldungen[]` item:

| Field | Meaning |
|---|---|
| `lat` / `lon` | Report location — **strings**, `Number()` them. |
| `place` | Town/place name, e.g. `Mainz`, `Lauingen (Donau)` — the easiest filter handle. |
| `category` | Phenomenon: `REGEN` (rain), `GEWITTER`/`BLITZE` (storm/lightning), `HAGEL` (hail), `WIND`, `NEBEL` (fog), `GLAETTE` (ice), `BEWOELKUNG` (cloud cover). |
| `auspraegung` | The intensity variant, e.g. `HAGEL_2CM`, `BLITZE_EXTREM`, `REGEN_EXTREM`, `WIND_ORKAN`, `BEWOELKUNG_BEDECKT` — the severity within the category. |
| `timestamp` | When it was reported — epoch ms. |
| `zusatzAttribute` | Extra flags, e.g. `HAGEL_GESCHLOSSENE_HAGELDECKE` (closed hail cover). |
| `likeCount` | Corroboration signal — how many users confirmed it. |
| `blurHash` | Present ⇒ the report has a **photo**. |
| `meldungId` | The report id. |

## Step 3 — Filter

The whole point is to narrow the thousands of reports to what the user asked about:

- **By place**: match `place` (case-insensitive substring) for the named town.
- **By proximity**: if the user gives or you know a lat/lon, keep reports within a rough
  radius (e.g. ~0.5° box ≈ 30–50 km) using `Number(lat)`/`Number(lon)`. Note `BEWOELKUNG`
  (just cloud cover) dominates the feed — exclude it unless asked, it's noise for a
  severe-weather check.
- **By category**: keep only the phenomena asked about (hail, lightning, rain…).

`BEWOELKUNG` and `REGEN` are by far the most common; `HAGEL`, `GLAETTE`, `NEBEL` are rare —
a single one near the user is noteworthy.

## Step 4 — (Optional) cross-check against official warnings

If the user wants ground-truth-vs-official ("is the warning real?"), also fetch
`dwd --compact warnings nowcast` (and/or `gemeinde`) and compare: a DWD `GEWITTER`/level-2
warning over an area where crowd reports show `BLITZE`/`HAGEL` corroborates it; a warning
with **no** matching crowd reports nearby means it hasn't materialised on the ground yet
(or no one's reporting). State which it is — don't assert weather the data doesn't show.

## Step 5 — Summarise

```
Crowd reports near Mainz (last 1 h) — 14 reports

  ⛈ BLITZE      6×  (1 EXTREM)        most-liked: 4 👍
  🌧 REGEN       5×  (1 REGEN_EXTREM)
  🧊 HAGEL       2×  HAGEL_2CM, 1 with photo, closed hail cover
  💨 WIND        1×  WIND_STARK

  vs DWD: matches the active GEWITTER (level 2) warning over the area — confirmed on the ground.
```

Rules:
- Lead with the **count in the window** and the time window (`windowsSizeHours` h).
- Group by `category`, show counts and the worst `auspraegung`; flag photos (`blurHash`)
  and high `likeCount` as stronger evidence.
- Filter out `BEWOELKUNG` noise for severe-weather questions unless the user wants it.
- Give a map link for a notable report from its `lat`/`lon` (`?q=lat,lon`).
- Be explicit that crowd reports are **unverified user submissions**, last-hour only — useful
  corroboration, not authoritative; the official `warnings` feeds are the authority.
- If nothing matches the place/category, say so plainly — "no crowd reports of hail near
  Mainz in the last hour" is a valid answer.

# dwd-cli — Claude Code Skills

A set of [Claude Code](https://code.claude.com/docs/en/skills) **Agent Skills** for live
German weather intelligence, all powered by the **[dwd](README.md)** CLI over the open
[DWD Warnwetter app API](https://dwd.api.bund.dev/) (`warnwetter.de`), operated by the
Deutscher Wetterdienst.

Each skill teaches Claude how to drive the `dwd` CLI to answer a specific, real-world
question — "any weather warnings right now?", "what's the forecast for Munich?", "map the
thunderstorm warnings", "are people reporting hail near me?" — and to report the answer
with evidence rather than guesswork. They encode the parts that are easy to get wrong (the
scaled-integer units, the per-feed envelope differences, the silent empty-result cases) so
Claude doesn't have to rediscover them each time.

## Skills

| Skill | What it does | Ask it… |
|---|---|---|
| **dwd-warning-briefing** | Merges the nowcast + Gemeinde + coast warning feeds into one severity-ranked briefing, drops stale and duplicate entries, and reports plain-language headlines. | "any weather warnings in Germany?", "is there a storm warning right now?" |
| **dwd-station-forecast** | Decodes a raw `station-overview` (tenths-of-units integer arrays, epoch-ms timestamps) into a readable temperature/wind/precip forecast for one or more stations. | "forecast for Munich (10865)?", "will it rain tomorrow?", "compare two cities" |
| **dwd-warning-map** | Exports the warning-area polygons from any feed as a valid GeoJSON `FeatureCollection` for Leaflet / geojson.io / QGIS. | "map the thunderstorm warnings", "export DWD warnings as GeoJSON" |
| **dwd-crowd-check** | Filters the crowd-sourced report feed by place + category and cross-checks it against the official warnings as ground truth. | "are people reporting hail near Mainz?", "is the storm warning actually happening?" |

## Requirements

- **[Claude Code](https://code.claude.com/docs/en/overview)** (or any harness that loads
  Agent Skills).
- **The `dwd` CLI** installed globally:
  ```bash
  npm i -g @maschinenlesbar.org/dwd-cli   # installs the `dwd` bin globally
  ```
  No API key is required — the DWD Warnwetter app API is free, open, and read-only.

## Installation

### Plugin marketplace (recommended)

This repo is a Claude Code **plugin marketplace**, so installation is two commands inside
Claude Code:

```
/plugin marketplace add maschinenlesbar-org/dwd-cli
/plugin install dwd@dwd-skills
```

The first command registers the marketplace; the second installs the `dwd` plugin, which
bundles all four skills. Update later with `/plugin marketplace update`.

### Manual (copy the skill folders)

Prefer not to use the marketplace? Copy the skills into your **personal** directory
(available across all your projects):

```bash
git clone https://github.com/maschinenlesbar-org/dwd-cli tmp-skills
mkdir -p ~/.claude/skills
cp -R tmp-skills/skills/* ~/.claude/skills/
rm -rf tmp-skills
```

…or into a single project's `.claude/skills/` by swapping `~/.claude/skills` for
`.claude/skills`. Each skill lives in its own directory with a `SKILL.md`, e.g.
`skills/dwd-warning-briefing/SKILL.md`. Start a new Claude Code session and the skills are
picked up automatically.

## Usage

You don't normally invoke these by name — Claude auto-selects the right skill from your
request. Just ask in natural language:

> Are there any severe weather warnings in Germany right now?

> What's the forecast for München-Stadt (station 10865) over the next few days?

> Export the active Gemeinde warnings as GeoJSON so I can open it in geojson.io.

> Are people reporting hail near Mainz in the last hour, and does it match the DWD warning?

You can also invoke a skill explicitly with its slash command, e.g. `/dwd-warning-briefing`.

## How it works

Every skill is a single `SKILL.md` — a short, model-facing playbook describing which `dwd`
subcommands to call, in what order, and how to interpret the JSON. The skills encode the
non-obvious parts of this API, for example:

- station-overview values are **scaled integers**, not real units — temperature/dew
  point/pressure/humidity/wind/precip are all **tenths** (`97` = 9.7 °C, `10216` = 1021.6
  hPa, `2700` = 270°), and times are **epoch milliseconds**; printing the raw arrays gives
  nonsense (see **dwd-station-forecast**);
- an **unknown station id returns `{}` with exit `0`**, not a 404 — "no data" is silently a
  bad id, not calm weather;
- forecast value arrays can be **`null` even when the series exists** (live `windSpeed`,
  `precipitationProbablity` came back null), and the probability key is misspelled
  `precipitationProbablity` upstream;
- the warning feeds have **different envelope shapes** — nowcast/gemeinde give
  `warnings: [...]`, but **coast gives `warnings: { <zoneId>: [...] }`** (an object keyed by
  zone), and the headline key differs (`headLine` vs coast's `headline`); in `--lang en`
  only `event`/`descriptionText` translate and the headline is undefined;
- warnings carry **no `regionName`** — `regions[]` is geometry only; for mapping, the
  region's `polygonGeometry` is already valid `[lon, lat]` GeoJSON (the flat `polygon` array
  is the opposite `[lat, lon]` order, and `triangles` is render data, not geometry) — see
  **dwd-warning-map**;
- the nowcast feed emits several **near-duplicate** entries for one storm (same `warnId`
  prefix before the `_`); the briefing collapses them (see **dwd-warning-briefing**);
- the **crowd feed is last-hour only** (`windowsSizeHours: 1`), thousands of unverified
  user reports dominated by `BEWOELKUNG` cloud-cover noise — filter by place/category before
  trusting it as ground truth (see **dwd-crowd-check**).

## Contributing

This project does not accept external code contributions (see
[CONTRIBUTING.md](CONTRIBUTING.md)). When adding a skill internally, keep `SKILL.md`
focused, give it a `description` with concrete trigger phrases, and follow the
[official skill format](https://code.claude.com/docs/en/skills).

## License

[AGPL-3.0-or-later](LICENSE) © Sebastian Schürmann. See [LICENSING.md](LICENSING.md) for
the dual-licensing / commercial option.

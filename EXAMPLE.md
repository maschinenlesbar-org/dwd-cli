# Examples

Real examples for the Claude Code skills of the `dwd` plugin, one per skill: a request,
the `dwd` commands the skill ran, and the answer Claude gave.

Every example ran against the live API on 15 September 2026 with `dwd` 0.0.7.
The data changes, so your results will differ; the ids and keys shown work for trying the
requests yourself. Long lists are shortened.

To try them, install the CLI and the plugin — see [SKILLS.md](SKILLS.md).

Skills: [dwd-crowd-check](#dwd-crowd-check) · [dwd-station-forecast](#dwd-station-forecast) · [dwd-warning-briefing](#dwd-warning-briefing) · [dwd-warning-map](#dwd-warning-map)

## dwd-crowd-check

> Are people around Hamburg reporting rain or strong wind today? And is DWD warning about it?

```bash
dwd --compact crowd                      # 998 reports nationwide
dwd --compact warnings nowcast
dwd --compact warnings gemeinde
```

The feed says `windowsSizeHours: 1`, but its `start`/`end` span 12 hours (05:41–17:41) and the
reports are spread over all of it. So the skill reported the whole window and the last hour
separately. It kept reports within ±0.5° of Hamburg (53.55 N, 10.0 E), dropped the 24
`BEWOELKUNG` (cloud cover) entries, and listed towns only, nothing that points to a reporter.

```
Crowd reports around Hamburg, 15.09. 05:41–17:41: 44 reports, 20 after dropping cloud cover

  REGEN   11×  9 REGEN_LEICHT, 1 REGEN_MITTEL, 1 REGEN_KRAEFTIG
               all between 07:16 and 09:36, none since; 2 with photo, most-liked: 5
               Hamburg (incl. Hamburg-Nord, Hamburg-Bergedorf), Norderstedt, Reinbek,
               Buxtehude, Braak, Amelinghausen
  WIND     9×  8 WIND_SCHWACH, 1 WIND_STARK (Bad Oldesloe), no photos
  no reports of GEWITTER, BLITZE, HAGEL, NEBEL or GLAETTE in the area

  Last hour (16:41–17:41): 3 reports, only cloud (Hamburg, Lüneburg) and weak wind (Lüneburg)
  Heaviest rain report area (rounded to ~10 km): https://maps.google.com/?q=53.6,10.2

  vs DWD: no active nowcast or Gemeinde warnings anywhere in Germany. The crowd picture
  fits that: a wet morning with mostly light rain, nothing severe reported on the ground.

  Nationwide, the worst reported per category: REGEN_KRAEFTIG, WIND_STARK, NEBEL_EXTREM.
  Crowd reports are unverified user submissions; the official warning feeds are the authority.
```

## dwd-station-forecast

> Compare the forecast for Hamburg and Stuttgart for the next few days. Will I need an umbrella?

```bash
dwd --compact station-overview --id 10147 --id 10739
```

Both stations came back with daily summaries, but the hourly `windSpeed`, `windGust`,
`windDirection` and `precipitationProbablity` arrays were `null`, and `temperature` (241 values)
and `precipitationTotal` (72) had different lengths. The skill read hourly rain from
`forecast1` and took wind from `days`.

```
Hamburg (10147) vs Stuttgart (10739)

             Hamburg                                 Stuttgart
  Tue 15.09  13.5–25.4 °C  1.3 mm  18.5 km/h S      14.3–28.4 °C  0.0 mm   7.4 km/h SE
  Wed 16.09  12.2–18.2 °C  5.7 mm  16.7 km/h W      14.1–19.9 °C  0.7 mm  18.5 km/h NW
  Thu 17.09  11.4–17.6 °C  2.0 mm  25.9 km/h SW     11.4–20.9 °C  0.0 mm   9.3 km/h W
  Fri 18.09  12.7–17.1 °C  2.5 mm  22.2 km/h SW     12.7–18.8 °C  0.0 mm   9.3 km/h W
  Gusts up to 50.0 km/h (Hamburg, Thu) and 48.2 km/h (Stuttgart, Wed)
  Sun today: Hamburg 06:53–19:36, Stuttgart 06:59–19:36 (CEST)

Hamburg, tonight (hourly, mm):
  20:00 0.1 · 21:00 0.4 · 22:00 0.5 · 23:00 0.7 · 00:00 0.9 · 01:00 1.0
  02:00 0.8 · 03:00 0.7 · 04:00 0.7 · 05:00 0.6 · 06:00 0.4 · then tapering off by 11:00

Umbrella: yes for Hamburg, from this evening through Wednesday morning and again
Thu/Fri. Stuttgart stays dry apart from 0.7 mm around midday Wednesday (11:00–14:00).
Hourly wind and rain probability: not provided by DWD for these stations.
```

## dwd-warning-briefing

> Is DWD warning about anything in Germany right now, including the coast?

```bash
dwd --compact warnings nowcast           # {"warnings":[]}
dwd --compact warnings gemeinde          # {"warnings":[],"binnenSee":{}}
dwd --compact warnings coast             # {"warnings":{},"vorabInformation":{}}
```

All three feeds were empty at 17:42 and again at 17:49 CEST. Empty feeds with exit 0 are a
real answer, so the skill reported calm weather instead of retrying or guessing.

```
Germany: no active DWD warnings right now (checked 15.09.2026 17:49 CEST)

  nowcast    0 warnings            feed time 17:45
  Gemeinde   0 warnings            feed time 17:48, no inland-lake (binnenSee) warnings
  coast      0 coastal zones       feed time 17:48, no advance information (Vorabinformation)
```

Next steps offered: re-check later, or the crowd check for what people are seeing on the ground.

## dwd-warning-map

> Export the current DWD warning areas, all three feeds, as GeoJSON so I can load them into QGIS.

```bash
dwd --compact warnings nowcast > nowcast-2.json
dwd --compact warnings gemeinde > gemeinde-2.json
dwd --compact warnings coast > coast-2.json
```

The skill built the FeatureCollection from `regions[].polygonGeometry` for the two array feeds
and walked the coast feed's zone-keyed object. No feed had a warning, so there was nothing to
convert.

```
No active DWD warnings to map right now.

  nowcast 0 · Gemeinde 0 · coast 0 zones   (feed times 17:45–17:48 CEST)
  Wrote dwd-warnings.geojson: a FeatureCollection with 0 features (42 bytes), parses as JSON.
  This is an empty result, not a broken export.
```

Next steps offered: re-run with the same file name when warnings are out, and colour the polygons
by `level` for a severity map.

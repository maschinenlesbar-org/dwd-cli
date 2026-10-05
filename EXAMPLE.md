# Examples

Real examples for the Claude Code skills of the `dwd` plugin, one per skill: a request,
the `dwd` commands the skill ran, and the answer Claude gave.

Every example ran against the live API; each section names the date and `dwd` version.
The data changes, so your results will differ; the ids and keys shown work for trying the
requests yourself. Long lists are shortened.

To try them, install the CLI and the plugin — see [SKILLS.md](SKILLS.md).

Skills: [dwd-crowd-check](#dwd-crowd-check) · [dwd-station-forecast](#dwd-station-forecast) · [dwd-warning-briefing](#dwd-warning-briefing) · [dwd-warning-map](#dwd-warning-map)

## dwd-crowd-check

Ran on 6 October 2026 at 00:58 with `dwd` 0.2.0.

> Are people around Hamburg reporting rain or strong wind today? And is DWD warning about it?

```bash
dwd --compact crowd                      # 418 reports nationwide
dwd --compact warnings nowcast
dwd --compact warnings gemeinde
```

The feed says `windowsSizeHours: 1`, but its `start`/`end` span 12 hours (05.10. 12:58 to
06.10. 00:58), and not one report fell in the last hour. So the skill reported the whole window
and the last hour separately. It kept reports within ±0.5° of Hamburg (53.55 N, 10.0 E), dropped
the 9 `BEWOELKUNG` (cloud cover) entries, and named the town and an hour span only, nothing that
points to a reporter.

```
Crowd reports around Hamburg, 05.10. 12:58 – 06.10. 00:58: 10 reports, 1 after dropping cloud cover

  WIND     1×  WIND_STARK (Norderstedt), in the early afternoon (14:00–15:00), no photo, no likes
  no reports of REGEN, GEWITTER, BLITZE, HAGEL, NEBEL or GLAETTE in the area
  the cloud reports were all clear to partly cloudy (WOLKENLOS, LEICHT_BEWOELKT)

  Last hour (23:58–00:58): no reports anywhere in Germany

  vs DWD: no active nowcast or Gemeinde warnings anywhere in Germany. That fits: one report
  of strong wind in the afternoon, no rain reported around Hamburg.

  Nationwide in the window: 360 cloud, 55 wind, 3 rain reports; the worst per category were
  BEWOELKUNG_BEDECKT, REGEN_LEICHT and WIND_STUERMISCH.
  Crowd reports are unverified user submissions; the official warning feeds are the authority.
```

## dwd-station-forecast

Ran on 6 October 2026 at 00:57 with `dwd` 0.2.0.

> Compare the forecast for Hamburg and Stuttgart for the next few days. Will I need an umbrella?

```bash
dwd --compact station-overview --id 10147 --id 10739
```

Both stations came back with daily summaries; the hourly `windSpeed`, `windGust`,
`windDirection` and `precipitationProbablity` arrays were `null`. `temperature` had 241 hourly
values from midnight, the shorter arrays (`precipitationTotal` 72, `sunshine` 74) ended at
Friday 00:00, where the 3-hourly `forecast2` takes over. The skill took wind from `days`, the
hourly rain from `forecast1` (end-aligned) and each day's sunshine by summing the series:
`days[].sunshine` said `0` for Stuttgart on Thursday, where the series have 22 minutes. No value
in either station's series was `null` (the missing-value marker) this time.

```
Hamburg (10147) vs Stuttgart (10739)

             Hamburg                                      Stuttgart
  Tue 06.10  12.9–18.2 °C   0.0 mm  11.1 km/h SW  1.4 h sun   10.2–22.3 °C   0.0 mm   7.4 km/h E   9.5 h sun
  Wed 07.10  12.1–18.8 °C   0.0 mm  14.8 km/h SE  4.1 h       11.8–23.2 °C   0.0 mm   7.4 km/h SE  6.8 h
  Thu 08.10   9.3–13.1 °C  11.5 mm  24.1 km/h NW  2.2 h        9.3–16.5 °C  13.8 mm  16.7 km/h NW  0.4 h
  Fri 09.10   8.4–12.6 °C   7.1 mm  25.9 km/h SW  1.4 h        7.8–14.3 °C   0.5 mm  13.0 km/h W   3.6 h
  Gusts up to 57.4 km/h (Hamburg, Thu) and 46.3 km/h (Stuttgart, Thu)
  Sun today: Hamburg 07:30–18:44, Stuttgart 07:30–18:52 (CEST)

Thursday, hourly rain:
  Hamburg    from midnight to midnight, heaviest 05:00–09:00 (1.0–1.3 mm/h), light after 14:00
  Stuttgart  from 01:00 to 21:00, heaviest 07:00–13:00 (0.8–1.5 mm/h)

Umbrella: not today or tomorrow, both cities stay dry. Yes on Thursday in both, all day.
Friday: Hamburg wet again (7.1 mm), Stuttgart mostly dry (0.5 mm).
Hourly wind and rain probability: not provided by DWD for these stations.
```

## dwd-warning-briefing

Ran on 6 October 2026 at 00:58 with `dwd` 0.2.0.

> Is DWD warning about anything in Germany right now, including the coast?

```bash
dwd --compact warnings nowcast           # {"time":…,"warnings":[],"binnenSee":null}
dwd --compact warnings gemeinde          # {"time":…,"warnings":[],"binnenSee":{}}
dwd --compact warnings coast             # {"time":…,"warnings":{},"vorabInformation":{}}
```

All three feeds were empty at 00:58 CEST. Empty feeds with exit 0 are a real answer, so the
skill reported calm weather instead of retrying or guessing.

```
Germany: no active DWD warnings right now (checked 06.10.2026 00:58 CEST)

  nowcast    0 warnings            feed time 00:55
  Gemeinde   0 warnings            feed time 00:50, no inland-lake (binnenSee) warnings
  coast      0 coastal zones       feed time 00:50, no advance information (Vorabinformation)
```

Next steps offered: re-check later, or the crowd check for what people are seeing on the ground.

## dwd-warning-map

Ran on 6 October 2026 at 00:58 with `dwd` 0.2.0.

> Export the current DWD warning areas, all three feeds, as GeoJSON so I can load them into QGIS.

```bash
dwd --compact warnings nowcast > nowcast.json
dwd --compact warnings gemeinde > gemeinde.json
dwd --compact warnings coast > coast.json
```

The skill built the FeatureCollection from `regions[].polygonGeometry` for the two array feeds
and walked the coast feed's zone-keyed object. No feed had a warning, so there was nothing to
convert; `dwd-warnings.geojson` did not exist yet, so nothing was overwritten.

```
No active DWD warnings to map right now.

  nowcast 0 · Gemeinde 0 · coast 0 zones   (feed times 00:50–00:55 CEST)
  Wrote dwd-warnings.geojson: a FeatureCollection with 0 features (42 bytes), parses as JSON.
  This is an empty result, not a broken export.
```

Next steps offered: re-run with the same file name when warnings are out, and colour the polygons
by `level` for a severity map.

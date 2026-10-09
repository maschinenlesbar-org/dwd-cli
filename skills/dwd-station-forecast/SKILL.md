---
name: dwd-station-forecast
description: >
  Turn a raw DWD station-overview into a readable weather forecast, using the
  dwd-cli. Trigger when the user asks "what's the forecast for Munich/Hamburg?",
  "weather at DWD station 10865", "will it rain tomorrow in a city?", "compare
  the forecast for two cities", or wants temperature/wind/precip for a German
  weather station. Reads the API's unlabelled value arrays (in real units with
  --decode) and epoch-millisecond timestamps that make the raw payload unreadable.
compatibility: >
  Requires the `dwd` CLI (npm package @maschinenlesbar.org/dwd-cli, 0.3.0 or
  later for --decode) on PATH, installed by the user; the skill never installs it. Uses jq for JSON
  filtering. Network access to app-prod-ws.warnwetter.de and
  s3.eu-central-1.amazonaws.com (DWD static data).
---

# DWD Station Forecast

Turn the `station-overview` payload — arrays of unlabelled numbers — into a readable hourly +
multi-day forecast. DWD delivers the numbers as scaled integers (tenths of the unit);
**`--decode` makes the CLI print them in real units** (°C, %, hPa, km/h, °, mm, minutes of
sun). Placing each value at its hour and picking the slice the user asked for is this
skill's job.

## Tooling

This skill drives the `dwd` command. **Before anything else, validate it is available** — run `command -v dwd` (or `dwd --version`). If it is not on your PATH, STOP and inform the user that the `dwd` CLI (`@maschinenlesbar.org/dwd-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

This skill also filters JSON with `jq`. **Validate it too** — run `command -v jq`. If it is missing, inform the user that `jq` is not installed — installing it is their responsibility; never install it yourself — and carry on without it: filter the CLI output with `node -e` instead (Node is already on your PATH, since the CLI runs on it).

Pass `--compact`. Bump `--timeout 60000` if needed.

## Step 1 — Resolve the station id

`station-overview` takes a **5-digit DWD station id**, not a city name. Common ids:
München-Stadt `10865`, Hamburg `10147`, Berlin-Tempelhof `10384`, Frankfurt `10637`,
Köln/Bonn `10513`, Stuttgart `10739`. If the user names a city you don't have an id for,
ask for the id or the nearest known station rather than guessing — a wrong id silently
returns `{}` (see traps).

```bash
dwd --compact station-overview --decode --id 10865            # one station
dwd --compact station-overview --decode --id 10865 --id 10147 # several (city-vs-city)
```

If `dwd` rejects `--decode` (`unknown option`, a `dwd` older than 0.3.0), run the same command
without it and divide the scaled fields by 10 yourself (the "Raw" column in Step 3).

The response is an object **keyed by station id**: `{ "10865": { … } }`. Address one with
`jq '."10865"'`.

> **Trap: an unknown station id is NOT an error.** It returns an empty object `{}` (or omits
> that id from a multi-id response) with **exit 0** — not exit 4. The CLI names such ids on
> stderr (an `INFO` record: `… INFO  [dwd.api] no data for station id 99999 — …`). If a station's key is missing/empty or
> that note appears, tell the user the id wasn't found; don't report it as "no weather".

## Step 2 — The payload

Each station value has:

| Key | What it is |
|---|---|
| `forecast1` | The main **hourly** series. `start` (epoch ms, midnight local time of the current day) + `timeStep` (ms, `3600000` = 1 h) + value arrays (`temperature`, `precipitationTotal`, `humidity`, `surfacePressure`, `dewPoint2m`, `sunshine`, …). The arrays have **different lengths and are not all anchored at `start`** — see "Align the arrays" below. |
| `forecast2` | **Not** an hourly copy: a **3-hourly** continuation (`timeStep` `10800000`) that starts where the hourly arrays end (`forecast1.start` + 72 h). Element `j` covers the 3 h ending at `forecast2.start + (j+1)*timeStep` — totals (rain, sunshine) over those 3 h, other values at their end. Its `temperature` came back empty `[]`: hourly temperatures for all ten days are in `forecast1.temperature` (241 values from `start`), daily min/max in `days`. |
| `days` | Array of multi-day summaries (`temperatureMin/Max`, `precipitation`, `windSpeed`, `windGust`, `windDirection`, `sunrise`/`sunset`/`moonrise`/`moonset`, `icon`, `dayDate`). |
| `threeHourSummaries` | 3-hourly aggregates — **often `null`**; tolerate it. |
| `warnings` | Warnings for this station's location — usually `[]`. |
| `forecastStart` | May be `null`; use `forecast1.start` as the series anchor. |

## Step 3 — The units

With `--decode` the CLI has already divided the scaled fields; show them with their unit.
Without it (an old `dwd`) they are tenths — "temperature 97" is 9.7 °C — so divide first,
never print them raw.

| Field | Unit with `--decode` | Raw (without `--decode`) |
|---|---|---|
| `temperature`, `temperatureMin`, `temperatureMax`, `dewPoint2m` | **°C** — `9.7` | ÷ 10: `97` |
| `humidity` | **%** — `90.4` | ÷ 10: `904` |
| `surfacePressure` | **hPa** — `1021.6` | ÷ 10: `10216` |
| `windSpeed`, `windGust` | **km/h** — `16.7` | ÷ 10: `167` |
| `windDirection` | **degrees** — `270` (W) | ÷ 10: `2700` |
| `precipitation`, `precipitationTotal` | **mm** — `1.4` | ÷ 10: `14` |
| `sunshine` (`forecast1` hourly, `forecast2` 3-hourly) | **minutes** of sunshine in the period — `35` in that hour | ÷ 10: `350` |
| `days[].sunshine` | **don't use it** — see the trap below; sum the hourly values instead | |
| `sunrise`/`sunset`/`moonrise`/`moonset`, `start` | **epoch milliseconds** (never decoded) — ÷ 1000 for a normal timestamp; format in local/CET time | |
| `icon` / `icon1` / `icon2` | small int weather-symbol code (never decoded) — describe loosely or omit, don't fabricate an exact meaning | |

> **Trap: value arrays can be `null` or empty `[]`** even when the series exists — e.g.
> `windSpeed`, `windGust`, `windDirection` and `precipitationProbablity` were `null` and
> `cloudCoverTotal` was `[]` in live `forecast1` while `temperature` and
> `precipitationTotal` were populated. Always check an array before indexing; report "not
> provided" rather than crashing or printing `0`.
> **Trap: single values can be `null` too.** The API marks a missing value inside an array
> with `32767`, which the CLI prints as `null` — today's past hours at some stations
> (`temperature`, `precipitationTotal`, `icon`) and **every `surfacePressure` value at
> mountain stations** (Zugspitze `10961`, Feldberg `10908`, Fichtelberg `10578`, …). Say
> "no value"/"not provided" for that hour, and leave it out of sums, minima and maxima (in jq,
> `null` breaks arithmetic: test for it first). If you ever see a raw `32767` (an old `dwd`),
> treat it the same way — it is not 3276.7 of anything.
> **Trap: `days[].sunshine` is often `0` on sunny days.** Checked against the hourly data
> on 2026-10-05 and 06 (49 stations, 531 future days): it is either exactly the day's sum of
> the hourly/3-hourly `sunshine` values or `0` — and it was `0` on about 44 % of the days,
> in runs of unsettled weather, with up to 6–7 h of sun in the hourly data (and in DWD's
> MOSMIX). A `0` there does not mean "no sun". **Take a day's sunshine from the series**
> (recipe in "Daily sunshine" below), never from `days[].sunshine`.
> **Spelling:** the precipitation-probability key is misspelled `precipitationProbablity`
> in the API (and `precipitationProbablityIndex`) — use the exact key.

### Align the arrays — only `temperature` starts at `forecast1.start`

Checked on 2026-09-15 against DWD's own MOSMIX forecast for the same stations:

- **`temperature`** (and `temperatureStd`) is the full series: `temperature[i]` is the value
  at `start + i*timeStep`.
- **Every shorter array is end-aligned.** Its last element belongs to `start` + 72 h (where
  `forecast2` begins), the one before to `start` + 71 h, and so on: in an array of length
  `n`, element `j` belongs to `start + (73 − n + j) h`. `humidity`, `dewPoint2m` and
  `surfacePressure` are the values at that time; `precipitationTotal` and `sunshine` are the
  totals for the **hour ending** then.
- The short arrays begin around the current hour and get shorter as the day goes on (at
  22:10 CEST `sunshine` had 53 values, the first for 19:00–20:00; `humidity` had 51, the first at
  22:00; `precipitationTotal` had 72, the first for 00:00–01:00). **Indexing them from
  `start` puts sunshine at night and shifts humidity and pressure by up to a day.**

A helper that does the alignment (next 6 hours; rain and sunshine for the hour that starts
at the listed time):

```bash
dwd --compact station-overview --decode --id 10147 > so.json
TZ=Europe/Berlin jq -r --arg id 10147 '
  .[$id].forecast1 as $f
  | def at($name; $h):   # element of array $name stamped start + $h hours
      ($f[$name] // []) as $a
      | ($h - 73 + ($a | length)) as $j
      | if $j >= 0 and $j < ($a | length) then $a[$j] else null end;   # null = no value
  def show($v; $unit): if $v == null then "n/a" else "\($v) \($unit)" end;
    ((now * 1000 - $f.start) / $f.timeStep | floor) as $i
  | range($i; $i + 6) as $h
  | [ ($f.start + $h * $f.timeStep) / 1000 | strflocaltime("%H:%M"),
      show($f.temperature[$h]; "°C"),
      "rain " + show(at("precipitationTotal"; $h + 1); "mm"),
      "sun " + show(at("sunshine"; $h + 1); "min"),
      "humidity " + show(at("humidity"; $h); "%") ]
  | join("  ")' so.json
```

### Daily sunshine — sum the series, not `days[].sunshine`

Sunshine per day (local date) from the hourly `forecast1` values (end-aligned, as above)
and the 3-hourly `forecast2` values, skipping `null`:

```bash
TZ=Europe/Berlin jq -r --arg id 10147 '
  .[$id] as $s | $s.forecast1 as $f | $s.forecast2 as $g
  | ( [ ($f.sunshine // []) as $a | range(0; $a | length) as $j
        | {end: ($f.start + (73 - ($a | length) + $j) * $f.timeStep), v: $a[$j]} ]
    + [ ($g.sunshine // []) as $a | range(0; $a | length) as $j
        | {end: ($g.start + ($j + 1) * $g.timeStep), v: $a[$j]} ] )
  | map(select(.v != null and .v != 32767)
        | .day = ((.end - 1) / 1000 | strflocaltime("%Y-%m-%d")))
  | map(select(.day >= (now | strflocaltime("%Y-%m-%d"))))
  | group_by(.day)
  | map({day: .[0].day, sun_min: ((map(.v) | add) * 10 | round / 10)})   # old dwd: add / 10
  | .[] | "\(.day)  sun \(.sun_min) min"' so.json
```

For **today** the series only start around the current hour, so today's sum is the
sunshine **still to come**; say so ("another 2 h of sun this afternoon"). The series end
about ten days out, so the last `days` entries may have no sum — say "not provided".

## Step 4 — Present the forecast

Pick the slice the user asked for; don't dump 240 hourly points.

- **"forecast for <city>"** → today + next 2–3 days from `days`: per day show min/max °C,
  precipitation mm, wind km/h + direction, sunrise/sunset, and sunshine hours from the
  daily-sunshine recipe (not from `days[].sunshine`).
- **"will it rain / next few hours"** → the next ~12 hours from **now**, not the first
  entries (`forecast1` starts at midnight): hour, temp, precip mm (and probability if
  present), aligned as in the helper above.
- **city-vs-city** → one row per station, side by side.

```
München-Stadt (10865)
  Today  9.7–14.8 °C   1.4 mm rain   wind 16.7 km/h W   ☀ 05:53–21:13
  Thu   10.2–17.1 °C   0.0 mm        wind 12 km/h SW
  Fri    …

Next 6 h (hourly):
  15:00  9.7 °C   0.2 mm
  16:00  9.6 °C   0.2 mm
  …
```

Rules:
- **Always show real units** (°C, mm, km/h, hPa, %) — never the raw scaled integer.
- Convert epoch-ms timestamps to readable local times; state the timezone if it matters.
- If a field's array is `null`/missing, or a single value in it is `null`, say "not
  provided", don't invent or print `0`.
- For multi-station requests, keep it a compact comparison, not three full dumps.
- Offer the raw `station-overview` JSON only if the user explicitly wants it.

---
name: dwd-station-forecast
description: >
  Turn a raw DWD station-overview into a readable weather forecast, using the
  dwd-cli. Trigger when the user asks "what's the forecast for Munich/Hamburg?",
  "weather at DWD station 10865", "will it rain tomorrow in a city?", "compare
  the forecast for two cities", or wants temperature/wind/precip for a German
  weather station. Decodes the API's scaled integer arrays (tenths-of-units) and
  epoch-millisecond timestamps that make the raw payload unreadable.
version: 1.0.0
userInvocable: true
---

# DWD Station Forecast

Turn the raw `station-overview` payload — which is arrays of unlabelled scaled integers —
into a readable hourly + multi-day forecast. **Decoding the units is the entire job of this
skill**; the CLI returns the DWD numbers verbatim.

## Tooling

This skill drives the `dwd` command. **Before anything else, validate it is available** — run `command -v dwd` (or `dwd --version`). If it is not on your PATH, STOP and inform the user that the `dwd` CLI (`@maschinenlesbar.org/dwd-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

Pass `--compact`. Bump `--timeout 60000` if needed.

## Step 1 — Resolve the station id

`station-overview` takes a **5-digit DWD station id**, not a city name. Common ids:
München-Stadt `10865`, Hamburg `10147`, Berlin-Tempelhof `10384`, Frankfurt `10637`,
Köln/Bonn `10513`, Stuttgart `10739`. If the user names a city you don't have an id for,
ask for the id or the nearest known station rather than guessing — a wrong id silently
returns `{}` (see traps).

```bash
dwd --compact station-overview --id 10865            # one station
dwd --compact station-overview --id 10865 --id 10147 # several (city-vs-city)
```

The response is an object **keyed by station id**: `{ "10865": { … } }`. Address one with
`jq '."10865"'`.

> **Trap: an unknown station id is NOT an error.** It returns an empty object `{}` (or omits
> that id from a multi-id response) with **exit 0** — not exit 4. If a station's key is
> missing/empty, tell the user the id wasn't found; don't report it as "no weather".

## Step 2 — The payload

Each station value has:

| Key | What it is |
|---|---|
| `forecast1` | The main **hourly** series. `start` (epoch ms, midnight local time of the current day) + `timeStep` (ms, `3600000` = 1 h) + value arrays (`temperature`, `precipitationTotal`, `humidity`, `surfacePressure`, `dewPoint2m`, `sunshine`, …). The arrays have **different lengths and are not all anchored at `start`** — see "Align the arrays" below. |
| `forecast2` | **Not** an hourly copy: a **3-hourly** continuation (`timeStep` `10800000`) that starts where the hourly arrays end (`forecast1.start` + 72 h). Element `j` covers the 3 h ending at `forecast2.start + (j+1)*timeStep` — totals (rain, sunshine) over those 3 h, other values at their end. Its `temperature` came back empty `[]`; use `days` for temperatures beyond day 3. |
| `days` | Array of multi-day summaries (`temperatureMin/Max`, `precipitation`, `windSpeed`, `windGust`, `windDirection`, `sunrise`/`sunset`/`moonrise`/`moonset`, `icon`, `dayDate`). |
| `threeHourSummaries` | 3-hourly aggregates — **often `null`**; tolerate it. |
| `warnings` | Warnings for this station's location — usually `[]`. |
| `forecastStart` | May be `null`; use `forecast1.start` as the series anchor. |

## Step 3 — Decode the units — do NOT print raw

The DWD numbers are scaled integers; printing them raw gives nonsense like "temperature 97".
**Divide before display:**

| Field | Raw → real | Example |
|---|---|---|
| `temperature`, `temperatureMin`, `temperatureMax`, `dewPoint2m` | ÷ 10 → **°C** | `97` → 9.7 °C, `148` → 14.8 °C |
| `humidity` | ÷ 10 → **%** | `904` → 90.4 % |
| `surfacePressure` | ÷ 10 → **hPa** | `10216` → 1021.6 hPa |
| `windSpeed`, `windGust` | ÷ 10 → **km/h** | `167` → 16.7, `445` → 44.5 km/h |
| `windDirection` | ÷ 10 → **degrees** | `2700` → 270° (W) |
| `precipitation`, `precipitationTotal` | ÷ 10 → **mm** | `14` → 1.4 mm |
| `sunshine` (hourly and `days`) | ÷ 10 → **minutes** of sunshine in the period (tenths of a minute) | `350` → 35 min in that hour, `3300` → 330 min that day |
| `sunrise`/`sunset`/`moonrise`/`moonset`, `start` | **epoch milliseconds** — ÷ 1000 for a normal timestamp; format in local/CET time | |
| `icon` / `icon1` / `icon2` | small int weather-symbol code — describe loosely or omit, don't fabricate an exact meaning | |

> **Trap: value arrays can be `null` or empty `[]`** even when the series exists — e.g.
> `windSpeed`, `windGust`, `windDirection` and `precipitationProbablity` were `null` and
> `cloudCoverTotal` was `[]` in live `forecast1` while `temperature` and
> `precipitationTotal` were populated. Always check an array before indexing; report "not
> provided" rather than crashing or printing `0`.
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
dwd --compact station-overview --id 10147 > so.json
TZ=Europe/Berlin jq -r --arg id 10147 '
  .[$id].forecast1 as $f
  | def at($name; $h):   # element of array $name stamped start + $h hours
      ($f[$name] // []) as $a
      | ($h - 73 + ($a | length)) as $j
      | if $j >= 0 and $j < ($a | length) then $a[$j] / 10 else null end;
  def show($v; $unit): if $v == null then "n/a" else "\($v) \($unit)" end;
    ((now * 1000 - $f.start) / $f.timeStep | floor) as $i
  | range($i; $i + 6) as $h
  | [ ($f.start + $h * $f.timeStep) / 1000 | strflocaltime("%H:%M"),
      show($f.temperature[$h] / 10; "°C"),
      "rain " + show(at("precipitationTotal"; $h + 1); "mm"),
      "sun " + show(at("sunshine"; $h + 1); "min"),
      "humidity " + show(at("humidity"; $h); "%") ]
  | join("  ")' so.json
```

## Step 4 — Present the forecast

Pick the slice the user asked for; don't dump 240 hourly points.

- **"forecast for <city>"** → today + next 2–3 days from `days`: per day show min/max °C,
  precipitation mm, wind km/h + direction, sunrise/sunset.
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
- If a field's array is `null`/missing, say "not provided", don't invent or print `0`.
- For multi-station requests, keep it a compact comparison, not three full dumps.
- Offer the raw `station-overview` JSON only if the user explicitly wants it.

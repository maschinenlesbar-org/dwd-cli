---
name: dwd-warning-map
description: >
  Export active DWD weather warnings as valid GeoJSON for mapping, using the
  dwd-cli. Trigger when the user asks to "map the thunderstorm warnings",
  "export DWD warnings as GeoJSON", "show the warning areas on a map", "plot the
  Gemeinde warnings", or wants the warning polygons as geodata for Leaflet /
  geojson.io / QGIS. Pulls the nowcast and Gemeinde feeds (coast warnings carry
  no geometry) and emits a clean FeatureCollection of warning-area polygons.
compatibility: >
  Requires the `dwd` CLI (npm package @maschinenlesbar.org/dwd-cli) on PATH,
  installed by the user; the skill never installs it. Network access to
  app-prod-ws.warnwetter.de and s3.eu-central-1.amazonaws.com (DWD static data).
---

# DWD Warnings → GeoJSON Export

Turn the DWD warning feeds into a valid GeoJSON `FeatureCollection` of **warning-area
polygons** ready for geojson.io, Leaflet, or QGIS — picking the right geometry and handling
the per-feed envelope differences.

## Tooling

This skill drives the `dwd` command. **Before anything else, validate it is available** — run `command -v dwd` (or `dwd --version`). If it is not on your PATH, STOP and inform the user that the `dwd` CLI (`@maschinenlesbar.org/dwd-cli`) is not installed — installing it is their responsibility; never install it yourself, and do not fall back to `npx` or a local `node dist/...` build.

Always `--compact`. An empty `warnings` (array or object) is a valid result — no warnings
to map — not an error.

## Step 1 — Fetch the feed(s)

Pick the feed(s) the user wants and fetch each:

```bash
dwd --compact warnings nowcast    # short-fuse (thunderstorm) polygons
dwd --compact warnings gemeinde   # municipality-level warning polygons
dwd --compact warnings coast      # coastal zones — text only, no polygons (see below)
```

Envelope shapes differ:
- `nowcast` / `gemeinde`: `{ time, warnings: [ {…, regions:[…]}, … ], binnenSee }` —
  `warnings` is an **array**. `binnenSee` (inland-lake warnings) was `null` in nowcast and
  `{}` in gemeinde when there were none.
- `coast`: `{ time, warnings: { <zoneId>: [ {…}, … ] }, vorabInformation }` — `warnings` is
  an **object keyed by zone**. Its items have **no `regions`** (checked live on
  2026-09-15), so there is nothing to map: for a coast request, list the zone ids with
  `event`/`level` instead and say the feed has no geometry.

## Step 2 — Build the GeoJSON — geometry handling is the whole job

Each nowcast/gemeinde warning carries a `regions` array. Each region has, redundantly:

- `polygonGeometry` — **already a valid GeoJSON `Polygon`** in `[lon, lat]` order. **Use
  this directly** as the feature geometry.
- `polygon` — a flat `[lat, lon, lat, lon, …]` number array (lat-first, opposite order).
- `triangles` — a triangulation index array for rendering; **ignore it for GeoJSON.**

> **The critical rule: prefer `region.polygonGeometry` verbatim.** It is RFC-7946-correct
> `[lon, lat]` polygon GeoJSON. Only fall back to building geometry from the flat `polygon`
> array if `polygonGeometry` is missing — and then remember `polygon` is **`[lat, lon]`
> pairs**, so you must swap each pair to `[lon, lat]`. Never feed `triangles` into geometry.

A single warning can have **multiple regions** → emit one `Feature` per region (or a
`MultiPolygon`), so a warning split across areas isn't collapsed to one shape.

```js
// per warning, per region
const feature = {
  type: "Feature",
  geometry: region.polygonGeometry,          // already [lon,lat] GeoJSON Polygon
  properties: {
    feed,                                     // "nowcast" | "gemeinde"
    warnId: w.warnId,
    event: w.event,
    level: w.level,
    headline: feed === "nowcast" ? w.event : w.headLine, // nowcast headLine is "NowCastMIX"
    description: w.descriptionText ?? w.description,
    start: w.start, end: w.end,               // epoch ms — keep raw, or ISO-ify
    isVorabinfo: w.isVorabinfo === true,
  },
};
```

Notes:
- Gemeinde's `headLine` is a real headline (`Amtliche WARNUNG vor GEWITTER`, translated in
  `--lang en`). Nowcast's `headLine` is only the product name `NowCastMIX` in German and is
  absent in `--lang en` — label nowcast features with `event`.
- Drop `undefined`/empty properties to keep output clean.
- Skip (and count) any region with no usable geometry.
- Wrap all features: `{ "type": "FeatureCollection", "features": [ … ] }`.

## Step 3 — Output

Write the FeatureCollection to a file the user can open (default
`./dwd-<feed>-warnings.geojson`, or a combined name for multi-feed exports) and report
**the path you wrote and the feature count**. If a name the user supplied already exists,
confirm before overwriting it (re-running with the default name to refresh is fine). Offer
to open it at https://geojson.io, or to colour by `level` for a severity map.

Validity checklist before handing it over:
- geometry came from `polygonGeometry` (already `[lon, lat]`) — or, if built from `polygon`,
  each `[lat, lon]` pair was swapped to `[lon, lat]`;
- `triangles` was never used as geometry;
- it parses as JSON and is a single `FeatureCollection`.

## Known quirks

- **Coast has no geometry.** Its `warnings` is keyed by zone, not a flat array, and its items
  carry no `regions` (nor `start`/`end`). A coast-only export yields zero features — say the
  coast feed can't be mapped and list the affected zone ids instead.
- Warning **volume is usually small** (a handful of active warnings), but each polygon can
  be dense (40+ vertices) — fine for a map layer, but warn before dumping the raw GeoJSON
  inline as text.
- An empty feed (calm weather) yields zero features — say "no active warnings to map"
  rather than implying a broken export.

---
name: dwd-warning-map
description: >
  Export active DWD weather warnings as valid GeoJSON for mapping, using the
  dwd-cli. Trigger when the user asks to "map the thunderstorm warnings",
  "export DWD warnings as GeoJSON", "show the warning areas on a map", "plot the
  Gemeinde warnings", or wants the warning polygons as geodata for Leaflet /
  geojson.io / QGIS. Pulls the nowcast / Gemeinde / coast feeds and emits a clean
  FeatureCollection of warning-area polygons.
version: 1.0.0
userInvocable: true
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
dwd --compact warnings coast      # coastal zones
```

Envelope shapes differ:
- `nowcast` / `gemeinde`: `{ time, warnings: [ {…, regions:[…]}, … ] }` — `warnings` is an
  **array**.
- `coast`: `{ time, warnings: { <zoneId>: [ {…}, … ] } }` — `warnings` is an **object keyed
  by zone**; iterate `Object.entries` and carry the zone id into properties.

## Step 2 — Build the GeoJSON — geometry handling is the whole job

Each warning carries a `regions` array. Each region has, redundantly:

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
    feed,                                     // "nowcast" | "gemeinde" | "coast"
    zone,                                     // coast: the object key; else undefined
    warnId: w.warnId,
    event: w.event,
    level: w.level,
    headline: w.headLine ?? w.headline,       // nowcast/gemeinde: headLine; coast: headline
    description: w.descriptionText ?? w.description,
    start: w.start, end: w.end,               // epoch ms — keep raw, or ISO-ify
    isVorabinfo: w.isVorabinfo === true,
  },
};
```

Notes:
- The headline key differs by feed: `headLine` (nowcast/gemeinde) vs `headline` (coast) —
  read both. In `--lang en` the headline is undefined; fall back to `event`.
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

- **Coast `warnings` is keyed by zone**, not a flat array — easy to iterate as an array by
  mistake and get nothing. Use `Object.entries`.
- Warning **volume is usually small** (a handful of active warnings), but each polygon can
  be dense (40+ vertices) — fine for a map layer, but warn before dumping the raw GeoJSON
  inline as text.
- An empty feed (calm weather) yields zero features — say "no active warnings to map"
  rather than implying a broken export.

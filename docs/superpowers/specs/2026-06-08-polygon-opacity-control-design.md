# Polygon Opacity Control — Design

**Date:** 2026-06-08
**Status:** Approved (design), pending implementation

## Goal

Let the user control the transparency of the colored polygons overlaid on the
map, so they can see the underlying map (streets, satellite) more clearly. The
control lives in the existing Settings panel — **no new map control buttons** —
addressing the concern about icon clutter on the map.

## Decision Summary

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Placement | Settings panel, under "MAP LAYER" section | Both are display prefs; zero added map clutter |
| Control type | `range` slider with live % label | Familiar, compact, RTL-friendly |
| Range | 15%–100%, default 100% | Floor keeps polygons faintly visible; 100% = today's look |
| Effect | Multiplier on `fillOpacity` + stroke `opacity` | Polygons + borders fade together |
| Modes affected | All (live + every history heatmap) | All share one `getStyle` |
| Live update | `ref.setStyle()`, not remount | Smooth while dragging ~1700 polygons |
| Persistence | `localStorage('polygonOpacity')` | Mirrors `mapType` pattern |
| Quick-access map button | Not included | Settings-only is sufficient |

## Architecture

Mirrors the existing `mapType` setting end to end.

### State (App.jsx)

```js
const [polygonOpacity, setPolygonOpacity] = useState(() => {
  const v = parseFloat(localStorage.getItem('polygonOpacity'))
  return Number.isFinite(v) ? v : 1
})
```

Passed down to both consumers (mirroring `mapType` at `App.jsx:984` and `:1161`):

- `<Map ... polygonOpacity={polygonOpacity} />`
- `<SettingsPanel ... polygonOpacity={polygonOpacity}
    onPolygonOpacityChange={(v) => { setPolygonOpacity(v); localStorage.setItem('polygonOpacity', String(v)) }} />`

### SettingsPanel UI

New section directly under the "MAP LAYER" (`mapType`) section (~`SettingsPanel.jsx:258`):

- Label: `שקיפות מצולעים` with the current value shown as a percentage,
  e.g. `שקיפות מצולעים — 72%`.
- A styled `<input type="range" min={15} max={100} step={1}>` whose value is
  `Math.round(polygonOpacity * 100)`. `onChange` calls
  `onPolygonOpacityChange(e.target.value / 100)`.
- Styling matches the panel's dark theme and RTL layout (consistent with the
  existing `OptionRow` / `Section` components).

### Map styling (Map.jsx)

`Map` receives `polygonOpacity` (default `1`). In `getStyle` (`Map.jsx:632`),
every returned style multiplies its `fillOpacity` by `polygonOpacity` and adds a
stroke `opacity: polygonOpacity`. At `polygonOpacity === 1` the map is visually
identical to today (stroke opacity defaults to 1).

Implementation note: factor the multiplier through a tiny helper rather than
editing each of the ~9 `return { ... }` sites by hand, e.g. wrap the final
returned object:

```js
const withOpacity = (s) => ({
  ...s,
  fillOpacity: s.fillOpacity * polygonOpacity,
  opacity: polygonOpacity,
})
```

and return `withOpacity({...})` from each branch (or wrap once at the call site).

### Live restyle (Map.jsx)

Attach a ref to the `GeoJSON` (`Map.jsx:826`) and restyle in place when opacity
changes, instead of forcing a remount via `zonesKey`:

```js
const geoJsonRef = useRef(null)
useEffect(() => {
  if (geoJsonRef.current) geoJsonRef.current.setStyle(getStyle)
}, [polygonOpacity])
```

`polygonOpacity` is **not** added to `zonesKey`, so dragging the slider does not
remount the ~1700 polygons. `setStyle(getStyle)` re-runs `getStyle` per layer
using the current closure (which has the latest `polygonOpacity`).

## Out of Scope (YAGNI)

- No quick-access map control button (Settings-only by decision).
- No per-mode or per-category opacity — single global multiplier.
- No animation/transition on opacity change beyond Leaflet's own.

## Testing / Verification

- At default (100%) the map is visually unchanged from current `main`.
- Dragging the slider fades polygons live in all modes (live + each history
  heatmap) without lag or remount flicker.
- Value persists across reloads via `localStorage`.
- Min stops at 15% — polygons remain faintly visible, never fully gone.

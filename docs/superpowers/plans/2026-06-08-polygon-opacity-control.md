# Polygon Opacity Control Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a slider in the Settings panel that controls the transparency of the colored polygons overlaid on the map.

**Architecture:** A single `polygonOpacity` multiplier (0.15–1) flows from `App.jsx` state (persisted to `localStorage`, mirroring the existing `mapType` wiring) down to `Map.jsx` (which multiplies every polygon's `fillOpacity` and sets stroke `opacity`) and to `SettingsPanel.jsx` (which renders the slider). Live updates use a `GeoJSON` ref + `setStyle()` to avoid remounting ~1700 polygons while dragging.

**Tech Stack:** React 18, react-leaflet 4, Leaflet 1.9, Tailwind, Vite.

> **Testing note:** This repo has **no test harness** (no vitest/jest, no test files). Per project rules (Simplicity First / Surgical Changes), we do **not** add one for this visual feature. Verification is manual via `npm run dev` and `npm run build`, consistent with the existing codebase.

---

### Task 1: Map applies the opacity multiplier (default = no visual change)

**Files:**
- Modify: `frontend/src/components/Map.jsx` (props `:562`, `getStyle` `:632`, `GeoJSON` `:826`)

- [ ] **Step 1: Add `polygonOpacity` to the `Map` props**

In the `Map` component signature at `frontend/src/components/Map.jsx:562`, add `polygonOpacity = 1` to the destructured props (place it right after `mapType = DEFAULT_MAP_TYPE,`):

```js
export default function Map({ heatmapData, currentAlerts, flyToArea, mode, mapType = DEFAULT_MAP_TYPE, polygonOpacity = 1, historyView = 'heatmap', realizationData = {}, catColors = {}, peakHoursData = {}, durationData = {}, simultaneousData = {}, sequenceData = {}, allAreas = [] }) {
```

- [ ] **Step 2: Add a `withOpacity` helper and wrap every `getStyle` return**

At the top of `getStyle` (just after `const getStyle = (feature) => {` at `frontend/src/components/Map.jsx:632`), add the helper:

```js
  const getStyle = (feature) => {
    const withOpacity = (s) => ({ ...s, fillOpacity: s.fillOpacity * polygonOpacity, opacity: polygonOpacity })
    const name = feature.properties.name
```

Then wrap **every** returned style object in `getStyle` (and the shared `defaultEmpty`) with `withOpacity(...)`. The returns to change are at lines `637`, `639`, `644` (`return defaultEmpty`), `648`, `653` (`return defaultEmpty`), `655`, `660` (`return defaultEmpty`), `662`, `667` (`return defaultEmpty`), `669`, `674` (`return defaultEmpty`), `676`, `681` (`return defaultEmpty`), `683`. Example transformations:

```js
        return withOpacity({ fillColor: liveColor, fillOpacity: 0.75, color: liveColor, weight: 2 })
```
```js
      return withOpacity({ fillColor: '#1e3a5f', fillOpacity: 0.08, color: '#2d4a6b', weight: 0.3 })
```
```js
      if (!rd || rd.total === 0) return withOpacity(defaultEmpty)
```
```js
      return withOpacity({ fillColor: c, fillOpacity: 0.72, color: c, weight: 1 })
```

Note: `defaultEmpty` (`:630`) stays defined as-is; only its `return` sites are wrapped (`return withOpacity(defaultEmpty)`).

- [ ] **Step 3: Add a ref to the `GeoJSON` and restyle live on opacity change**

Add a ref near the other refs in the `Map` component body (e.g. just above the `return (` at `:801`):

```js
  const geoJsonRef = useRef(null)
  useEffect(() => {
    if (geoJsonRef.current) geoJsonRef.current.setStyle(getStyle)
  }, [polygonOpacity])
```

Then attach the ref to the `GeoJSON` element at `frontend/src/components/Map.jsx:826`:

```jsx
        <GeoJSON
          key={zonesKey}
          ref={geoJsonRef}
          data={zones}
          style={getStyle}
          onEachFeature={onEachFeature}
        />
```

Confirm `useRef` and `useEffect` are already imported at the top of the file (they are — used elsewhere in `Map.jsx`). Do **not** add `polygonOpacity` to `zonesKey`.

- [ ] **Step 4: Verify the build compiles and default look is unchanged**

Run: `cd frontend && npm run build`
Expected: build succeeds with no errors.

Then run `npm run dev`, open the map. Expected: at default (`polygonOpacity = 1`) the polygons look **identical** to before — `0.72 * 1 = 0.72`, stroke `opacity: 1` matches Leaflet's default.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/Map.jsx
git commit -m "Add polygonOpacity multiplier to map polygon styles"
```

---

### Task 2: App holds and persists the opacity state

**Files:**
- Modify: `frontend/src/App.jsx` (state near `:312`, `<Map>` `:984`)

- [ ] **Step 1: Add `polygonOpacity` state initialized from localStorage**

Directly below the `mapType` state at `frontend/src/App.jsx:312`, add:

```js
  const [polygonOpacity,  setPolygonOpacity]  = useState(() => { const v = parseFloat(localStorage.getItem('polygonOpacity')); return Number.isFinite(v) ? v : 1 })
```

- [ ] **Step 2: Pass `polygonOpacity` into `<Map>`**

In the `<Map ... />` element at `frontend/src/App.jsx:984`, add the prop right after `mapType={mapType}`:

```jsx
        <Map heatmapData={heatmapData} currentAlerts={currentAlerts} flyToArea={flyToArea} mode={mode} mapType={mapType} polygonOpacity={polygonOpacity} historyView={historyView} realizationData={realizationData} catColors={catColors} peakHoursData={peakHoursData} durationData={durationData} simultaneousData={simultaneousData} sequenceData={sequenceData} allAreas={allAreas} />
```

- [ ] **Step 3: Verify build and persistence**

Run: `cd frontend && npm run build`
Expected: build succeeds.

In `npm run dev`, open the browser console and run `localStorage.setItem('polygonOpacity','0.3')`, then reload. Expected: polygons are noticeably more transparent (state read from storage and applied through Task 1). Reset with `localStorage.removeItem('polygonOpacity')` and reload — back to full.

- [ ] **Step 4: Commit**

```bash
git add frontend/src/App.jsx
git commit -m "Hold and persist polygonOpacity state in App"
```

---

### Task 3: Settings panel slider (end-to-end)

**Files:**
- Modify: `frontend/src/components/SettingsPanel.jsx` (props `:134`, after Map type section `:260`)
- Modify: `frontend/src/App.jsx` (`<SettingsPanel>` `:1158`)

- [ ] **Step 1: Add the slider props to `SettingsPanel`**

In the `SettingsPanel` props destructure at `frontend/src/components/SettingsPanel.jsx:136`, add `polygonOpacity, onPolygonOpacityChange,` right after `mapType, onMapTypeChange,`:

```js
  mapType, onMapTypeChange,
  polygonOpacity = 1, onPolygonOpacityChange,
```

- [ ] **Step 2: Render the opacity slider section**

Immediately after the "Map type" `Section` (after the closing `</Section>` at `frontend/src/components/SettingsPanel.jsx:260`), insert:

```jsx
          {/* Polygon opacity */}
          <Section title="שקיפות מצולעים">
            <div className="flex items-center gap-3 px-1" dir="rtl">
              <input
                type="range"
                min={15}
                max={100}
                step={1}
                value={Math.round(polygonOpacity * 100)}
                onChange={(e) => onPolygonOpacityChange(Number(e.target.value) / 100)}
                className="flex-1 accent-blue-500"
              />
              <span className="text-sm text-slate-300 tabular-nums w-12 text-left">{Math.round(polygonOpacity * 100)}%</span>
            </div>
          </Section>
```

- [ ] **Step 3: Wire the change handler from `App`**

In the `<SettingsPanel ... />` element at `frontend/src/App.jsx:1158`, add the two props alongside the existing `mapType` / `onMapTypeChange` props (the `mapType={mapType}` is at `:1161` and `onMapTypeChange` at `:1162`):

```jsx
        mapType={mapType}
        onMapTypeChange={(t) => { setMapType(t); localStorage.setItem('mapType', t) }}
        polygonOpacity={polygonOpacity}
        onPolygonOpacityChange={(v) => { setPolygonOpacity(v); localStorage.setItem('polygonOpacity', String(v)) }}
```

- [ ] **Step 4: Verify end-to-end**

Run: `cd frontend && npm run build`
Expected: build succeeds.

In `npm run dev`:
1. Open Settings (gear icon) → a "שקיפות מצולעים" section with a slider showing "100%" appears under the map-type section.
2. Drag the slider down — the polygons fade **live** (smoothly, no flicker/remount) on the visible map; the % label tracks the handle.
3. Slider stops at 15% (min) — polygons stay faintly visible, never fully gone.
4. Close and reopen the app — the chosen value persists.
5. Switch between live mode and a history heatmap — the opacity applies in both.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/components/SettingsPanel.jsx frontend/src/App.jsx
git commit -m "Add polygon opacity slider to Settings panel"
```

---

## Self-Review Notes

- **Spec coverage:** Settings-only placement (Task 3) ✓; 15–100% default 100% (Task 3 slider props) ✓; multiplier on fillOpacity + stroke opacity across all modes (Task 1 `withOpacity` wraps all `getStyle` branches) ✓; live `setStyle` without remount (Task 1 Step 3, `polygonOpacity` not in `zonesKey`) ✓; localStorage persistence mirroring `mapType` (Task 2 + Task 3 Step 3) ✓.
- **Naming consistency:** `polygonOpacity` / `setPolygonOpacity` / `onPolygonOpacityChange` / `geoJsonRef` / `withOpacity` used identically across all tasks.
- **No new map buttons** — `MapControls` untouched, per design.

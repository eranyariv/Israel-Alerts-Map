# 🛡️ Israel Alerts Map — מפת חוסן ישראל

An interactive heatmap of Israeli Home Front Command (Pikud HaOref) alerts, built with React and Leaflet.

**Live site:** [yariv.org/map](https://yariv.org/map/)

![Map screenshot showing alert heatmap over Israel](https://raw.githubusercontent.com/eranyariv/Israel-Alerts-Map/main/docs/screenshot.jpg)

---

## Features

- **Live alerts** — polls the Oref API in real time; flashes a banner and flies the map to the active zone
- **Historical data** — 14,000+ alerts from 2019 to today, merged from the [yuval-harpaz/alarms](https://github.com/yuval-harpaz/alarms) dataset (updated daily)
- **GeoJSON choropleth** — 1,450 Home Front Command alert zones rendered as color-coded polygons (green → red by intensity)
- **Filter by date range** — default last 3 months; includes presets for every major conflict since 2014
- **Filter by category** — rockets, aircraft, infiltration, earthquake
- **Top / bottom 250 areas** — sorted by alert count, click any area name to fly the map there
- **Mobile-friendly** — responsive layout with a bottom sheet on small screens
- **Local history** — captures alerts in `localStorage` during active alert periods

## Tech Stack

| Layer | Technology |
|-------|-----------|
| UI | React 18 + Vite + Tailwind CSS |
| Map | react-leaflet v4, Leaflet.js |
| Data | Oref live API (via proxy), static JSON archive |
| Polygons | [amitfin/oref_alert](https://github.com/amitfin/oref_alert) GeoJSON zones |
| Icons | lucide-react |
| Dates | date-fns with Hebrew locale |

## Project Structure

```
frontend/
  public/
    alertHistory.json     # 14,777 historical alerts (2019–today)
    alertZones.geojson    # 1,450 HFC zone polygons
  src/
    hooks/useAlerts.js    # Data fetching, merging, heatmap building
    components/
      Map.jsx             # GeoJSON choropleth map
      StatsPanel.jsx      # Stats, top/bottom areas
      FilterPanel.jsx     # Date range + category filters + conflict presets
      AlertBanner.jsx     # Live alert notification banner
      BottomSheet.jsx     # Mobile slide-up panel
      DebugPanel.jsx      # Dev debug overlay
    utils/
      heatmap.js          # Color scale, category constants
      localHistory.js     # localStorage persistence
      dateFormat.js       # Time formatting helpers
      logger.js           # In-memory log store
```

## Running Locally

```bash
cd frontend
npm install
npm run dev
```

Open [http://localhost:5173](http://localhost:5173).

The Vite dev server proxies `/oref/*` requests to `www.oref.org.il`, bypassing the Akamai geo-block that affects datacenter IPs.

## Building for Production

```bash
cd frontend
VITE_BASE_PATH=/israel-alerts/ npm run build
# Output: frontend/dist/
```

Upload the contents of `dist/` to your web server under `/israel-alerts/`.
You also need the PHP proxy (`deploy/api/proxy.php`) and `.htaccess` rewrite rules from the `deploy/` folder to handle Oref API requests server-side.

## Data Sources

| Source | Description |
|--------|-------------|
| [Pikud HaOref](https://www.oref.org.il) | Live alerts + recent history (rolling window) |
| [yuval-harpaz/alarms](https://github.com/yuval-harpaz/alarms) | Daily-updated CSV archive, 2019 → present |
| [amitfin/oref_alert](https://github.com/amitfin/oref_alert) | Alert zone polygons (GeoJSON) |

## Category Mapping

| Category | Description |
|----------|-------------|
| 1 | Rockets / Missiles (רקטות) |
| 2 | Hostile aircraft (כלי טיס עוין) |
| 3 | Infiltration (חדירת מחבלים) |
| 4 | Earthquake (רעידת אדמה) |

## License

MIT

"""
Merges redalert-history-backfill-2026-03-12.json with the relay's current
history.json, deduplicates, and writes alert-history-merged.json.

Dedup strategy:
  - Backfill items have a UUID 'id' from the RedAlert API — use that as primary key
  - Relay items have no id but have (type, startedAt) — use type + minute as fallback
  - Relay items take priority (they have richer startedAt/endedAt data)
  - Backfill items are mapped to relay format:
      type, title, cities, startedAt (= timestamp), endedAt (= timestamp)
"""
import json, sys, io

BACKFILL_FILE = r"C:\Users\erany\Downloads\redalert-history-backfill-2026-03-12.json"
RELAY_FILE    = r"C:\Users\erany\AppData\Local\Temp\relay-current.json"
OUT_FILE      = r"C:\src\israel-resilience-map\relay\alert-history-merged.json"

CAT_TITLES = {
    "missiles":                 "ירי רקטות וטילים",
    "hostileAircraftIntrusion": "חדירת כלי טיס עויין",
    "terroristInfiltration":    "חדירת מחבלים",
    "earthQuake":               "רעידת אדמה",
    "newsFlash":                "התראה מקדימה",
    "radiologicalEvent":        "אירוע רדיולוגי",
    "tsunami":                  "צונאמי",
    "hazardousMaterials":       "אירוע חומרים מסוכנים",
}

# ── Load files ────────────────────────────────────────────────────────────────

with open(BACKFILL_FILE, encoding="utf-8") as f:
    backfill = json.load(f)

with open(RELAY_FILE, encoding="utf-8") as f:
    relay = json.load(f)

# ── Normalise backfill items to relay format ──────────────────────────────────

def normalise_cities(raw):
    if not isinstance(raw, list):
        return []
    return [c["name"] if isinstance(c, dict) else c for c in raw if c]

normalised_backfill = []
for item in backfill:
    cat    = item.get("type") or item.get("category", "")
    cities = normalise_cities(item.get("cities", []))
    ts     = item.get("timestamp") or item.get("startedAt") or item.get("savedAt") or ""
    normalised_backfill.append({
        "_id":      item.get("id"),       # UUID from RedAlert API (kept for dedup only)
        "type":     cat,
        "title":    item.get("title") or CAT_TITLES.get(cat, "התראה"),
        "cities":   cities,
        "startedAt": ts,
        "endedAt":   ts,                  # duration unknown for historical records
    })

# ── Build seen sets from relay (highest priority — keep as-is) ────────────────

# Key 1: RedAlert UUID (if relay items somehow carry one)
seen_ids  = set()
# Key 2: type + minute-truncated startedAt
seen_keys = set()

merged = []

for e in relay:
    rid = e.get("_id")
    if rid:
        seen_ids.add(rid)
    key = (e.get("type", ""), (e.get("startedAt") or "")[:16])
    seen_keys.add(key)
    # Store without internal _id field
    merged.append({k: v for k, v in e.items() if k != "_id"})

# ── Add backfill items not already present ────────────────────────────────────

added = 0
skipped = 0

for e in normalised_backfill:
    rid = e.get("_id")
    key = (e.get("type", ""), (e.get("startedAt") or "")[:16])

    if (rid and rid in seen_ids) or (key in seen_keys):
        skipped += 1
        continue

    if rid:
        seen_ids.add(rid)
    seen_keys.add(key)
    merged.append({k: v for k, v in e.items() if k != "_id"})
    added += 1

# ── Sort newest first (relay convention) ──────────────────────────────────────

merged.sort(key=lambda e: e.get("startedAt") or "", reverse=True)

# ── Write output ──────────────────────────────────────────────────────────────

with open(OUT_FILE, "w", encoding="utf-8") as f:
    json.dump(merged, f, ensure_ascii=False, indent=2)

# Print summary (ASCII-safe for Windows console)
out = io.StringIO()
out.write(f"Relay events (kept as-is) : {len(relay)}\n")
out.write(f"Backfill records          : {len(backfill)}\n")
out.write(f"Added from backfill       : {added}\n")
out.write(f"Skipped (duplicates)      : {skipped}\n")
out.write(f"Total merged              : {len(merged)}\n")
out.write(f"Output                    : {OUT_FILE}\n")
sys.stdout.buffer.write(out.getvalue().encode("utf-8"))

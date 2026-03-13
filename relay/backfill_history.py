#!/usr/bin/env python3
"""
One-time historical backfill from RedAlert API → relay alert-history.json format.

Fetches all pages for all 8 alert categories, merges with the relay's current
live history (downloaded from /history.json), and saves the merged result to
alert-history-merged.json, ready to upload to Azure Files.

Usage:
    python backfill_history.py

Output:
    alert-history-merged.json   <- upload this to Azure Files as alert-history.json

After running, upload with (fill in your storage account name and share name):
    az storage file upload \
        --account-name <STORAGE_ACCOUNT> \
        --share-name <SHARE_NAME> \
        --source alert-history-merged.json \
        --path alert-history.json
Then restart the relay revision to reload from disk.
"""

import json, sys, time
from urllib.request import urlopen, Request
from urllib.error import HTTPError

PRIVATE_KEY = "pr_MOWrCRNqKRojDStFFrUMPfHtOChYhoQkgDiwMnnJqEtwOLCJXBbMlBimmENyjjmf"
BASE_URL    = "https://redalert.orielhaim.com/api/stats/history"
RELAY_URL   = "https://redalert-relay.yellowforest-0da0af56.uaenorth.azurecontainerapps.io"
LIMIT       = 100

CATEGORIES = [
    "missiles", "hostileAircraftIntrusion", "terroristInfiltration",
    "earthQuake", "newsFlash", "radiologicalEvent", "tsunami", "hazardousMaterials",
]

CAT_TITLES = {
    "missiles":                 "ירי רקטות וטילים",
    "hostileAircraftIntrusion": "חדירת כלי טיס עויין",
    "terroristInfiltration":    "חדירת מחבלים",
    "earthQuake":               "רעידת אדמה",
    "newsFlash":                "התרעה מקדימה",
    "radiologicalEvent":        "אירוע רדיולוגי",
    "tsunami":                  "צונאמי",
    "hazardousMaterials":       "אירוע חומרים מסוכנים",
}


def fetch_page(category, offset):
    url = f"{BASE_URL}?category={category}&limit={LIMIT}&offset={offset}"
    req = Request(url, headers={
        "Authorization": f"Bearer {PRIVATE_KEY}",
        "X-API-Key":     PRIVATE_KEY,
    })
    with urlopen(req, timeout=30) as resp:
        return json.loads(resp.read())


def fetch_category(category):
    items, offset = [], 0
    while True:
        data = fetch_page(category, offset)
        page = data.get("data", [])
        items.extend(page)
        print(f"  {category}: offset={offset} -> {len(page)} items (running total: {len(items)})")
        if not data.get("pagination", {}).get("hasMore", False):
            break
        offset += LIMIT
        time.sleep(0.15)   # be polite
    return items


def normalise_cities(raw):
    if not isinstance(raw, list):
        return []
    return [c["name"] if isinstance(c, dict) else c for c in raw if c]


# ── Step 1: download relay's current live history ────────────────────────────

print(f"Downloading current relay history from {RELAY_URL}/history.json ...")
try:
    with urlopen(f"{RELAY_URL}/history.json", timeout=30) as r:
        existing = json.loads(r.read())
    print(f"  Got {len(existing)} existing events")
except Exception as e:
    print(f"  WARNING: could not download existing history: {e}")
    existing = []

# ── Step 2: fetch all categories from RedAlert API ───────────────────────────

print("\nFetching history from RedAlert API...")
backfill = []
errors   = []

for cat in CATEGORIES:
    print(f"\n[{cat}]")
    try:
        items = fetch_category(cat)
        for item in items:
            cities = normalise_cities(item.get("cities", []))
            ts     = item.get("timestamp") or item.get("savedAt") or item.get("startedAt") or ""
            backfill.append({
                "type":      cat,
                "title":     item.get("title") or CAT_TITLES.get(cat, "התרעה"),
                "cities":    cities,
                "startedAt": ts,
                "endedAt":   ts,   # duration unknown for historical records
            })
        print(f"  -> {len(items)} total for {cat}")
    except HTTPError as e:
        msg = f"{cat}: HTTP {e.code} {e.reason}"
        print(f"  ERROR {msg}")
        errors.append(msg)
    except Exception as e:
        msg = f"{cat}: {e}"
        print(f"  ERROR {msg}")
        errors.append(msg)

# ── Step 3: merge, deduplicate, sort ─────────────────────────────────────────

# Dedup key: type + startedAt (truncated to minute precision)
def dedup_key(e):
    ts = (e.get("startedAt") or "")[:16]   # "2026-03-10T15:43"
    return (e.get("type", ""), ts)

seen    = set()
merged  = []

for e in existing:
    k = dedup_key(e)
    if k not in seen:
        seen.add(k)
        merged.append(e)

added = 0
for e in backfill:
    k = dedup_key(e)
    if k not in seen:
        seen.add(k)
        merged.append(e)
        added += 1

# Sort newest first (relay convention)
merged.sort(key=lambda e: e.get("startedAt") or "", reverse=True)

# ── Step 4: write output ──────────────────────────────────────────────────────

out = "alert-history-merged.json"
with open(out, "w", encoding="utf-8") as f:
    json.dump(merged, f, ensure_ascii=False, indent=2)

print(f"\n{'='*60}")
print(f"Existing relay events : {len(existing)}")
print(f"Backfill events       : {len(backfill)}")
print(f"New (after dedup)     : {added}")
print(f"Total merged          : {len(merged)}")
print(f"Output file           : {out}")
if errors:
    print(f"\nErrors ({len(errors)}):")
    for e in errors:
        print(f"  - {e}")
print(f"\nNext step — find your Azure Files storage account name and share name, then run:")
print(f"  az storage file upload --account-name <STORAGE_ACCOUNT> --share-name <SHARE_NAME> \\")
print(f"      --source {out} --path alert-history.json")
print(f"Then restart the relay to reload from disk.")

"""
Convert alarms.csv (yuval-harpaz/alarms) → alertHistory.json
Run: python build_history.py
"""
import csv, json, sys
from collections import defaultdict

THREAT_TO_CAT = {0: 1, 1: 1, 2: 3, 3: 4, 5: 2}

def threat_cat(threat_str, description):
    threat = int(threat_str) if threat_str.strip().lstrip('-').isdigit() else 0
    if threat == 0 and 'כלי טיס' in description:
        return 2
    return THREAT_TO_CAT.get(threat, 1)

def to_iso(dt_str):
    # "2026-03-05 23:06:12" → "2026-03-05T23:06:12+02:00"
    return dt_str.strip().replace(' ', 'T') + '+02:00'

# Group rows by (id, date) to handle reused IDs across years
# Key: (id, date_prefix) so same ID on different dates = different alerts
from collections import defaultdict as dd2
rows_by_key = dd2(list)
with open('alarms.csv', encoding='utf-8') as f:
    for row in csv.DictReader(f):
        aid = row['id'].strip()
        if not aid:
            continue
        date_prefix = row['time'].strip()[:10]  # YYYY-MM-DD
        rows_by_key[(aid, date_prefix)].append(row)

alerts = {}
for (aid, date_prefix), rows in rows_by_key.items():
    cities = []
    for row in rows:
        city = row['cities'].strip()
        if city and city not in cities:
            cities.append(city)
    first = rows[0]
    key = f"{aid}_{date_prefix}"
    alerts[key] = {
        'id':      key,
        'cat':     threat_cat(first['threat'], first['description']),
        'title':   first['description'].strip(),
        'cities':  cities,
        'savedAt': to_iso(first['time']),
    }

result = [a for a in alerts.values() if a['cities']]
result.sort(key=lambda x: x['savedAt'], reverse=True)

out = 'frontend/public/alertHistory.json'
with open(out, 'w', encoding='utf-8') as f:
    json.dump(result, f, ensure_ascii=False, separators=(',', ':'))

print(f"Written {len(result)} alerts to {out}")
print(f"Newest: {result[0]['savedAt']}")
print(f"Oldest: {result[-1]['savedAt']}")

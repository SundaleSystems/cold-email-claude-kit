#!/usr/bin/env python3
"""Step 3a — join candidates + scraped site text into per-batch JSON payloads
that qualification sub-agents read from disk (keeps prompts small)."""
import csv
import json
import os
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WORK = os.path.join(ROOT, "scripts", "icp-qualify", "work")
BATCH_DIR = os.path.join(WORK, "batches")
BATCH_SIZE = 20

with open(os.path.join(WORK, "candidates.csv"), newline="", encoding="utf-8") as f:
    rows = list(csv.DictReader(f))
with open(os.path.join(WORK, "sites.json"), encoding="utf-8") as f:
    sites = json.load(f)

by_domain = defaultdict(list)
for r in rows:
    by_domain[r["company_domain"]].append(r)

companies = []
for dom in sorted(by_domain):
    best = max(by_domain[dom], key=lambda r: int(r["_title_rank"]))
    site = sites.get(dom, {})
    pages = site.get("pages", [])
    companies.append({
        "domain": dom,
        "company_name": best["company_name"],
        "linkedin_industry": best["company_industry"],
        "headcount": best["company_headcount"],
        "location": best["location"],
        "contact_titles": sorted({r["job_title"] for r in by_domain[dom]}),
        "site_status": site.get("status", "missing"),
        "site_signals": site.get("signals", {}),
        "site_text": " || ".join(f"[{p['url']}] {p['text']}" for p in pages)[:7000],
    })

os.makedirs(BATCH_DIR, exist_ok=True)
for old in os.listdir(BATCH_DIR):
    os.remove(os.path.join(BATCH_DIR, old))

n = 0
for i in range(0, len(companies), BATCH_SIZE):
    n += 1
    path = os.path.join(BATCH_DIR, f"batch-{n:02d}.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(companies[i:i + BATCH_SIZE], f, indent=1)

print(f"{len(companies)} companies -> {n} batches of {BATCH_SIZE} in {BATCH_DIR}")
from collections import Counter
print("site status:", dict(Counter(c["site_status"] for c in companies)))

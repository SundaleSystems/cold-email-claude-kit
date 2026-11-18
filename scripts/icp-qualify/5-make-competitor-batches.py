#!/usr/bin/env python3
"""Step 5a — split all 96 qualified companies into competitor-research batches."""
import csv
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUTDIR = os.path.join(ROOT, "Lead-Lists", "5-ICP-Qualified")
WORK = os.path.join(ROOT, "scripts", "icp-qualify", "work", "competitors")
BATCH_SIZE = 7

SOURCES = [
    ("Perfect-Fit-ICP.csv", "send"),
    ("Perfect-Fit-ICP-more.csv", "more"),
]

companies = []
for fname, tag in SOURCES:
    path = os.path.join(OUTDIR, fname)
    with open(path, newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            companies.append({
                "domain": r["company_domain"],
                "company_name": r["company_name"],
                "business_model": r["business_model"],
                "what_they_sell": r["fit_reason"],
                "evidence_from_site": (r.get("evidence") or "")[:200],
                "first_pass_guess": r["named_competitors"],
                "source_file": tag,
            })

os.makedirs(WORK, exist_ok=True)
for old in os.listdir(WORK):
    os.remove(os.path.join(WORK, old))

n = 0
for i in range(0, len(companies), BATCH_SIZE):
    n += 1
    with open(os.path.join(WORK, f"comp-{n:02d}.json"), "w", encoding="utf-8") as f:
        json.dump(companies[i:i + BATCH_SIZE], f, indent=1)

print(f"{len(companies)} companies -> {n} batches of {BATCH_SIZE} in {WORK}")
print("by source:", {t: sum(1 for c in companies if c['source_file'] == t) for _, t in SOURCES})

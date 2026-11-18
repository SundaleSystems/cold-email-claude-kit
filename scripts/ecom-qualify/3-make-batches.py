#!/usr/bin/env python3
"""Step 3 — build per-batch JSON payloads for the qualification sub-agents.

One row per COMPANY (not per contact) so we never pay to judge the same company twice.
Sub-agents read these files from disk, which keeps prompts small.

Usage:
  python3 scripts/ecom-qualify/3-make-batches.py \
    --file=Lead-Lists/3-Million-Verifier/<run-id>_ok-with-status.csv
"""
import argparse
import csv
import json
import os

BATCH_SIZE = 20
MAX_DESC = 1200          # LinkedIn About text, trimmed
MAX_SPEC = 400


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", required=True)
    ap.add_argument("--sidecar", default="scripts/ecom-qualify/work/enriched.csv")
    ap.add_argument("--out-dir", default="scripts/ecom-qualify/work/batches")
    ap.add_argument("--batch-size", type=int, default=BATCH_SIZE)
    args = ap.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)

    with open(args.sidecar, encoding="utf-8-sig", newline="") as f:
        side_rows = list(csv.DictReader(f))
    # sidecar is per-contact; collapse to per-domain, preferring the richest record
    side = {}
    for r in side_rows:
        d = (r.get("company_domain", "") or "").strip().lower()
        if not d:
            continue
        cur = side.get(d)
        if cur is None or len(r.get("li_description", "")) > len(cur.get("li_description", "")):
            side[d] = r

    with open(args.file, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))

    seen, companies = set(), []
    for r in rows:
        d = (r.get("company_domain", "") or "").strip().lower()
        if not d or d in seen:
            continue
        seen.add(d)
        s = side.get(d, {})
        companies.append({
            "domain": d,
            "company_name": r.get("company_name", ""),
            "revenue_range": s.get("revenue_range", ""),
            "company_headcount": r.get("company_headcount", ""),
            "li_employees": s.get("li_employees", ""),
            "li_industry": s.get("li_industry", "") or r.get("company_industry", ""),
            "li_founded": s.get("li_founded", ""),
            "location": r.get("location", ""),
            "li_description": (s.get("li_description", "") or "")[:MAX_DESC],
            "li_specialities": (s.get("li_specialities", "") or "")[:MAX_SPEC],
        })

    batches = [companies[i:i + args.batch_size]
               for i in range(0, len(companies), args.batch_size)]
    for i, b in enumerate(batches, 1):
        p = os.path.join(args.out_dir, f"batch-{i:02d}.json")
        with open(p, "w", encoding="utf-8") as f:
            json.dump(b, f, indent=1)

    have_desc = sum(1 for c in companies if c["li_description"])
    have_rev = sum(1 for c in companies if c["revenue_range"])
    n = len(companies) or 1
    print(f"contacts in      {len(rows)}")
    print(f"unique companies {len(companies)}")
    print(f"batches          {len(batches)} x {args.batch_size}")
    print(f"with description {have_desc}/{len(companies)} ({100*have_desc//n}%)")
    print(f"with revenue     {have_rev}/{len(companies)} ({100*have_rev//n}%)")
    print(f"wrote {args.out_dir}/batch-01..{len(batches):02d}.json")
    if have_desc / n < 0.5:
        print("\n!! under half have a description - expect a lot of Tier C. "
              "Consider whether the sidecar join is intact.")


if __name__ == "__main__":
    main()

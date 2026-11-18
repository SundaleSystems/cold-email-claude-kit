#!/usr/bin/env python3
"""Step 5 — build adversarial re-check batches for every Tier A/B verdict.

A second agent is asked to REFUTE each A/B rating. On the prior travel run this moved
37 of 450 companies between tiers, so it is worth the pass: a first-pass judge that
wants to be helpful drifts toward generous.

Each payload carries the original verdict AND the source evidence, so the refuter can
check the quote against the description rather than re-judging from scratch.
"""
import glob
import json
import os

WORK = os.path.join(os.path.dirname(os.path.abspath(__file__)), "work")
BATCH_SIZE = 20


def main():
    src = {}
    for p in sorted(glob.glob(os.path.join(WORK, "batches", "batch-*.json"))):
        for c in json.load(open(p, encoding="utf-8")):
            src[(c.get("domain") or "").lower()] = c

    targets = []
    for p in sorted(glob.glob(os.path.join(WORK, "verdicts", "batch-*.json"))):
        for v in json.load(open(p, encoding="utf-8")):
            if (v.get("fit_tier") or "").upper() not in ("A", "B"):
                continue
            d = (v.get("domain") or "").lower()
            s = src.get(d, {})
            targets.append({
                "domain": d,
                "company_name": s.get("company_name", ""),
                "original_tier": v.get("fit_tier"),
                "original_confidence": v.get("confidence"),
                "original_reason": v.get("fit_reason"),
                "original_evidence": v.get("evidence"),
                "revenue_range": s.get("revenue_range", ""),
                "company_headcount": s.get("company_headcount", ""),
                "li_industry": s.get("li_industry", ""),
                "li_founded": s.get("li_founded", ""),
                "location": s.get("location", ""),
                "li_description": s.get("li_description", ""),
                "li_specialities": s.get("li_specialities", ""),
            })

    out_dir = os.path.join(WORK, "recheck-batches")
    os.makedirs(out_dir, exist_ok=True)
    for old in glob.glob(os.path.join(out_dir, "*.json")):
        os.remove(old)

    batches = [targets[i:i + BATCH_SIZE] for i in range(0, len(targets), BATCH_SIZE)]
    for i, b in enumerate(batches, 1):
        with open(os.path.join(out_dir, f"recheck-{i:02d}.json"), "w",
                  encoding="utf-8") as f:
            json.dump(b, f, indent=1)

    print(f"A/B verdicts to re-check {len(targets)}")
    print(f"batches                  {len(batches)} x {BATCH_SIZE}")
    print(f"wrote {out_dir}/recheck-01..{len(batches):02d}.json")


if __name__ == "__main__":
    main()

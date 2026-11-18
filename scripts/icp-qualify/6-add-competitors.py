#!/usr/bin/env python3
"""Step 6 — merge researched Competitor-1 / Competitor-2 into the qualified CSVs.

Reads comp-NN-verdict.json (research) and overlays verify-NN.json (corrections),
then inserts the two columns right after `named_competitors` in both output CSVs.
"""
import csv
import json
import os
import re
from collections import Counter

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUTDIR = os.path.join(ROOT, "Lead-Lists", "5-ICP-Qualified")
WORK = os.path.join(ROOT, "scripts", "icp-qualify", "work", "competitors")
FILES = ["Perfect-Fit-ICP.csv", "Perfect-Fit-ICP-more.csv"]


def clean(name):
    """Enforce the naming rule: brand as it brands itself, no URL cruft."""
    n = (name or "").strip()
    n = re.sub(r"^https?://", "", n)
    n = re.sub(r"^www\.", "", n)
    n = n.rstrip("/").strip()
    n = re.sub(r",?\s+(Inc\.?|LLC|Ltd\.?|Corp\.?)$", "", n, flags=re.I)
    return n.strip()


def load():
    res = {}
    for fn in sorted(os.listdir(WORK)):
        # only the research verdicts — judge-*-verdict.json holds screening
        # opinions with no competitor names and must never overwrite these
        if not (fn.startswith("comp-") and fn.endswith("-verdict.json")):
            continue
        with open(os.path.join(WORK, fn), encoding="utf-8") as f:
            data = json.load(f)
        for item in (data if isinstance(data, list) else data.get("companies", [])):
            res[item["domain"].strip().lower()] = item

    fixed = 0
    for fn in sorted(os.listdir(WORK)):
        if not fn.startswith("verify-"):
            continue
        with open(os.path.join(WORK, fn), encoding="utf-8") as f:
            data = json.load(f)
        for item in (data if isinstance(data, list) else data.get("companies", [])):
            dom = item["domain"].strip().lower()
            if dom not in res:
                continue
            for k in ("Competitor-1", "Competitor-2"):
                if item.get(k) and clean(item[k]) != clean(res[dom].get(k, "")):
                    res[dom][k] = item[k]
                    fixed += 1
            res[dom]["competitor_confidence"] = "verified"
    if fixed:
        print(f"verification corrected {fixed} competitor names")

    # rows the two cheap screens both cleared without needing an agent to browse
    for dom, v in res.items():
        v.setdefault("competitor_confidence", "screened")
    return res


def main():
    research = load()
    changed = 0
    missing = []
    all_names = Counter()

    for fname in FILES:
        path = os.path.join(OUTDIR, fname)
        with open(path, newline="", encoding="utf-8") as f:
            rows = list(csv.DictReader(f))
            cols = list(rows[0].keys())

        for c in ("Competitor-1", "Competitor-2", "competitor_confidence"):
            if c in cols:
                cols.remove(c)
        i = cols.index("named_competitors") + 1
        cols[i:i] = ["Competitor-1", "Competitor-2", "competitor_confidence"]

        for r in rows:
            v = research.get(r["company_domain"])
            if not v:
                missing.append(r["company_domain"])
                r["Competitor-1"] = ""
                r["Competitor-2"] = ""
                continue
            c1, c2 = clean(v.get("Competitor-1")), clean(v.get("Competitor-2"))
            r["Competitor-1"], r["Competitor-2"] = c1, c2
            r["competitor_confidence"] = v.get("competitor_confidence", "screened")
            all_names[c1] += 1
            all_names[c2] += 1
            if v.get("changed_from_guess"):
                changed += 1

        with open(path, "w", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
            w.writeheader()
            w.writerows(rows)
        print(f"{fname}: {len(rows)} rows updated")

    print(f"\nrows where research changed the first-pass guess: {changed}")
    if missing:
        print(f"WARNING no research for {len(missing)} domains: {missing[:10]}")
    total = sum(all_names.values())
    print(f"\nmost common competitor names (of {total} slots):")
    for name, n in all_names.most_common(8):
        print(f"  {n:>3} ({n / total * 100:4.1f}%)  {name}")


if __name__ == "__main__":
    main()

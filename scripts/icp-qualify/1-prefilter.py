#!/usr/bin/env python3
"""Step 1 — deterministic pre-filter of the 879-lead final list into a candidate pool.

Drops only what is unambiguously wrong (junk titles, no domain, excluded domains,
DMOs/associations, auto-drop industries). Headcount and blank industries are
deliberately NOT filtered — the website read in step 2/3 makes that call.
"""
import csv
import os
import re
import sys
from collections import Counter, defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
SRC = os.path.join(ROOT, "Lead-Lists", "4-Final-Lead-Lists",
                   "travel-ota-founders-us_2026-07-22_final.csv")
OUT_DIR = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "scripts", "icp-qualify", "work")

SENIOR = re.compile(
    r"\b(founder|co-?founder|owner|ceo|chief executive|president|managing director|"
    r"proprietor|principal)\b", re.I)
JUNK = re.compile(
    r"\b(intern|assistant|coordinator|student|retired|advisor to|board member|"
    r"investor|instructor|volunteer)\b", re.I)
DMO = re.compile(
    r"(^visit|^explore|^discover|^see[a-z]|convention|tourism board|chamber|"
    r"bureau of|museum)", re.I)

PLACEHOLDER_DOMAINS = {
    "linktr.ee", "youtu.be", "youtube.com", "facebook.com", "linkedin.com",
    "instagram.com", "twitter.com", "x.com", "wixsite.com", "google.com",
    "sites.google.com", "bit.ly", "gmail.com",
}
EXCLUDED_DOMAINS = {"cruisedirect.com", "icruise.com", "cruise.com", "cruiseonly.com"}
DROP_INDUSTRIES = {
    "Hospitality", "Airlines and Aviation", "Airlines/Aviation",
    "Non-profit Organizations", "Museums, Historical Sites, and Zoos",
    "Industry Associations", "Non-profit Organization Management",
}

# Title seniority rank used to pick the single best contact per company later.
def title_rank(title):
    t = title.lower()
    if re.search(r"\b(co-?founder|founder|owner|proprietor)\b", t):
        return 3
    if re.search(r"\b(ceo|chief executive)\b", t):
        return 2
    if re.search(r"\b(president|managing director|principal)\b", t):
        return 1
    return 0


def norm_domain(d):
    d = (d or "").strip().lower()
    d = re.sub(r"^https?://", "", d)
    d = re.sub(r"^www\.", "", d)
    return d.split("/")[0]


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    with open(SRC, newline="", encoding="utf-8") as f:
        rows = list(csv.DictReader(f))

    drops = Counter()
    kept = []
    for r in rows:
        title = r.get("job_title", "") or ""
        dom = norm_domain(r.get("company_domain", ""))
        name = r.get("company_name", "") or ""
        ind = (r.get("company_industry", "") or "").strip()

        if not SENIOR.search(title):
            drops["title_not_senior"] += 1
            continue
        if JUNK.search(title):
            drops["title_junk"] += 1
            continue
        if not dom:
            drops["no_domain"] += 1
            continue
        if dom in PLACEHOLDER_DOMAINS:
            drops["placeholder_domain"] += 1
            continue
        if dom in EXCLUDED_DOMAINS:
            drops["excluded_domain"] += 1
            continue
        if DMO.search(name) or DMO.search(dom):
            drops["dmo_or_association"] += 1
            continue
        if ind in DROP_INDUSTRIES:
            drops["auto_drop_industry"] += 1
            continue

        r["company_domain"] = dom
        r["_title_rank"] = str(title_rank(title))
        kept.append(r)

    # one representative row per company domain (highest title rank) for the site scrape
    by_domain = defaultdict(list)
    for r in kept:
        by_domain[r["company_domain"]].append(r)

    fields = [c for c in rows[0].keys()] + ["_title_rank"]
    cand_path = os.path.join(OUT_DIR, "candidates.csv")
    with open(cand_path, "w", newline="", encoding="utf-8") as f:
        w = csv.DictWriter(f, fieldnames=fields)
        w.writeheader()
        w.writerows(kept)

    dom_path = os.path.join(OUT_DIR, "domains.txt")
    with open(dom_path, "w", encoding="utf-8") as f:
        for d in sorted(by_domain):
            f.write(d + "\n")

    print(f"source rows          : {len(rows)}")
    for k, v in drops.most_common():
        print(f"  dropped {k:22} : {v}")
    print(f"candidate rows       : {len(kept)}")
    print(f"unique companies     : {len(by_domain)}")
    print(f"wrote {cand_path}")
    print(f"wrote {dom_path}")


if __name__ == "__main__":
    main()

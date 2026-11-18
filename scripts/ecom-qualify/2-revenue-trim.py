#!/usr/bin/env python3
"""Step 2 — drop out-of-revenue-band and obviously non-ICP rows BEFORE paying for emails.

This is the cost lever in the whole pipeline: every row dropped here is a LeadMagic
lookup and a MillionVerifier credit we don't spend. Runs against the canonical CSV
using the sidecar from 1-enrich-from-raw.py.

Nothing is deleted - drops go to a sibling _dropped.csv with a drop_reason.

Usage:
  python3 scripts/ecom-qualify/2-revenue-trim.py \
    --file=Lead-Lists/1-Vayne/<run-id>_vayne.csv \
    --sidecar=scripts/ecom-qualify/work/enriched.csv \
    [--dry-run]
"""
import argparse
import collections
import csv
import os
import re
import sys

CANONICAL = ["company_domain", "first_name", "last_name", "job_title", "linkedin_url",
             "email", "email_source", "company_name", "company_industry",
             "company_headcount", "company_phone", "location", "company_linkedin_url"]

REV_IN_BAND = {"1M USD - 2.5M USD", "2.5M USD - 5M USD"}
REV_EDGE = {"5M USD - 10M USD"}
REV_BELOW = {"500T USD - 1M USD"}

# Anything at or above this is out. Parsed generically so unseen bands still get caught.
def revenue_verdict(band):
    """-> ('keep', rank) | ('drop', reason)"""
    b = (band or "").strip()
    if not b:
        return ("keep", 3)          # unknown: headcount + sub-agent decide
    if b in REV_IN_BAND:
        return ("keep", 1)
    if b in REV_EDGE:
        return ("keep", 2)
    if b in REV_BELOW:
        return ("drop", f"revenue-below-floor:{b}")
    # generic parse of the lower bound, e.g. "10M USD - 20M USD" -> 10M
    m = re.match(r"([\d.]+)\s*([TMB])\s*USD", b, re.I)
    if m:
        val, unit = float(m.group(1)), m.group(2).upper()
        mult = {"T": 1e3, "M": 1e6, "B": 1e9}[unit]
        low = val * mult
        if low < 1e6:
            return ("drop", f"revenue-below-floor:{b}")
        if low >= 1e7:
            return ("drop", f"revenue-above-ceiling:{b}")
        return ("keep", 2)
    return ("keep", 3)               # unparseable: don't drop on it


TITLE_T1 = re.compile(
    r"\b(founder|co-?founder|owner|ceo|chief executive|president|proprietor|"
    r"managing director|managing partner)\b", re.I)

# Seniority word within ~30 chars of marketing/ecommerce/growth. This is what catches
# the real-world variants Sales Navigator returns - "Head of Brand Marketing",
# "Director, Marketing & E-commerce", "Director of Sales and Marketing" - which are the
# marketing decision-maker at an 11-50 person brand. Requiring BOTH a seniority token
# and a marketing token keeps "VP Sales" and "Account Executive" out.
TITLE_T2 = re.compile(
    r"\b(head|director|vp|vice president|chief|lead|manager)\b[^,|]{0,30}?"
    r"\b(marketing|e-?commerce|ecom|growth|brand|digital|acquisition|media)\b"
    r"|\b(marketing|e-?commerce|ecom|growth|brand|digital|performance|paid)\b"
    r"[^,|]{0,30}?\b(head|director|vp|vice president|chief|lead|manager)\b"
    r"|\b(cmo|media buyer|performance marketing|growth marketing|"
    r"paid (social|media|acquisition))\b", re.I)

# Junk that slipped past the Sales Nav title exclusions.
TITLE_JUNK = re.compile(
    r"\b(intern|assistant|coordinator|student|part-?time|retired|volunteer|"
    r"seeking|open to work|advisor|board member|investor|recruiter|"
    r"freelance|consultant|contractor)\b", re.I)

# Industries that are retail-coded but not DTC e-commerce brands.
INDUSTRY_OUT = re.compile(
    r"\b(staffing|recruit|real estate|insurance|bank|law|legal|accounting|"
    r"construction|automotive repair|gas station|funeral)\b", re.I)

PLACEHOLDER_DOMAIN = re.compile(
    r"^(linktr\.ee|facebook\.com|instagram\.com|linkedin\.com|shopify\.com|"
    r"squarespace\.com|wix\.com|amazon\.com|etsy\.com|google\.com|bit\.ly)$", re.I)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", required=True)
    ap.add_argument("--sidecar", default="scripts/ecom-qualify/work/enriched.csv")
    ap.add_argument("--out")
    ap.add_argument("--out-dropped")
    ap.add_argument("--out-ranks", default="scripts/ecom-qualify/work/ranks.csv")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()

    base = args.file[:-4] if args.file.endswith(".csv") else args.file
    out_path = args.out or args.file          # in place, like trim-and-register.ts
    dropped_path = args.out_dropped or f"{base}-revenue-dropped.csv"

    with open(args.file, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))
    with open(args.sidecar, encoding="utf-8-sig", newline="") as f:
        side = {(r["linkedin_url"] or "").strip().lower().rstrip("/"): r
                for r in csv.DictReader(f)}

    kept, dropped, ranks = [], [], []
    reasons = collections.Counter()

    for r in rows:
        u = (r.get("linkedin_url", "") or "").strip().lower().rstrip("/")
        s = side.get(u, {})
        title = r.get("job_title", "") or ""
        domain = (r.get("company_domain", "") or "").strip().lower()
        reason = None

        if TITLE_JUNK.search(title):
            reason = f"junk-title:{title[:40]}"
        elif not TITLE_T1.search(title) and not TITLE_T2.search(title):
            reason = f"off-icp-title:{title[:40]}"
        elif not domain:
            reason = "no-company-domain"
        elif PLACEHOLDER_DOMAIN.match(domain):
            reason = f"placeholder-domain:{domain}"
        elif INDUSTRY_OUT.search(r.get("company_industry", "") or "") or \
                INDUSTRY_OUT.search(s.get("li_industry", "") or ""):
            reason = f"industry-out:{r.get('company_industry','')[:30]}"
        else:
            verdict, payload = revenue_verdict(s.get("revenue_range", ""))
            if verdict == "drop":
                reason = payload
            else:
                rev_rank = payload

        if reason:
            reasons[reason.split(":")[0]] += 1
            d = {k: r.get(k, "") for k in CANONICAL}
            d["drop_reason"] = reason
            dropped.append(d)
        else:
            kept.append({k: r.get(k, "") for k in CANONICAL})
            ranks.append({
                "linkedin_url": r.get("linkedin_url", ""),
                "company_domain": domain,
                "title_rank": 1 if TITLE_T1.search(title) else 2,
                "revenue_rank": rev_rank,
                "revenue_range": s.get("revenue_range", ""),
            })

    print(f"input   {len(rows)}")
    print(f"kept    {len(kept)}")
    print(f"dropped {len(dropped)}")
    print("\n--- drop reasons ---")
    for k, v in reasons.most_common():
        print(f"  {v:5d}  {k}")

    print("\n--- kept: revenue rank ---")
    rr = collections.Counter(x["revenue_rank"] for x in ranks)
    labels = {1: "1  known in-band ($1-5M)", 2: "2  edge ($5-10M / unparsed)",
              3: "3  revenue unknown"}
    for k in sorted(rr):
        print(f"  {rr[k]:5d}  {labels.get(k, k)}")

    print("\n--- kept: title rank ---")
    tr = collections.Counter(x["title_rank"] for x in ranks)
    for k in sorted(tr):
        print(f"  {tr[k]:5d}  {'1  owner/CEO' if k == 1 else '2  growth/marketing'}")

    uniq = len({x['company_domain'] for x in ranks})
    print(f"\nunique companies kept  {uniq}")

    if args.dry_run:
        print("\n(dry run - nothing written)")
        return

    os.makedirs(os.path.dirname(args.out_ranks), exist_ok=True)
    with open(out_path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=CANONICAL)
        w.writeheader()
        w.writerows(kept)
    with open(dropped_path, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=CANONICAL + ["drop_reason"])
        w.writeheader()
        w.writerows(dropped)
    with open(args.out_ranks, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=["linkedin_url", "company_domain",
                                          "title_rank", "revenue_rank", "revenue_range"])
        w.writeheader()
        w.writerows(ranks)

    print(f"\nwrote {out_path}")
    print(f"wrote {dropped_path}")
    print(f"wrote {args.out_ranks}")


if __name__ == "__main__":
    main()

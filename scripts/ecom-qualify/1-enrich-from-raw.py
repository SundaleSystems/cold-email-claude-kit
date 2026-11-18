#!/usr/bin/env python3
"""Step 1 — recover the LinkedIn company fields that normalize-vayne.ts discards.

The canonical 13-column CSV drops several raw Sales Navigator columns that are the
only evidence we have for this ICP — above all `linkedin company revenue range`,
which maps directly onto the $1M-$8M criterion.

This writes a SIDECAR keyed by linkedin_url. The main pipeline file stays canonical-13
because leadmagic-find-emails.ts expects exactly those headers.

Usage:
  python3 scripts/ecom-qualify/1-enrich-from-raw.py \
    --raw=Lead-Lists/1-Vayne/<run-id>_vayne-raw.csv \
    --canonical=Lead-Lists/1-Vayne/<run-id>_vayne.csv
"""
import argparse
import collections
import csv
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WORK = os.path.join(ROOT, "scripts", "ecom-qualify", "work")

# raw export column -> sidecar column
PULL = {
    "linkedin company revenue range": "revenue_range",
    "linkedin industry": "li_industry",
    "linkedin employees": "li_employees",
    "linkedin company employee count": "li_employee_count",
    "linkedin description": "li_description",
    "linkedin specialities": "li_specialities",
    "linkedin founded year": "li_founded",
    "linkedin company location": "li_company_location",
    "headline": "headline",
    "job description": "job_description",
    "summary": "summary",
}

SIDECAR_COLS = ["linkedin_url", "member_id", "company_domain", "company_name"] + list(PULL.values())

# Revenue bands. LinkedIn writes thousands as "500T USD" and millions as "5M USD".
REV_IN_BAND = {"1M USD - 2.5M USD", "2.5M USD - 5M USD"}
REV_EDGE = {"5M USD - 10M USD"}          # straddles the $8M ceiling
REV_BELOW = {"500T USD - 1M USD"}


def norm_url(u):
    """Match the normalization leadmagic-find-emails.ts uses for its journal keys."""
    return (u or "").strip().lower().rstrip("/")


def find_col(headers, wanted):
    """Raw Vayne headers are lowercase space-separated, but be tolerant."""
    lookup = {re.sub(r"[^a-z0-9]", "", h.lower()): h for h in headers}
    return lookup.get(re.sub(r"[^a-z0-9]", "", wanted.lower()))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--raw", required=True)
    ap.add_argument("--canonical", required=True)
    ap.add_argument("--out", default=os.path.join(WORK, "enriched.csv"))
    args = ap.parse_args()

    os.makedirs(os.path.dirname(args.out), exist_ok=True)

    with open(args.raw, encoding="utf-8-sig", newline="") as f:
        raw_rows = list(csv.DictReader(f))
    if not raw_rows:
        sys.exit(f"FATAL: {args.raw} is empty")
    raw_headers = list(raw_rows[0].keys())

    url_col = find_col(raw_headers, "linkedin url")
    mid_col = find_col(raw_headers, "member linkedin id")
    if not url_col:
        sys.exit("FATAL: raw export has no 'linkedin url' column - cannot join")

    resolved = {}
    for want, out_name in PULL.items():
        col = find_col(raw_headers, want)
        resolved[out_name] = col
        if col is None:
            print(f"  ! raw export missing '{want}' - {out_name} will be blank")

    # index raw by normalized url, and by member id as fallback
    by_url, by_mid = {}, {}
    for r in raw_rows:
        rec = {out_name: (r.get(col, "") or "").strip() if col else ""
               for out_name, col in resolved.items()}
        rec["member_id"] = (r.get(mid_col, "") or "").strip() if mid_col else ""
        u = norm_url(r.get(url_col, ""))
        if u:
            by_url[u] = rec
        if rec["member_id"]:
            by_mid[rec["member_id"]] = rec

    with open(args.canonical, encoding="utf-8-sig", newline="") as f:
        canon = list(csv.DictReader(f))
    if not canon:
        sys.exit(f"FATAL: {args.canonical} is empty")

    matched_url = matched_mid = unmatched = 0
    out_rows = []
    for c in canon:
        u = norm_url(c.get("linkedin_url", ""))
        rec = by_url.get(u)
        if rec:
            matched_url += 1
        else:
            # last resort: the member id is embedded in some linkedin_url forms
            m = re.search(r"(AC[wo]AA[A-Za-z0-9_-]+)", c.get("linkedin_url", "") or "")
            rec = by_mid.get(m.group(1)) if m else None
            if rec:
                matched_mid += 1
            else:
                unmatched += 1
                rec = {k: "" for k in list(PULL.values()) + ["member_id"]}

        row = {
            "linkedin_url": c.get("linkedin_url", ""),
            "member_id": rec.get("member_id", ""),
            "company_domain": c.get("company_domain", ""),
            "company_name": c.get("company_name", ""),
        }
        for out_name in PULL.values():
            row[out_name] = rec.get(out_name, "")
        out_rows.append(row)

    with open(args.out, "w", encoding="utf-8", newline="") as f:
        w = csv.DictWriter(f, fieldnames=SIDECAR_COLS)
        w.writeheader()
        w.writerows(out_rows)

    total = len(canon)
    rate = 100.0 * (matched_url + matched_mid) / total
    print(f"\ncanonical rows      {total}")
    print(f"joined by url       {matched_url}")
    print(f"joined by member id {matched_mid}")
    print(f"UNMATCHED           {unmatched}  ({100.0*unmatched/total:.1f}%)")
    print(f"join rate           {rate:.1f}%")

    filled = sum(1 for r in out_rows if r["revenue_range"])
    print(f"\nrevenue_range filled {filled}/{total} ({100.0*filled/total:.0f}%)")
    print("--- revenue band histogram ---")
    hist = collections.Counter(r["revenue_range"] or "(blank)" for r in out_rows)
    for k, v in hist.most_common():
        tag = ""
        if k in REV_IN_BAND:
            tag = "  <- IN BAND"
        elif k in REV_EDGE:
            tag = "  <- edge ($8M ceiling)"
        elif k in REV_BELOW:
            tag = "  <- below floor"
        print(f"  {v:5d}  {k}{tag}")

    for c in ("li_description", "li_specialities", "li_industry", "li_employees"):
        n = sum(1 for r in out_rows if r[c])
        print(f"{c:20s} filled {n}/{total} ({100.0*n/total:.0f}%)")

    print(f"\nwrote {args.out}")
    if rate < 95:
        print("\n!! join rate below 95% - the join key is likely broken. Investigate "
              "before trusting the revenue trim.")


if __name__ == "__main__":
    main()

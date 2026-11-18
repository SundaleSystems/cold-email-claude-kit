#!/usr/bin/env python3
"""Step 4 — join verdicts, rank, dedupe to one contact per company, cut to the top N.

Scoring
  tier        A=100  B=70  C=30  D=drop
  title_rank  1 (owner/CEO) = +10        <- stated contact priority
  revenue     known in-band = +5, edge band = +2, unknown = 0
  confidence  high = +3, med = 0, low = -5
  free-mail domain (gmail/yahoo/...) = -15

Adversarial re-check verdicts in work/recheck/*.json override the original tier.

Usage:
  python3 scripts/ecom-qualify/4-rank-and-write.py \
    --file=Lead-Lists/3-Million-Verifier/<run-id>_ok-with-status.csv \
    --run-id=<run-id> --top=100
"""
import argparse
import collections
import csv
import glob
import json
import os
import re

TIER_SCORE = {"A": 100, "B": 70, "C": 30, "D": -999}
CONF_SCORE = {"high": 3, "med": 0, "low": -5}
REV_SCORE = {1: 5, 2: 2, 3: 0}
FREEMAIL = re.compile(r"@(gmail|yahoo|hotmail|outlook|aol|icloud|proton(mail)?)\.",
                      re.I)

OUT_COLS = ["company_domain", "first_name", "last_name", "job_title", "linkedin_url",
            "email", "email_source", "company_name", "company_industry",
            "company_headcount", "company_phone", "location", "company_linkedin_url",
            "leadmagic_status", "revenue_range", "fit_tier", "fit_score", "confidence",
            "is_dtc_ecommerce", "revenue_basis", "est_team_shape", "title_rank",
            "fit_reason", "evidence", "rechecked"]


def load_json_dir(path):
    out = {}
    for p in sorted(glob.glob(os.path.join(path, "*.json"))):
        try:
            with open(p, encoding="utf-8") as f:
                data = json.load(f)
        except Exception as e:
            print(f"  ! skipping unreadable {p}: {e}")
            continue
        for v in (data if isinstance(data, list) else [data]):
            d = (v.get("domain", "") or "").strip().lower()
            if d:
                out[d] = v
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--file", required=True)
    ap.add_argument("--run-id", required=True)
    ap.add_argument("--sidecar", default="scripts/ecom-qualify/work/enriched.csv")
    ap.add_argument("--ranks", default="scripts/ecom-qualify/work/ranks.csv")
    ap.add_argument("--verdicts", default="scripts/ecom-qualify/work/verdicts")
    ap.add_argument("--recheck", default="scripts/ecom-qualify/work/recheck")
    ap.add_argument("--out-dir", default="Lead-Lists/5-ICP-Qualified")
    ap.add_argument("--top", type=int, default=100)
    args = ap.parse_args()

    os.makedirs(args.out_dir, exist_ok=True)

    verdicts = load_json_dir(args.verdicts)
    rechecks = load_json_dir(args.recheck) if os.path.isdir(args.recheck) else {}
    print(f"verdicts {len(verdicts)} | rechecks {len(rechecks)}")

    with open(args.sidecar, encoding="utf-8-sig", newline="") as f:
        side = {(r["linkedin_url"] or "").strip().lower().rstrip("/"): r
                for r in csv.DictReader(f)}
    ranks = {}
    if os.path.exists(args.ranks):
        with open(args.ranks, encoding="utf-8-sig", newline="") as f:
            ranks = {(r["linkedin_url"] or "").strip().lower().rstrip("/"): r
                     for r in csv.DictReader(f)}

    with open(args.file, encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))

    tier_moves = 0
    scored = []
    for r in rows:
        d = (r.get("company_domain", "") or "").strip().lower()
        v = verdicts.get(d)
        if not v:
            continue
        rc = rechecks.get(d)
        tier = (v.get("fit_tier") or "C").upper()
        if rc and rc.get("fit_tier") and rc["fit_tier"].upper() != tier:
            tier = rc["fit_tier"].upper()
            tier_moves += 1
        if tier == "D":
            continue

        u = (r.get("linkedin_url", "") or "").strip().lower().rstrip("/")
        rk = ranks.get(u, {})
        title_rank = int(rk.get("title_rank") or 2)
        rev_rank = int(rk.get("revenue_rank") or 3)
        conf = (rc or v).get("confidence", "med")

        score = (TIER_SCORE[tier]
                 + (10 if title_rank == 1 else 0)
                 + REV_SCORE.get(rev_rank, 0)
                 + CONF_SCORE.get(conf, 0)
                 + (-15 if FREEMAIL.search(r.get("email", "") or "") else 0))

        s = side.get(u, {})
        scored.append({
            **{k: r.get(k, "") for k in OUT_COLS[:14]},
            "revenue_range": s.get("revenue_range", "") or rk.get("revenue_range", ""),
            "fit_tier": tier,
            "fit_score": score,
            "confidence": conf,
            "is_dtc_ecommerce": v.get("is_dtc_ecommerce", ""),
            "revenue_basis": v.get("revenue_basis", ""),
            "est_team_shape": v.get("est_team_shape", ""),
            "title_rank": title_rank,
            "fit_reason": (rc or v).get("fit_reason", ""),
            "evidence": v.get("evidence", ""),
            "rechecked": "yes" if rc else "no",
        })

    # one contact per company: best score, owner/CEO breaks ties
    best = {}
    for s in scored:
        d = s["company_domain"]
        cur = best.get(d)
        if cur is None or (s["fit_score"], -s["title_rank"]) > (cur["fit_score"], -cur["title_rank"]):
            best[d] = s

    pool = sorted(best.values(), key=lambda x: (-x["fit_score"], x["title_rank"],
                                                x["company_name"]))
    top = pool[:args.top]

    top_p = os.path.join(args.out_dir, f"{args.run_id}_top-{args.top}.csv")
    pool_p = os.path.join(args.out_dir, f"{args.run_id}_qualified-pool.csv")
    for path, data in ((top_p, top), (pool_p, pool)):
        with open(path, "w", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=OUT_COLS, extrasaction="ignore")
            w.writeheader()
            w.writerows(data)

    tiers = collections.Counter(x["fit_tier"] for x in pool)
    titles = collections.Counter(x["title_rank"] for x in top)
    rev = collections.Counter(x["revenue_range"] or "(blank)" for x in top)

    print(f"\ncontacts scored     {len(scored)}")
    print(f"tier moved on recheck {tier_moves}")
    print(f"unique companies    {len(pool)}")
    print(f"TOP {args.top:<15} {len(top)}")
    print("\n--- qualified pool by tier ---")
    for t in "ABC":
        print(f"  {t}: {tiers.get(t, 0)}")
    print(f"\n--- top {len(top)} by contact priority ---")
    print(f"  owner/CEO        {titles.get(1, 0)}")
    print(f"  growth/marketing {titles.get(2, 0)}")
    print(f"\n--- top {len(top)} by revenue band ---")
    for k, v in rev.most_common():
        print(f"  {v:4d}  {k}")

    print(f"\nwrote {top_p}")
    print(f"wrote {pool_p}")
    if len(top) < args.top:
        print(f"\n!! only {len(top)} of {args.top} - see Contingency in the plan")


if __name__ == "__main__":
    main()

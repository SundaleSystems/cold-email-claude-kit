#!/usr/bin/env python3
"""Add all 96 qualified leads to an Instantly DRAFT campaign.

Competitor names go in custom_variables as competitor_1 / competitor_2 so the
copy can use {{competitor_1}} merge tags (hyphenated CSV headers aren't valid
merge tags).
"""
import csv
import json
import os
import sys
import urllib.request

CAMPAIGN_ID = sys.argv[1]
ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
OUTDIR = os.path.join(ROOT, "Lead-Lists", "5-ICP-Qualified")
FILES = ["Perfect-Fit-ICP.csv", "Perfect-Fit-ICP-more.csv"]

key = None
for line in open(os.path.join(ROOT, ".env"), encoding="utf-8"):
    if line.strip().startswith("INSTANTLY_API_KEY"):
        key = line.split("=", 1)[1].strip().strip('"').strip("'")
if not key:
    sys.exit("INSTANTLY_API_KEY not found in .env")

leads = []
for fname in FILES:
    with open(os.path.join(OUTDIR, fname), newline="", encoding="utf-8") as f:
        for r in csv.DictReader(f):
            leads.append({
                "email": r["email"].strip(),
                "first_name": r["first_name"].strip(),
                "last_name": r["last_name"].strip(),
                "company_name": r["company_name"].strip(),
                "personalization": "",
                "custom_variables": {
                    "competitor_1": r["Competitor-1"].strip(),
                    "competitor_2": r["Competitor-2"].strip(),
                    "job_title": r["job_title"].strip(),
                    "company_domain": r["company_domain"].strip(),
                    "fit_tier": r["fit_tier"].strip(),
                    "competitor_confidence": r["competitor_confidence"].strip(),
                    "source_list": "send" if fname == FILES[0] else "tier-c",
                },
            })

print(f"prepared {len(leads)} leads from {len(FILES)} files")

payload = {
    "campaign_id": CAMPAIGN_ID,
    "skip_if_in_campaign": True,
    "skip_if_in_workspace": False,
    "leads": leads,
}

req = urllib.request.Request(
    "https://api.instantly.ai/api/v2/leads/add",
    data=json.dumps(payload).encode(),
    headers={"Authorization": f"Bearer {key}", "Content-Type": "application/json"},
    method="POST")

try:
    with urllib.request.urlopen(req, timeout=120) as resp:
        print(f"HTTP {resp.status}")
        print(json.dumps(json.loads(resp.read().decode()), indent=1)[:1200])
except urllib.error.HTTPError as e:
    print(f"HTTP {e.code}")
    print(e.read().decode()[:1200])
    sys.exit(1)

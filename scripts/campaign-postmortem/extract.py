#!/usr/bin/env python3
"""
Pull everything needed for a campaign post-mortem out of Instantly v2.

  export $(grep -E '^INSTANTLY_API_KEY=' .env | xargs)
  python3 scripts/campaign-postmortem/extract.py --campaign-id=<uuid> --out=<workdir>

Writes into <workdir>: analytics.json, steps.json, daily.json, campaign.json,
leads.json, accounts_daily.json.

Read-only: only GETs, plus POST /leads/list which is a paginated read.
"""
import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

API = "https://api.instantly.ai/api/v2"
KEY = os.environ.get("INSTANTLY_API_KEY")
if not KEY:
    sys.exit("Missing INSTANTLY_API_KEY. Run: export $(grep -E '^INSTANTLY_API_KEY=' .env | xargs)")

# Instantly sits behind Cloudflare, which 403s (error 1010) on urllib's default
# User-Agent. Any ordinary UA string gets through.
HEADERS = {
    "Authorization": f"Bearer {KEY}",
    "Content-Type": "application/json",
    "User-Agent": "curl/8.7.1",
}


def call(path, params=None, body=None, method=None, attempt=0):
    url = f"{API}{path}"
    if params:
        url += "?" + urllib.parse.urlencode(params)
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, headers=HEADERS,
                                 method=method or ("POST" if data else "GET"))
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as e:
        # 429/5xx -> exponential backoff, per the repo's documented pattern
        if e.code in (429, 500, 502, 503, 504) and attempt < 5:
            time.sleep(2 ** attempt)
            return call(path, params, body, method, attempt + 1)
        sys.stderr.write(f"HTTP {e.code} on {path}: {e.read().decode()[:400]}\n")
        raise


def paginate_post(path, body, label):
    """Cursor pagination: {items, next_starting_after}."""
    out, cursor, page = [], None, 0
    while True:
        b = dict(body)
        if cursor:
            b["starting_after"] = cursor
        resp = call(path, body=b)
        items = resp.get("items", [])
        out.extend(items)
        page += 1
        sys.stderr.write(f"  {label}: page {page}, +{len(items)} (total {len(out)})\n")
        cursor = resp.get("next_starting_after")
        if not cursor or not items:
            break
        time.sleep(0.3)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--campaign-id", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--start-date", default="2026-08-25")
    ap.add_argument("--end-date", default="2026-09-03")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    cid = a.campaign_id

    def dump(name, obj):
        p = os.path.join(a.out, name)
        with open(p, "w") as f:
            json.dump(obj, f, indent=2)
        n = len(obj) if isinstance(obj, list) else "-"
        sys.stderr.write(f"wrote {p} ({n} records)\n")

    sys.stderr.write("A1 campaign analytics...\n")
    dump("analytics.json", call("/campaigns/analytics", {"id": cid}))
    dump("steps.json", call("/campaigns/analytics/steps", {"campaign_id": cid}))
    dump("daily.json", call("/campaigns/analytics/daily", {"campaign_id": cid}))
    dump("campaign.json", call(f"/campaigns/{cid}"))

    sys.stderr.write("A3 leads (paginated)...\n")
    leads = paginate_post("/leads/list", {"campaign": cid, "limit": 100}, "leads")
    dump("leads.json", leads)

    # A5: this workspace has ~120 inboxes, so a multi-day window 413s
    # ("Analytics request is too large"). Fetch one day at a time and stamp each row.
    sys.stderr.write("A5 per-inbox daily analytics (day by day)...\n")
    import datetime
    d0 = datetime.date.fromisoformat(a.start_date)
    d1 = datetime.date.fromisoformat(a.end_date)
    rows = []
    day = d0
    while day <= d1:
        ds = day.isoformat()
        try:
            resp = call("/accounts/analytics/daily", {"start_date": ds, "end_date": ds})
            got = resp if isinstance(resp, list) else resp.get("items", [])
            for r in got:
                r.setdefault("date", ds)
            rows.extend(got)
            sys.stderr.write(f"  {ds}: {len(got)} rows\n")
        except urllib.error.HTTPError as e:
            sys.stderr.write(f"  {ds}: skipped ({e.code})\n")
        day += datetime.timedelta(days=1)
        time.sleep(0.3)
    dump("accounts_daily.json", rows)


if __name__ == "__main__":
    main()

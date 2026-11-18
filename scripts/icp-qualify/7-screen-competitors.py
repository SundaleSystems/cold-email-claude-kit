#!/usr/bin/env python3
"""Pass A — deterministic screen of every researched competitor pair.

Fetches each competitor's homepage and scores it against the lead's cached
homepage text. Catches dead sites, non-travel companies, self-matches, and
wildly off-category picks (the "puppies.com" failure) at zero LLM cost.

Only pairs this screen flags get escalated to agents.
"""
import concurrent.futures as cf
import glob
import html
import json
import os
import re
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WORK = os.path.join(ROOT, "scripts", "icp-qualify", "work")
COMP = os.path.join(WORK, "competitors")
CACHE = os.path.join(COMP, "competitor-sites.json")
OUT = os.path.join(COMP, "screen.json")

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
WORKERS = 15
TIMEOUT = 20

OVERLAP_FAIL = 0.04     # absurd controls scored 0.000; real pairs 0.11+
OVERLAP_SOFT = 0.08

TRAVEL = re.compile(
    r"\b(tour|tours|cruise|cruises|hotel|hotels|resort|booking|book now|trip|trips|"
    r"travel|vacation|holiday|flight|flights|itinerar|excursion|adventure|safari|"
    r"charter|rental|rentals|expedition|destination|guided|sightseeing|lodging)\b", re.I)

STOP = set("""the a an and or of to for in on with your you our we is are it that this from by
at as be more all can get new best have has will your their its they them then than
about into out up down over under just like also only very can't don't we're you're""".split())


def strip_html(raw):
    raw = re.sub(r"(?is)<(script|style|noscript|svg|head)[^>]*>.*?</\1>", " ", raw)
    txt = html.unescape(re.sub(r"<[^>]+>", " ", raw))
    return re.sub(r"\s+", " ", txt).strip()


def toks(s):
    return set(w for w in re.findall(r"[a-z]{4,}", s.lower()) if w not in STOP)


def fetch(url):
    try:
        p = subprocess.run(
            ["curl", "-sL", "--max-time", str(TIMEOUT), "--compressed", "-A", UA,
             "-H", "Accept-Language: en-US,en;q=0.9", url],
            capture_output=True, timeout=TIMEOUT + 10)
        return strip_html(p.stdout.decode("utf-8", errors="replace"))
    except Exception:
        return ""


def blocked(t):
    return (len(t) < 400 or re.search(
        r"just a moment|enable javascript|access denied|attention required|"
        r"checking your browser|403 forbidden|domain (is )?for sale", t[:600], re.I) is not None)


def host(url):
    return re.sub(r"^www\.", "", re.sub(r"^https?://", "", (url or "")).split("/")[0]).lower()


def main():
    research = []
    for f in sorted(glob.glob(os.path.join(COMP, "comp-*-verdict.json"))):
        research += json.load(open(f, encoding="utf-8"))

    with open(os.path.join(WORK, "sites.json"), encoding="utf-8") as f:
        leadsites = json.load(f)

    urls = sorted({r[k] for r in research for k in ("competitor_1_url", "competitor_2_url") if r.get(k)})

    cache = {}
    if os.path.exists(CACHE) and "--force" not in sys.argv:
        cache = json.load(open(CACHE, encoding="utf-8"))
    todo = [u for u in urls if u not in cache]
    print(f"{len(urls)} competitor URLs | {len(todo)} to fetch | {len(cache)} cached")

    if todo:
        done = 0
        with cf.ThreadPoolExecutor(max_workers=WORKERS) as ex:
            futs = {ex.submit(fetch, u): u for u in todo}
            for fut in cf.as_completed(futs):
                u = futs[fut]
                try:
                    cache[u] = fut.result()
                except Exception:
                    cache[u] = ""
                done += 1
                if done % 30 == 0:
                    print(f"  ...{done}/{len(todo)}", flush=True)
                    json.dump(cache, open(CACHE, "w", encoding="utf-8"))
        json.dump(cache, open(CACHE, "w", encoding="utf-8"))

    results = []
    for r in research:
        lead = r["domain"]
        site = leadsites.get(lead, {})
        leadtext = " ".join(p["text"] for p in site.get("pages", []))
        lt = toks(leadtext) if leadtext else None

        pair = {"domain": lead, "slots": []}
        for n in (1, 2):
            name = r.get(f"Competitor-{n}", "")
            url = r.get(f"competitor_{n}_url", "")
            ctext = cache.get(url, "")
            flags = []

            if not url:
                flags.append("no_url")
            if blocked(ctext):
                flags.append("unreachable")
            elif not TRAVEL.search(ctext):
                flags.append("no_travel_vocab")

            if host(url) == lead:
                flags.append("self_match")
            if name.strip().lower() == (r.get("company_name", "") or "").strip().lower():
                flags.append("self_match")

            ov = None
            if lt and not blocked(ctext):
                ct = toks(ctext)
                ov = len(lt & ct) / max(1, len(lt | ct))
                if ov < OVERLAP_FAIL:
                    flags.append(f"low_overlap:{ov:.3f}")
                elif ov < OVERLAP_SOFT:
                    flags.append(f"soft_overlap:{ov:.3f}")
            elif not lt:
                flags.append("lead_site_unscored")

            pair["slots"].append({
                "n": n, "name": name, "url": url,
                "overlap": round(ov, 4) if ov is not None else None,
                "flags": flags, "status": "FLAG" if flags else "PASS",
            })

        c1 = r.get("Competitor-1", "").strip().lower()
        c2 = r.get("Competitor-2", "").strip().lower()
        if c1 and c1 == c2:
            for s in pair["slots"]:
                s["flags"].append("dup_in_row")
                s["status"] = "FLAG"

        pair["status"] = "FLAG" if any(s["status"] == "FLAG" for s in pair["slots"]) else "PASS"
        results.append(pair)

    json.dump(results, open(OUT, "w", encoding="utf-8"), indent=1)

    from collections import Counter
    slot_flags = Counter(f.split(":")[0] for p in results for s in p["slots"] for f in s["flags"])
    npass = sum(1 for p in results if p["status"] == "PASS")
    print(f"\npairs PASS {npass} | FLAG {len(results) - npass}  (of {len(results)})")
    slots = [s for p in results for s in p["slots"]]
    print(f"slots PASS {sum(1 for s in slots if s['status'] == 'PASS')} | "
          f"FLAG {sum(1 for s in slots if s['status'] == 'FLAG')}  (of {len(slots)})")
    print("\nflag reasons:")
    for k, v in slot_flags.most_common():
        print(f"  {k:22} {v}")
    print(f"\nwrote {OUT}")


if __name__ == "__main__":
    main()

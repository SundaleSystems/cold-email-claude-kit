#!/usr/bin/env python3
"""Step 2 — bulk-scrape candidate company websites into a cached JSON store.

Fetches each domain's homepage plus one best-effort deals/pricing page, strips to
plain text, and pre-extracts price / promo / booking / quote-only signals so the
qualification sub-agents have cheap deterministic evidence alongside the copy.

Results are cached per-domain, so re-runs only fetch what is missing or failed.
"""
import concurrent.futures as cf
import html
import json
import os
import re
import subprocess
import sys
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
WORK = os.path.join(ROOT, "scripts", "icp-qualify", "work")
CACHE = os.path.join(WORK, "sites.json")

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
WORKERS = 15
TIMEOUT = 25
MAX_CHARS = 4000

SECOND_PAGE = re.compile(
    r"(deals|specials|offers|sale|pricing|prices|cruises|tours|packages|vacations|"
    r"book|destinations|trips)", re.I)

SIG = {
    "price_listed": re.compile(r"(\$\s?[\d,]{3,}|\bfrom \$\s?\d|\bstarting at \$\s?\d|\bper person\b.{0,20}\$)", re.I),
    "promo": re.compile(r"(\bsale\b|save \$|\d+% off|\bdeal(s)?\b|promo code|last minute|price match|best price|lowest price|special offer)", re.I),
    "booking": re.compile(r"(book now|book online|add to cart|check availability|reserve now|search (flights|cruises|hotels|trips))", re.I),
    "quote_only": re.compile(r"(request a quote|inquire|tailor-?made|bespoke|custom itinerar|contact us for pricing|start planning|plan your trip with)", re.I),
    "b2b": re.compile(r"(platform for (agents|agencies|operators)|our api\b|white ?label|saas|for travel advisors|book a demo)", re.I),
}


def strip_html(raw):
    raw = re.sub(r"(?is)<(script|style|noscript|svg|head)[^>]*>.*?</\1>", " ", raw)
    txt = html.unescape(re.sub(r"<[^>]+>", " ", raw))
    return re.sub(r"\s+", " ", txt).strip()


def fetch(url):
    try:
        p = subprocess.run(
            ["curl", "-sL", "--max-time", str(TIMEOUT), "--compressed",
             "-A", UA, "-H", "Accept-Language: en-US,en;q=0.9", url],
            capture_output=True, timeout=TIMEOUT + 10)
        return p.stdout.decode("utf-8", errors="replace")
    except Exception:
        return ""


def pick_second_page(raw, domain):
    """Find one internal deals/tours/pricing link worth a second fetch."""
    best = None
    for m in re.finditer(r'<a[^>]+href=["\']([^"\'#]+)["\'][^>]*>(.{0,80}?)</a>', raw, re.I | re.S):
        href, text = m.group(1), strip_html(m.group(2))
        if not SECOND_PAGE.search(href) and not SECOND_PAGE.search(text):
            continue
        full = urllib.parse.urljoin(f"https://{domain}/", href)
        host = urllib.parse.urlparse(full).netloc.lower().replace("www.", "")
        if host != domain:
            continue
        if re.search(r"\.(jpg|png|pdf|zip|mp4|css|js)$", full, re.I):
            continue
        best = full
        # prefer an explicit deals/specials page if one shows up
        if re.search(r"(deals|specials|offers|sale|pricing)", full, re.I):
            return full
    return best


def signals(text):
    return {k: bool(rx.search(text)) for k, rx in SIG.items()}


def scrape(domain):
    raw = fetch(f"https://{domain}/")
    text = strip_html(raw)

    blocked = (len(text) < 400 or
               re.search(r"just a moment|enable javascript|access denied|"
                         r"attention required|checking your browser|403 forbidden",
                         text[:600], re.I) is not None)

    pages = []
    if not blocked:
        pages.append({"url": f"https://{domain}/", "text": text[:MAX_CHARS]})
        second = pick_second_page(raw, domain)
        if second:
            t2 = strip_html(fetch(second))
            if len(t2) > 400:
                pages.append({"url": second, "text": t2[:MAX_CHARS]})

    combined = " ".join(p["text"] for p in pages)
    return {
        "domain": domain,
        "status": "blocked" if blocked else ("ok" if combined else "empty"),
        "pages": pages,
        "chars": len(combined),
        "signals": signals(combined) if combined else {},
    }


def main():
    with open(os.path.join(WORK, "domains.txt"), encoding="utf-8") as f:
        domains = [d.strip() for d in f if d.strip()]

    cache = {}
    if os.path.exists(CACHE):
        with open(CACHE, encoding="utf-8") as f:
            cache = json.load(f)

    force = "--force" in sys.argv
    todo = [d for d in domains if force or d not in cache or cache[d].get("status") == "empty"]
    print(f"{len(domains)} domains | {len(todo)} to fetch | {len(cache)} cached")

    done = 0
    with cf.ThreadPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(scrape, d): d for d in todo}
        for fut in cf.as_completed(futs):
            d = futs[fut]
            try:
                cache[d] = fut.result()
            except Exception as e:
                cache[d] = {"domain": d, "status": "empty", "pages": [],
                            "chars": 0, "signals": {}, "error": str(e)}
            done += 1
            if done % 25 == 0:
                print(f"  ...{done}/{len(todo)}", flush=True)
                with open(CACHE, "w", encoding="utf-8") as f:
                    json.dump(cache, f)

    with open(CACHE, "w", encoding="utf-8") as f:
        json.dump(cache, f)

    from collections import Counter
    st = Counter(v["status"] for v in cache.values())
    print("status:", dict(st))
    print("median chars:", sorted(v["chars"] for v in cache.values())[len(cache) // 2])
    print(f"wrote {CACHE}")


if __name__ == "__main__":
    main()

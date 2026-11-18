#!/usr/bin/env python3
"""
Statistical post-mortem for a completed Instantly campaign.

  python3 scripts/campaign-postmortem/analyze.py --work=<workdir> [--classified=<path>]

Reads the artifacts written by extract.py (+ an optional classified-replies file)
and emits <work>/stats.json plus a readable markdown block on stdout.

Stdlib only. Every rate is reported with a Wilson 95% interval, and every
between-arm comparison is accompanied by the power it actually had.
"""
import argparse
import collections
import json
import math
import os
import random
import re

Z = 1.959963985  # two-sided 95%


# ---------- statistics ----------

def wilson(k, n, z=Z):
    """Wilson score interval — correct at small k, unlike the normal approximation."""
    if n == 0:
        return (0.0, 0.0, 0.0)
    p = k / n
    d = 1 + z * z / n
    centre = (p + z * z / (2 * n)) / d
    margin = z / d * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return (p, max(0.0, centre - margin), min(1.0, centre + margin))


def fmt_rate(k, n):
    p, lo, hi = wilson(k, n)
    return f"{k}/{n} = {p*100:.2f}% (95% CI {lo*100:.2f}–{hi*100:.2f}%)"


def chi2_stat(counts):
    """Pearson chi-square across arms of (successes, trials)."""
    tot_k = sum(k for k, _ in counts)
    tot_n = sum(n for _, n in counts)
    if tot_k == 0 or tot_n == 0:
        return 0.0
    p = tot_k / tot_n
    s = 0.0
    for k, n in counts:
        for obs, exp in ((k, n * p), (n - k, n * (1 - p))):
            if exp > 0:
                s += (obs - exp) ** 2 / exp
    return s


def permutation_p(counts, iters=50000, seed=17):
    """
    Monte-Carlo p-value for 'all arms share one true rate'.

    Chi-square's asymptotic p-value is invalid here (expected successes per arm < 5),
    so we shuffle the observed successes across arms instead. This asks the honest
    question: if every variant were identical, how often would we see a spread at
    least this extreme purely by chance?
    """
    rng = random.Random(seed)
    obs = chi2_stat(counts)
    tot_k = sum(k for k, _ in counts)
    sizes = [n for _, n in counts]
    slots = []
    for i, n in enumerate(sizes):
        slots.extend([i] * n)
    hits = 0
    for _ in range(iters):
        drawn = collections.Counter(rng.sample(slots, tot_k))
        sim = [(drawn.get(i, 0), sizes[i]) for i in range(len(sizes))]
        if chi2_stat(sim) >= obs - 1e-12:
            hits += 1
    return obs, (hits + 1) / (iters + 1)


def n_per_arm(p1, p2, power=0.80, alpha=0.05):
    """Two-proportion sample size per arm (normal approximation)."""
    if p1 <= 0 or p2 <= p1:
        return None
    za = {0.05: 1.959963985, 0.10: 1.644853627}[alpha]
    zb = {0.80: 0.8416212336, 0.90: 1.281551566}[power]
    pbar = (p1 + p2) / 2
    a = za * math.sqrt(2 * pbar * (1 - pbar))
    b = zb * math.sqrt(p1 * (1 - p1) + p2 * (1 - p2))
    return math.ceil((a + b) ** 2 / (p2 - p1) ** 2)


def mde(p1, n, power=0.80, alpha=0.05):
    """Smallest detectable p2 > p1 at the given per-arm n (bisection)."""
    lo, hi = p1, 1.0
    for _ in range(80):
        mid = (lo + hi) / 2
        need = n_per_arm(p1, mid, power, alpha)
        if need is None or need > n:
            lo = mid
        else:
            hi = mid
    return hi


# ---------- helpers ----------

def sending_domain(addr):
    return addr.split("@", 1)[1].lower() if addr and "@" in addr else "(unknown)"


def norm_title(t):
    t = (t or "").lower()
    for pat, lab in [
        (r"\b(ceo|chief executive)\b", "CEO"),
        (r"\bfounder\b|\bco-?founder\b", "Founder"),
        (r"\bowner\b", "Owner"),
        (r"\bpresident\b", "President"),
        (r"\bprincipal\b", "Principal"),
        (r"\bpartner\b", "Partner"),
        (r"\bmanaging director\b|\bmd\b", "Managing Director"),
        (r"\b(vp|vice president)\b", "VP"),
        (r"\bdirector\b", "Director"),
        (r"\b(broker|realtor|real estate agent|salesperson)\b", "Broker/Agent"),
        (r"\bmanager\b", "Manager"),
    ]:
        if re.search(pat, t):
            return lab
    return "Other"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--work", required=True)
    ap.add_argument("--classified", default=None)
    a = ap.parse_args()
    W = a.work
    J = lambda n: json.load(open(os.path.join(W, n)))

    leads = J("leads.json")
    steps = J("steps.json")
    analytics = J("analytics.json")
    replies = J("replies.json")
    agg = analytics[0] if isinstance(analytics, list) else analytics

    # A lead's email_reply_count is incremented by auto-replies too, so it cannot
    # stand in for "a human answered". replies.json (email_type=received) holds the
    # 21 genuine replies; everything else with a reply count is an autoresponder.
    # That split is useful in itself: an OOO proves the mail reached a live, monitored
    # mailbox, which is the only delivery signal available with open tracking off.
    human = {(r.get("email") or "").lower() for r in replies}
    is_human = lambda l: (l.get("email") or "").lower() in human
    is_auto = lambda l: l.get("email_reply_count", 0) > 0 and not is_human(l)

    out, P = {}, print

    # ---------- C1: headline rates ----------
    contacted = agg["contacted_count"]
    sent = agg["emails_sent_count"]
    uniq_replies = agg["reply_count_unique"]
    bounced = agg["bounced_count"]

    P("## C1 — Headline rates\n")
    P(f"- Leads: {agg['leads_count']}, contacted: {contacted}, emails sent: {sent}")
    P(f"- Unique human replies (per lead): {fmt_rate(uniq_replies, contacted)}")
    P(f"- Automatic replies (OOO etc.): {agg['reply_count_automatic_unique']}")
    P(f"- Bounces: {fmt_rate(bounced, contacted)}")
    p_r, lo_r, hi_r = wilson(uniq_replies, contacted)
    out["headline"] = {
        "contacted": contacted, "emails_sent": sent,
        "unique_replies": uniq_replies, "reply_rate": p_r,
        "reply_rate_ci": [lo_r, hi_r],
        "bounced": bounced, "bounce_rate": bounced / contacted,
        "auto_replies": agg["reply_count_automatic_unique"],
    }
    P(f"\n  The 1% rule (skills/experiment-design): a reply rate below 1% after 200+ sends")
    P(f"  means deliverability must be ruled out before trusting copy or list conclusions.")
    P(f"  Observed {p_r*100:.2f}%. Upper CI bound {hi_r*100:.2f}% — "
      f"{'the campaign is not distinguishable from the 1% line' if hi_r >= 0.01 else 'BELOW the line with confidence'}.\n")

    # ---------- classified replies ----------
    if a.classified and os.path.exists(a.classified):
        cls = json.load(open(a.classified))
        buckets = collections.Counter(c["label"] for c in cls)
        POS = ("positive_interested", "positive_soft", "positive_referral")
        pos = sum(buckets.get(b, 0) for b in POS)
        excl = buckets.get("ooo", 0) + buckets.get("bounce", 0)
        net = len(cls) - excl
        P("## C1b — Reply quality (the north-star metric)\n")
        for b, c in buckets.most_common():
            P(f"  {b:22} {c:3}  ({c/len(cls)*100:.0f}% of replies)")
        P(f"\n- Positive replies: {pos}")
        P(f"- Positive reply rate (per lead): {fmt_rate(pos, contacted)}")
        P(f"- Positive reply rate (per email): {fmt_rate(pos, sent)}")
        P(f"- Positive share of replies: {pos}/{net} = {pos/net*100:.0f}%")
        unsub = buckets.get("unsubscribe", 0)
        P(f"- Opt-out requests: {fmt_rate(unsub, contacted)} "
          f"— {unsub}/{net} = {unsub/net*100:.0f}% of all replies")
        pp, plo, phi = wilson(pos, contacted)
        out["quality"] = {
            "buckets": dict(buckets), "positive": pos,
            "positive_reply_rate_per_lead": pp, "positive_rate_ci": [plo, phi],
            "positive_share_of_replies": pos / net if net else 0,
            "unsubscribe_requests": unsub,
            "unsubscribe_rate": unsub / contacted,
        }
        P(f"\n  Benchmark (skills/positive-reply-scoring): >=1% good, >=2% great.")
        P(f"  Observed {pp*100:.3f}% — roughly {0.01/pp:.0f}x below the 'good' line.\n")

    # ---------- C2: the 7-arm copy test ----------
    P("## C2 — Was the 7-variant copy test resolvable?\n")
    arms = {}
    for s in steps:
        if s.get("step") is None:
            continue
        arms[(int(s["step"]), int(s["variant"]))] = {
            "sent": s["sent"], "replies": s["unique_replies"],
            "auto": s["unique_replies_automatic"],
        }
    step0 = {v: d for (st, v), d in arms.items() if st == 0}
    step1 = {v: d for (st, v), d in arms.items() if st == 1}

    P("| variant | sent | unique replies | rate | 95% CI |")
    P("|---|---|---|---|---|")
    for v in sorted(step0):
        d = step0[v]
        p, lo, hi = wilson(d["replies"], d["sent"])
        P(f"| step0 v{v} | {d['sent']} | {d['replies']} | {p*100:.2f}% | {lo*100:.2f}–{hi*100:.2f}% |")

    counts = [(d["replies"], d["sent"]) for _, d in sorted(step0.items())]
    x2, pval = permutation_p(counts)
    k0 = sum(k for k, _ in counts)
    n0 = sum(n for _, n in counts)
    base0 = k0 / n0
    per_arm = n0 // len(counts)
    det = mde(base0, per_arm)
    P(f"\n- Pooled step-0 reply rate: {fmt_rate(k0, n0)}")
    P(f"- Permutation test across the {len(counts)} arms: chi2={x2:.2f}, p={pval:.3f}")
    P(f"  -> {'NO significant difference' if pval > 0.05 else 'significant difference'} "
      f"between variants.")
    P(f"- At n={per_arm}/arm and a {base0*100:.2f}% baseline, the smallest lift detectable")
    P(f"  at 80% power is {det*100:.2f}% — a {det/base0:.1f}x improvement.")
    P(f"- Sends/arm actually needed to detect a 2x lift: {n_per_arm(base0, base0*2)}")
    P(f"  (had: {per_arm} — short by {n_per_arm(base0, base0*2) - per_arm})")
    out["step0_arms"] = {
        "arms": {f"v{v}": step0[v] for v in sorted(step0)},
        "pooled_rate": base0, "chi2": x2, "permutation_p": pval,
        "n_per_arm": per_arm, "mde_absolute": det, "mde_ratio": det / base0,
        "n_needed_for_2x": n_per_arm(base0, base0 * 2),
    }

    # ---------- C3: does the follow-up earn its place ----------
    P("\n## C3 — Marginal value of step 1 (the follow-up)\n")
    k1 = sum(d["replies"] for d in step1.values())
    n1 = sum(d["sent"] for d in step1.values())
    P(f"- Step 0 (opener):    {fmt_rate(k0, n0)}")
    P(f"- Step 1 (follow-up): {fmt_rate(k1, n1)}")
    P(f"- Step 1 contributed {k1}/{k0+k1} = {k1/(k0+k1)*100:.0f}% of all human replies")
    _, p_step = permutation_p([(k0, n0), (k1, n1)])
    P(f"- Permutation test step0 vs step1: p={p_step:.3f} -> "
      f"{'no detectable difference' if p_step > 0.05 else 'differ'}")
    P("\n  Read: a 5-word follow-up performs on par with a fully written opener.")
    P("  This is the highest-powered comparison in the dataset (n>2,000 per side).")
    for v in sorted(step1):
        d = step1[v]
        P(f"  - step1 v{v}: {fmt_rate(d['replies'], d['sent'])}")
    out["step_comparison"] = {
        "step0": {"replies": k0, "sent": n0, "rate": k0 / n0},
        "step1": {"replies": k1, "sent": n1, "rate": k1 / n1},
        "step1_share_of_replies": k1 / (k0 + k1),
        "permutation_p": p_step,
        "step1_arms": {f"v{v}": step1[v] for v in sorted(step1)},
    }

    # ---------- C4: is failure concentrated in inboxes/domains? ----------
    P("\n## C4 — Is the shortfall concentrated in particular inboxes or domains?\n")
    per_inbox = collections.defaultdict(lambda: {"sent": 0, "bounce": 0, "reply": 0, "auto": 0})
    for l in leads:
        frm = ((l.get("status_summary") or {}).get("lastStep") or {}).get("from")
        if not frm:
            continue
        r = per_inbox[frm]
        r["sent"] += 1
        if l.get("status") == -1:
            r["bounce"] += 1
        if is_human(l):
            r["reply"] += 1
        if is_auto(l):
            r["auto"] += 1
    P(f"- Sending inboxes used: {len(per_inbox)}")
    bc = [(v["bounce"], v["sent"]) for v in per_inbox.values()]
    x2b, pb = permutation_p(bc, iters=20000)
    P(f"- Bounces across inboxes: chi2={x2b:.1f}, p={pb:.3f} -> "
      f"{'evenly spread (fleet-wide, not a bad-inbox problem)' if pb > 0.05 else 'CONCENTRATED in a subset'}")
    worst = sorted(per_inbox.items(), key=lambda kv: -kv[1]["bounce"])[:5]
    P("- Highest-bounce inboxes: " + ", ".join(
        f"{e.split('@')[0]}@{sending_domain(e)} {v['bounce']}/{v['sent']}" for e, v in worst))
    per_dom = collections.defaultdict(lambda: {"sent": 0, "bounce": 0, "reply": 0, "auto": 0})
    for e, v in per_inbox.items():
        d = per_dom[sending_domain(e)]
        for k in ("sent", "bounce", "reply", "auto"):
            d[k] += v[k]
    P(f"- Sending domains: {len(per_dom)}")

    # Auto-reply rate is the cleanest delivery proxy available (open tracking was off):
    # an OOO can only fire from a live mailbox that actually received the message.
    auto_tot = sum(v["auto"] for v in per_dom.values())
    sent_tot = sum(v["sent"] for v in per_dom.values())
    P(f"- Autoresponder rate (delivery proxy): {fmt_rate(auto_tot, sent_tot)}")
    ac = [(v["auto"], v["sent"]) for v in per_dom.values()]
    x2a, pa = permutation_p(ac, iters=20000)
    P(f"  spread across the {len(per_dom)} sending domains: chi2={x2a:.1f}, p={pa:.3f} -> "
      f"{'even — no domain is being silently filtered' if pa > 0.05 else 'UNEVEN — some domains deliver worse'}")
    dl = sorted(per_dom.items(), key=lambda kv: -kv[1]["auto"] / max(1, kv[1]["sent"]))
    P("  best delivery:  " + ", ".join(f"{d} {v['auto']}/{v['sent']}" for d, v in dl[:3]))
    P("  worst delivery: " + ", ".join(f"{d} {v['auto']}/{v['sent']}" for d, v in dl[-3:]))
    out["inboxes"] = {
        "count": len(per_inbox), "domains": len(per_dom),
        "bounce_permutation_p": pb,
        "auto_reply_rate": auto_tot / sent_tot,
        "auto_permutation_p": pa,
        "per_domain": {d: v for d, v in sorted(per_dom.items())},
    }

    # ---------- C5: is the reply window actually closed? ----------
    P("\n## C5 — Reply-lag curve (is the reply window closed?)\n")
    import datetime
    def ts(s):
        return datetime.datetime.fromisoformat(s.replace("Z", "+00:00")) if s else None
    # timestamp_last_contact is bumped when the reply lands, so it cannot be the
    # send time. status_summary.lastStep.timestamp_executed is the actual send.
    lags = []
    byem = {(l.get("email") or "").lower(): l for l in leads}
    for r in replies:
        l = byem.get((r.get("email") or "").lower())
        if not l:
            continue
        step = (l.get("status_summary") or {}).get("lastStep") or {}
        t_reply, t_send = ts(r.get("reply_time")), ts(step.get("timestamp_executed"))
        if t_reply and t_send:
            lags.append((t_reply - t_send).total_seconds() / 3600)
    lags = [x for x in lags if x > -1]
    if lags:
        lags.sort()
        P(f"- n={len(lags)} replies with a measurable lag from last contact")
        for q in (0.5, 0.75, 0.9, 1.0):
            P(f"  p{int(q*100)}: {lags[min(len(lags)-1, int(q*(len(lags)-1)))]:.1f} h")
        within24 = sum(1 for x in lags if x <= 24)
        P(f"- {within24}/{len(lags)} = {within24/len(lags)*100:.0f}% arrived within 24h of the last touch")
    # how much of the send volume is still "fresh"
    last_touch = [ts(l.get("timestamp_last_touch")) for l in leads if l.get("timestamp_last_touch")]
    if last_touch:
        newest = max(last_touch)
        fresh = sum(1 for t in last_touch if (newest - t).total_seconds() < 24 * 3600)
        P(f"- Leads last touched within 24h of the final send: {fresh} "
          f"({fresh/len(last_touch)*100:.0f}% of the list)")
        out["reply_lag"] = {
            "n": len(lags),
            "median_h": lags[len(lags)//2] if lags else None,
            "pct_within_24h": (sum(1 for x in lags if x <= 24)/len(lags)) if lags else None,
            "leads_touched_in_final_24h": fresh,
            "share_touched_in_final_24h": fresh/len(last_touch),
        }

    # ---------- C6: descriptive segments (UNDER-POWERED) ----------
    P("\n## C6 — Segments (DESCRIPTIVE ONLY — under-powered, never a decision basis)\n")
    def seg(name, keyfn, minimum=60):
        tab = collections.defaultdict(lambda: {"n": 0, "reply": 0, "auto": 0, "bounce": 0})
        for l in leads:
            k = keyfn(l)
            t = tab[k]
            t["n"] += 1
            if is_human(l):
                t["reply"] += 1
            if is_auto(l):
                t["auto"] += 1
            if l.get("status") == -1:
                t["bounce"] += 1
        rows = [(k, v) for k, v in tab.items() if v["n"] >= minimum]
        rows.sort(key=lambda kv: -kv[1]["n"])
        P(f"\n### by {name}")
        P("| segment | leads | human replies | reply rate | 95% CI | auto (delivery) | bounce |")
        P("|---|---|---|---|---|---|---|")
        for k, v in rows[:12]:
            p, lo, hi = wilson(v["reply"], v["n"])
            P(f"| {k} | {v['n']} | {v['reply']} | {p*100:.2f}% | {lo*100:.2f}–{hi*100:.2f}% "
              f"| {v['auto']/v['n']*100:.1f}% | {v['bounce']/v['n']*100:.1f}% |")
        return {k: v for k, v in rows}

    pay = lambda l: (l.get("payload") or {})
    out["seg_industry"] = seg("industry", lambda l: pay(l).get("linkedin_industry") or "(none)")
    out["seg_title"] = seg("title bucket", lambda l: norm_title(pay(l).get("jobTitle")))
    out["seg_state"] = seg("location", lambda l: (pay(l).get("location") or "?").split(",")[-2].strip()
                           if (pay(l).get("location") or "").count(",") >= 2 else (pay(l).get("location") or "?"))
    ESP = {1: "Google", 2: "Microsoft", 3: "Zoho", 4: "Yahoo", 9: "other", 999: "unknown/catch-all", 1000: "other"}
    out["seg_esp"] = seg("recipient mail provider",
                         lambda l: ESP.get(l.get("esp_code"), str(l.get("esp_code"))), minimum=1)

    # ICP drift: how much of the list was actually the stated target?
    ind = collections.Counter(pay(l).get("linkedin_industry") or "(none)" for l in leads)
    re_like = sum(c for k, c in ind.items() if "real estate" in k.lower())
    P(f"\n- Industry drift: {re_like}/{len(leads)} = {re_like/len(leads)*100:.0f}% of the list "
      f"is a real-estate industry; {100-re_like/len(leads)*100:.0f}% is off-target.")
    out["icp_drift"] = {"real_estate_like": re_like, "total": len(leads),
                        "on_target_share": re_like / len(leads)}

    json.dump(out, open(os.path.join(W, "stats.json"), "w"), indent=2, default=str)
    P(f"\n\nWrote {os.path.join(W, 'stats.json')}")


if __name__ == "__main__":
    main()

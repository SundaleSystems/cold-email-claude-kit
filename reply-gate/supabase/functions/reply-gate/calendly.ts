// Calendly: supply real free slots so the reply can propose two
// genuine times instead of a booking link and a shrug.
// Non-fatal: if anything here fails, the reply degrades to asking for
// their availability, and the failure is noted in Slack.
import { config } from "./config.ts";
import type { CalendarSlots } from "./types.ts";

const API = "https://api.calendly.com";

async function calendlyFetch(path: string): Promise<any> {
  const res = await fetch(`${API}${path}`, {
    headers: { Authorization: `Bearer ${config.calendlyApiKey}` },
  });
  if (!res.ok) throw new Error(`calendly GET ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function getTwoFreeSlots(timezone: string): Promise<CalendarSlots> {
  if (!config.calendlyApiKey) {
    return { ok: false, slots: [], error: "CALENDLY_API_KEY not set" };
  }
  try {
    const me = await calendlyFetch(`/users/me`);
    const userUri = me.resource.uri;

    const types = await calendlyFetch(`/event_types?user=${encodeURIComponent(userUri)}&active=true&count=50`);
    let eventType = (types.collection ?? [])[0];
    if (config.calendlyEventTypeSlug) {
      eventType = (types.collection ?? []).find((t: any) => t.slug === config.calendlyEventTypeSlug) ?? eventType;
    }
    if (!eventType) return { ok: false, slots: [], error: "No active Calendly event type found" };

    // Look from tomorrow, 6 days out (the API caps ranges at 7 days).
    const start = new Date();
    start.setDate(start.getDate() + 1);
    start.setHours(0, 0, 0, 0);
    const end = new Date(start);
    end.setDate(end.getDate() + 6);

    const qs = new URLSearchParams({
      event_type: eventType.uri,
      start_time: start.toISOString(),
      end_time: end.toISOString(),
    });
    const avail = await calendlyFetch(`/event_type_available_times?${qs}`);
    const times: string[] = (avail.collection ?? [])
      .filter((s: any) => s.status === "available")
      .map((s: any) => s.start_time);

    if (times.length === 0) {
      return { ok: false, slots: [], schedulingUrl: eventType.scheduling_url, error: "No free slots in the next 6 days" };
    }

    // Two slots on two different days, preferring late morning / mid afternoon.
    const picked = pickTwoOnDifferentDays(times, timezone);
    return {
      ok: true,
      slots: picked.map((iso) => formatSlot(iso, timezone)),
      schedulingUrl: eventType.scheduling_url,
    };
  } catch (e) {
    return { ok: false, slots: [], error: String(e) };
  }
}

function pickTwoOnDifferentDays(isoTimes: string[], timezone: string): string[] {
  const byDay = new Map<string, string[]>();
  for (const iso of isoTimes) {
    const day = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, dateStyle: "short" }).format(new Date(iso));
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day)!.push(iso);
  }
  const preferred = (slots: string[]) => {
    const score = (iso: string) => {
      const h = parseInt(
        new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", hour12: false }).format(new Date(iso)),
        10,
      );
      // late morning (10-11) and mid afternoon (14-15) read most human
      if (h === 10 || h === 11) return 0;
      if (h === 14 || h === 15) return 1;
      return 2 + Math.abs(12 - h);
    };
    return [...slots].sort((a, b) => score(a) - score(b))[0];
  };
  const days = [...byDay.keys()].sort();
  const picks: string[] = [];
  for (const day of days) {
    picks.push(preferred(byDay.get(day)!));
    if (picks.length === 2) break;
  }
  return picks;
}

function formatSlot(iso: string, timezone: string): string {
  const d = new Date(iso);
  const day = new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long", month: "long", day: "numeric" }).format(d);
  const time = new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit", hour12: true }).format(d);
  const tzName = new Intl.DateTimeFormat("en-US", { timeZone: timezone, timeZoneName: "short" })
    .formatToParts(d).find((p) => p.type === "timeZoneName")?.value ?? "";
  return `${day} at ${time}${tzName ? ` ${tzName}` : ""}`;
}

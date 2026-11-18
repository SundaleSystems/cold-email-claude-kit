// Turn Sales Navigator free-text location ("Los Angeles Metropolitan
// Area", "Austin, Texas", "TX") into a city + 2-letter state so the
// people-search actors have something to search on. Ported from the
// n8n "Build Search Keys" node's parseLocation().

const STATES: Record<string, string> = {
  "alabama": "AL", "alaska": "AK", "arizona": "AZ", "arkansas": "AR", "california": "CA",
  "colorado": "CO", "connecticut": "CT", "delaware": "DE", "florida": "FL", "georgia": "GA",
  "hawaii": "HI", "idaho": "ID", "illinois": "IL", "indiana": "IN", "iowa": "IA",
  "kansas": "KS", "kentucky": "KY", "louisiana": "LA", "maine": "ME", "maryland": "MD",
  "massachusetts": "MA", "michigan": "MI", "minnesota": "MN", "mississippi": "MS", "missouri": "MO",
  "montana": "MT", "nebraska": "NE", "nevada": "NV", "new hampshire": "NH", "new jersey": "NJ",
  "new mexico": "NM", "new york": "NY", "north carolina": "NC", "north dakota": "ND", "ohio": "OH",
  "oklahoma": "OK", "oregon": "OR", "pennsylvania": "PA", "rhode island": "RI", "south carolina": "SC",
  "south dakota": "SD", "tennessee": "TN", "texas": "TX", "utah": "UT", "vermont": "VT",
  "virginia": "VA", "washington": "WA", "west virginia": "WV", "wisconsin": "WI", "wyoming": "WY",
  "district of columbia": "DC", "washington dc": "DC", "washington d.c.": "DC",
};

const ABBREVS = new Set(Object.values(STATES));

const METROS: Record<string, [string, string]> = {
  "san francisco bay": ["San Francisco", "CA"], "greater boston": ["Boston", "MA"],
  "greater new york city": ["New York", "NY"], "new york city metropolitan": ["New York", "NY"],
  "greater chicago": ["Chicago", "IL"], "greater seattle": ["Seattle", "WA"],
  "greater los angeles": ["Los Angeles", "CA"], "los angeles metropolitan": ["Los Angeles", "CA"],
  "dallas-fort worth metroplex": ["Dallas", "TX"], "greater houston": ["Houston", "TX"],
  "greater philadelphia": ["Philadelphia", "PA"], "atlanta metropolitan": ["Atlanta", "GA"],
  "greater atlanta": ["Atlanta", "GA"], "miami-fort lauderdale": ["Miami", "FL"],
  "greater miami": ["Miami", "FL"], "greater denver": ["Denver", "CO"],
  "denver metropolitan": ["Denver", "CO"], "greater phoenix": ["Phoenix", "AZ"],
  "phoenix metropolitan": ["Phoenix", "AZ"], "greater minneapolis-st. paul": ["Minneapolis", "MN"],
  "greater san diego": ["San Diego", "CA"], "san diego metropolitan": ["San Diego", "CA"],
  "greater austin": ["Austin", "TX"], "austin metropolitan": ["Austin", "TX"],
  "washington dc-baltimore": ["Washington", "DC"], "greater washington": ["Washington", "DC"],
  "greater nashville": ["Nashville", "TN"], "nashville metropolitan": ["Nashville", "TN"],
  "greater tampa bay": ["Tampa", "FL"], "tampa bay": ["Tampa", "FL"],
  "greater orlando": ["Orlando", "FL"], "greater st. louis": ["St. Louis", "MO"],
  "greater detroit": ["Detroit", "MI"], "detroit metropolitan": ["Detroit", "MI"],
  "greater pittsburgh": ["Pittsburgh", "PA"], "greater charlotte": ["Charlotte", "NC"],
  "charlotte metro": ["Charlotte", "NC"], "greater raleigh": ["Raleigh", "NC"],
  "raleigh-durham": ["Raleigh", "NC"], "greater portland": ["Portland", "OR"],
  "portland metropolitan": ["Portland", "OR"], "salt lake city metropolitan": ["Salt Lake City", "UT"],
  "greater salt lake city": ["Salt Lake City", "UT"], "las vegas metropolitan": ["Las Vegas", "NV"],
  "greater las vegas": ["Las Vegas", "NV"], "greater indianapolis": ["Indianapolis", "IN"],
  "greater columbus": ["Columbus", "OH"], "columbus, ohio metropolitan": ["Columbus", "OH"],
  "greater cleveland": ["Cleveland", "OH"], "cincinnati metropolitan": ["Cincinnati", "OH"],
  "greater cincinnati": ["Cincinnati", "OH"], "kansas city metropolitan": ["Kansas City", "MO"],
  "greater kansas city": ["Kansas City", "MO"], "greater sacramento": ["Sacramento", "CA"],
  "sacramento metropolitan": ["Sacramento", "CA"], "greater milwaukee": ["Milwaukee", "WI"],
  "greater jacksonville": ["Jacksonville", "FL"], "greater san antonio": ["San Antonio", "TX"],
  "san antonio metropolitan": ["San Antonio", "TX"], "oklahoma city metropolitan": ["Oklahoma City", "OK"],
  "greater richmond": ["Richmond", "VA"], "richmond metropolitan": ["Richmond", "VA"],
  "greater hartford": ["Hartford", "CT"], "greater new orleans": ["New Orleans", "LA"],
  "greater memphis": ["Memphis", "TN"], "louisville metropolitan": ["Louisville", "KY"],
  "greater louisville": ["Louisville", "KY"], "greater buffalo": ["Buffalo", "NY"],
  "buffalo-niagara falls": ["Buffalo", "NY"], "omaha metropolitan": ["Omaha", "NE"],
  "greater omaha": ["Omaha", "NE"], "greater tucson": ["Tucson", "AZ"],
  "greater albuquerque": ["Albuquerque", "NM"], "greater boise": ["Boise", "ID"],
  "boise metropolitan": ["Boise", "ID"],
};

export function parseLocation(loc: string): { city: string | null; state: string | null } {
  if (!loc || typeof loc !== "string") return { city: null, state: null };
  const raw = loc.trim().replace(/,?\s*(united states|usa|u\.s\.a?\.?)$/i, "").trim();
  if (!raw) return { city: null, state: null };
  const lower = raw.toLowerCase();

  // Metro-area phrasing ("San Francisco Bay Area", "Greater Boston Area")
  const metroKey = lower.replace(/\s*area$/, "").replace(/\s*region$/, "").trim();
  for (const [k, v] of Object.entries(METROS)) {
    if (metroKey.includes(k)) return { city: v[0], state: v[1] };
  }

  const parts = raw.split(",").map((p) => p.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const city = parts[0];
    const stRaw = parts[1];
    const stLower = stRaw.toLowerCase();
    if (STATES[stLower]) return { city, state: STATES[stLower] };
    const ab = stRaw.replace(/\./g, "").toUpperCase();
    if (ABBREVS.has(ab)) return { city, state: ab };
    return { city, state: null };
  }
  // Single token: maybe it's just a state
  if (STATES[lower]) return { city: null, state: STATES[lower] };
  const ab1 = raw.replace(/\./g, "").toUpperCase();
  if (ABBREVS.has(ab1)) return { city: null, state: ab1 };
  return { city: raw, state: null };
}

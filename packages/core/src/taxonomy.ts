/**
 * The taxonomy of the kinds. A kind code is dotted, for example `met.flood.flash`. Its first part is a
 * category of the system. The taxonomy is a tree: the parent of each code is also a code, so
 * `met.flood` is the parent of `met.flood.flash`. Each category is a root.
 *
 * The taxonomy is closed. Each code that a map function gives must be in it, and a gate test of each
 * adapter holds this rule. A code with a typo does not match the life-safety class, so it can stop a
 * wake. A new adapter adds its new codes here, in its pull request.
 */
import { COVERAGE_KIND, HEALTH_KIND } from "./assess.ts";
import type { Category, HealthState } from "./contracts.ts";

/** The plain name of each category of the system. Each category is also the root code of a tree. */
export const CATEGORY_LABELS: Readonly<Record<Category, string>> = {
  geo: "Geophysical",
  met: "Weather",
  safety: "Public safety",
  security: "Security",
  rescue: "Rescue",
  fire: "Fire",
  health: "Health",
  env: "Environment",
  transport: "Transport",
  infra: "Infrastructure",
  cbrne: "Chemical, biological, radiological and nuclear",
  other: "Other",
  cyber: "Cyber",
  market: "Markets",
  civic: "Civic",
  system: "The alert system",
};

/** The categories of the system: the 12 categories of CAP 1.2 first, then the categories that CAP does not have. */
export const CATEGORIES: readonly Category[] = Object.keys(CATEGORY_LABELS) as Category[];

/** This function gives the category of a kind code: its first part. A first part that is not a category gives `other`. */
export function categoryOf(kindCode: string): Category {
  const first = kindCode.split(".", 1)[0] ?? "";
  return Object.hasOwn(CATEGORY_LABELS, first) ? (first as Category) : "other";
}

/** The code of a kind that the tables of an adapter do not know. */
export const UNKNOWN_KIND = "other.unknown";

/** The health kinds of the core: one for each health state, and `late` for the lateness against another source. */
const HEALTH_LABELS: Readonly<Record<HealthState | "late", string>> = {
  unknown: "Health of a source not known",
  healthy: "Healthy source",
  slow: "Slow source",
  failing: "Failing source",
  silent: "Silent source",
  changed: "Changed format of a source",
  late: "Late source",
};

/**
 * The codes of the taxonomy and their plain names. The NWS and SAME codes of `format-nws` come first.
 * The kinds of the core come last. The coverage codes `system.coverage.<code>` are a family:
 * `knownKind` finds them.
 */
export const TAXONOMY: Readonly<Record<string, string>> = {
  ...CATEGORY_LABELS,

  "geo.avalanche": "Avalanche",
  "geo.debris-flow": "Debris flow",
  "geo.earthquake": "Earthquake",
  "geo.tsunami": "Tsunami",
  "geo.volcano": "Volcano",
  "geo.volcano.ashfall": "Ashfall",
  "geo.volcano.ashfall-marine": "Ashfall at sea",
  "geo.volcano.eruption": "Volcanic eruption",

  "met.beach-hazards": "Beach hazards",
  "met.blowing-dust": "Blowing dust",
  "met.cold": "Cold",
  "met.cold.extreme": "Extreme cold",
  "met.cold.wind-chill": "Wind chill",
  "met.dust-storm": "Dust storm",
  "met.flood": "Flood",
  "met.flood.areal": "Areal flood",
  "met.flood.coastal": "Coastal flood",
  "met.flood.flash": "Flash flood",
  "met.flood.hydrologic": "Hydrologic conditions",
  "met.flood.lakeshore": "Lakeshore flood",
  "met.flood.river": "River flood",
  "met.fog": "Dense fog",
  "met.fog.freezing": "Freezing fog",
  "met.freeze": "Freeze",
  "met.freeze.hard": "Hard freeze",
  "met.frost": "Frost",
  "met.heat": "Heat",
  "met.heat.extreme": "Extreme heat",
  "met.marine": "Marine weather",
  "met.marine.brisk-wind": "Brisk wind at sea",
  "met.marine.fog": "Dense fog at sea",
  "met.marine.freezing-spray": "Freezing spray",
  "met.marine.freezing-spray.heavy": "Heavy freezing spray",
  "met.marine.gale": "Gale",
  "met.marine.hazardous-seas": "Hazardous seas",
  "met.marine.hurricane-force-wind": "Hurricane-force wind at sea",
  "met.marine.low-water": "Low water",
  "met.marine.small-craft": "Small craft",
  "met.marine.small-craft.rough-bar": "Small craft at a rough bar",
  "met.marine.small-craft.seas": "Small craft in hazardous seas",
  "met.marine.small-craft.wind": "Small craft in wind",
  "met.marine.special": "Special marine weather",
  "met.marine.storm": "Storm at sea",
  "met.outlook": "Hazardous weather outlook",
  "met.rip-current": "Rip current",
  "met.severe-weather": "Severe weather",
  "met.special": "Special weather",
  "met.surf": "High surf",
  "met.surge": "Storm surge",
  "met.thunderstorm": "Thunderstorm",
  "met.thunderstorm.severe": "Severe thunderstorm",
  "met.tornado": "Tornado",
  "met.tropical": "Tropical cyclone",
  "met.tropical.hurricane": "Hurricane",
  "met.tropical.storm": "Tropical storm",
  "met.tropical.typhoon": "Typhoon",
  "met.wind": "Wind",
  "met.wind.extreme": "Extreme wind",
  "met.wind.high": "High wind",
  "met.wind.lake": "Lake wind",
  "met.winter": "Winter",
  "met.winter.blizzard": "Blizzard",
  "met.winter.freezing-rain": "Freezing rain",
  "met.winter.ice-storm": "Ice storm",
  "met.winter.lake-effect-snow": "Lake-effect snow",
  "met.winter.snow-squall": "Snow squall",
  "met.winter.storm": "Winter storm",
  "met.winter.weather": "Winter weather",

  "env.air-quality": "Air quality",
  "env.air-stagnation": "Air stagnation",
  "env.smoke": "Dense smoke",
  "env.smoke.marine": "Dense smoke at sea",

  "fire.weather": "Fire weather",
  "fire.wildfire": "Wildfire",

  "safety.civil-danger": "Civil danger",
  "safety.civil-emergency": "Civil emergency",
  "safety.evacuation": "Evacuation",
  "safety.local-emergency": "Local emergency",
  "safety.national-emergency": "National emergency",
  "safety.shelter-in-place": "Shelter in place",

  "security.blue-alert": "Threat to the police",
  "security.child-abduction": "Child abduction",
  "security.law-enforcement": "Law enforcement warning",
  "security.missing-person": "Missing and endangered person",

  "cbrne.hazardous-materials": "Hazardous materials",
  "cbrne.nuclear-plant": "Nuclear power plant",
  "cbrne.radiological": "Radiological hazard",

  "infra.telecom": "Telephone and network",
  "infra.telecom.911-outage": "911 outage",

  [UNKNOWN_KIND]: "Unknown event",

  "system.admin": "Administrative message",
  "system.test": "Test message",
  [HEALTH_KIND]: "Health of a source",
  ...Object.fromEntries(Object.entries(HEALTH_LABELS).map(([state, label]) => [`${HEALTH_KIND}.${state}`, label])),
  [COVERAGE_KIND]: "Coverage of a kind",
};

/**
 * This function tells if a code is in the taxonomy. The code must be a code of `TAXONOMY`, or
 * `system.coverage.<code>` for a code of `TAXONOMY` that is not a code of the system.
 */
export function knownKind(code: string): boolean {
  if (Object.hasOwn(TAXONOMY, code)) return true;
  if (!code.startsWith(`${COVERAGE_KIND}.`)) return false;
  const covered = code.slice(COVERAGE_KIND.length + 1);
  return categoryOf(covered) !== "system" && Object.hasOwn(TAXONOMY, covered);
}

/** This function gives the codes that are not in the taxonomy, sorted and each one time. The gate tests of the adapters use it. */
export function unknownKinds(codes: Iterable<string>): string[] {
  return [...new Set([...codes].filter((code) => !knownKind(code)))].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * The kinds of the NWS messages in the taxonomy of the alert system.
 *
 * A kind is a calculation from three tables. The VTEC phenomenon gives the hazard, and the VTEC
 * significance gives the stage. The SAME event codes (47 CFR 11.31) and the NWS codes with no VTEC
 * form have a table of their own. The NWS API, FEMA IPAWS and the NOAA Weather Radio give these
 * codes, so the tables serve each of them.
 *
 * This package is the home of the tables. Each source of NWS or SAME messages imports them from here.
 */

import { categoryOf as coreCategoryOf, UNKNOWN_KIND, type Kind, type Significance } from "@mark1russell7/alerts";
import { mainVtec, type Vtec } from "./vtec.ts";

/** One hazard of the taxonomy: its dotted code and its plain name. */
export interface Hazard {
  /** The dotted code, for example `met.tornado`. The first part is a CAP category of the system. */
  readonly code: string;
  readonly label: string;
}

/** One event code: a hazard and, when the code gives it, the stage. */
export interface EventCode extends Hazard {
  readonly significance?: Significance;
}

/** The VTEC phenomena (NWS Directive 10-1703), as hazards of the taxonomy. */
export const PHENOMENA: Readonly<Record<string, Hazard>> = {
  AF: { code: "geo.volcano.ashfall", label: "Ashfall" },
  AS: { code: "env.air-stagnation", label: "Air Stagnation" },
  BH: { code: "met.beach-hazards", label: "Beach Hazards" },
  BW: { code: "met.marine.brisk-wind", label: "Brisk Wind" },
  BZ: { code: "met.winter.blizzard", label: "Blizzard" },
  CF: { code: "met.flood.coastal", label: "Coastal Flood" },
  CW: { code: "met.cold", label: "Cold Weather" },
  DF: { code: "geo.debris-flow", label: "Debris Flow" },
  DS: { code: "met.dust-storm", label: "Dust Storm" },
  DU: { code: "met.blowing-dust", label: "Blowing Dust" },
  EC: { code: "met.cold.extreme", label: "Extreme Cold" },
  EH: { code: "met.heat.extreme", label: "Excessive Heat" },
  EW: { code: "met.wind.extreme", label: "Extreme Wind" },
  FA: { code: "met.flood.areal", label: "Areal Flood" },
  FF: { code: "met.flood.flash", label: "Flash Flood" },
  FG: { code: "met.fog", label: "Dense Fog" },
  FL: { code: "met.flood.river", label: "Flood" },
  FR: { code: "met.frost", label: "Frost" },
  FW: { code: "fire.weather", label: "Fire Weather" },
  FZ: { code: "met.freeze", label: "Freeze" },
  GL: { code: "met.marine.gale", label: "Gale" },
  HF: { code: "met.marine.hurricane-force-wind", label: "Hurricane Force Wind" },
  HT: { code: "met.heat", label: "Heat" },
  HU: { code: "met.tropical.hurricane", label: "Hurricane" },
  HW: { code: "met.wind.high", label: "High Wind" },
  HY: { code: "met.flood.hydrologic", label: "Hydrologic" },
  HZ: { code: "met.freeze.hard", label: "Hard Freeze" },
  IS: { code: "met.winter.ice-storm", label: "Ice Storm" },
  LE: { code: "met.winter.lake-effect-snow", label: "Lake Effect Snow" },
  LO: { code: "met.marine.low-water", label: "Low Water" },
  LS: { code: "met.flood.lakeshore", label: "Lakeshore Flood" },
  LW: { code: "met.wind.lake", label: "Lake Wind" },
  MA: { code: "met.marine.special", label: "Special Marine" },
  MF: { code: "met.marine.fog", label: "Marine Dense Fog" },
  MH: { code: "geo.volcano.ashfall-marine", label: "Marine Ashfall" },
  MS: { code: "env.smoke.marine", label: "Marine Dense Smoke" },
  RB: { code: "met.marine.small-craft.rough-bar", label: "Small Craft for Rough Bar" },
  RP: { code: "met.rip-current", label: "Rip Current" },
  SC: { code: "met.marine.small-craft", label: "Small Craft" },
  SE: { code: "met.marine.hazardous-seas", label: "Hazardous Seas" },
  SI: { code: "met.marine.small-craft.wind", label: "Small Craft for Winds" },
  SM: { code: "env.smoke", label: "Dense Smoke" },
  SQ: { code: "met.winter.snow-squall", label: "Snow Squall" },
  SR: { code: "met.marine.storm", label: "Storm" },
  SS: { code: "met.surge", label: "Storm Surge" },
  SU: { code: "met.surf", label: "High Surf" },
  SV: { code: "met.thunderstorm.severe", label: "Severe Thunderstorm" },
  SW: { code: "met.marine.small-craft.seas", label: "Small Craft for Hazardous Seas" },
  TO: { code: "met.tornado", label: "Tornado" },
  TR: { code: "met.tropical.storm", label: "Tropical Storm" },
  TS: { code: "geo.tsunami", label: "Tsunami" },
  TY: { code: "met.tropical.typhoon", label: "Typhoon" },
  UP: { code: "met.marine.freezing-spray.heavy", label: "Heavy Freezing Spray" },
  WC: { code: "met.cold.wind-chill", label: "Wind Chill" },
  WI: { code: "met.wind", label: "Wind" },
  WS: { code: "met.winter.storm", label: "Winter Storm" },
  WW: { code: "met.winter.weather", label: "Winter Weather" },
  XH: { code: "met.heat.extreme", label: "Extreme Heat" },
  ZF: { code: "met.fog.freezing", label: "Freezing Fog" },
  ZR: { code: "met.winter.freezing-rain", label: "Freezing Rain" },
  ZY: { code: "met.marine.freezing-spray", label: "Freezing Spray" },
};

/** The VTEC significance letters, as stages. */
export const SIGNIFICANCE: Readonly<Record<string, Significance>> = {
  W: "warning",
  A: "watch",
  Y: "advisory",
  S: "statement",
  O: "outlook",
  F: "outlook",
  N: "statement",
};

/** The words of the stages in the event names, for example `Warning` in `Tornado Warning`. */
export const STAGE_WORDS: Readonly<Record<Significance, string>> = {
  warning: "Warning",
  watch: "Watch",
  advisory: "Advisory",
  statement: "Statement",
  outlook: "Outlook",
  observation: "Observation",
};

const code = (hazard: string, label: string, significance?: Significance): EventCode =>
  significance === undefined ? { code: hazard, label } : { code: hazard, label, significance };

/**
 * The SAME event codes (47 CFR 11.31) and the NWS event codes that have no VTEC form. A code of the
 * form phenomenon and significance (`GLW`) needs no row: `resolveKind` calculates it.
 */
export const EVENT_CODES: Readonly<Record<string, EventCode>> = {
  // Weather, with a SAME code that is not the phenomenon and the significance
  TOR: code("met.tornado", "Tornado Warning", "warning"),
  TOA: code("met.tornado", "Tornado Watch", "watch"),
  SVR: code("met.thunderstorm.severe", "Severe Thunderstorm Warning", "warning"),
  SVA: code("met.thunderstorm.severe", "Severe Thunderstorm Watch", "watch"),
  SVS: code("met.severe-weather", "Severe Weather Statement", "statement"),
  FFW: code("met.flood.flash", "Flash Flood Warning", "warning"),
  FFA: code("met.flood", "Flash Flood Watch", "watch"),
  FFS: code("met.flood.flash", "Flash Flood Statement", "statement"),
  FLW: code("met.flood", "Flood Warning", "warning"),
  FLA: code("met.flood", "Flood Watch", "watch"),
  FLS: code("met.flood", "Flood Statement", "statement"),
  HWW: code("met.wind.high", "High Wind Warning", "warning"),
  HWA: code("met.wind.high", "High Wind Watch", "watch"),
  EWW: code("met.wind.extreme", "Extreme Wind Warning", "warning"),
  HUW: code("met.tropical.hurricane", "Hurricane Warning", "warning"),
  HUA: code("met.tropical.hurricane", "Hurricane Watch", "watch"),
  HLS: code("met.tropical", "Hurricane Local Statement", "statement"),
  TRW: code("met.tropical.storm", "Tropical Storm Warning", "warning"),
  TRA: code("met.tropical.storm", "Tropical Storm Watch", "watch"),
  SSW: code("met.surge", "Storm Surge Warning", "warning"),
  SSA: code("met.surge", "Storm Surge Watch", "watch"),
  TSW: code("geo.tsunami", "Tsunami Warning", "warning"),
  TSA: code("geo.tsunami", "Tsunami Watch", "watch"),
  WSW: code("met.winter.storm", "Winter Storm Warning", "warning"),
  WSA: code("met.winter.storm", "Winter Storm Watch", "watch"),
  BZW: code("met.winter.blizzard", "Blizzard Warning", "warning"),
  SQW: code("met.winter.snow-squall", "Snow Squall Warning", "warning"),
  CFW: code("met.flood.coastal", "Coastal Flood Warning", "warning"),
  CFA: code("met.flood.coastal", "Coastal Flood Watch", "watch"),
  DSW: code("met.dust-storm", "Dust Storm Warning", "warning"),
  SMW: code("met.marine.special", "Special Marine Warning", "warning"),
  SPS: code("met.special", "Special Weather Statement", "statement"),
  MWS: code("met.marine.special", "Marine Weather Statement", "statement"),
  HWO: code("met.outlook", "Hazardous Weather Outlook", "outlook"),
  AQA: code("env.air-quality", "Air Quality Alert", "advisory"),
  // Geophysical
  AVW: code("geo.avalanche", "Avalanche Warning", "warning"),
  AVA: code("geo.avalanche", "Avalanche Watch", "watch"),
  EQW: code("geo.earthquake", "Earthquake Warning", "warning"),
  VOW: code("geo.volcano.eruption", "Volcano Warning", "warning"),
  FRW: code("fire.wildfire", "Fire Warning", "warning"),
  // Civil and non-weather
  EAN: code("safety.national-emergency", "Emergency Action Notification", "warning"),
  CDW: code("safety.civil-danger", "Civil Danger Warning", "warning"),
  CEM: code("safety.civil-emergency", "Civil Emergency Message"),
  EVI: code("safety.evacuation", "Evacuation Immediate", "warning"),
  SPW: code("safety.shelter-in-place", "Shelter in Place Warning", "warning"),
  LAE: code("safety.local-emergency", "Local Area Emergency"),
  HMW: code("cbrne.hazardous-materials", "Hazardous Materials Warning", "warning"),
  NUW: code("cbrne.nuclear-plant", "Nuclear Power Plant Warning", "warning"),
  RHW: code("cbrne.radiological", "Radiological Hazard Warning", "warning"),
  LEW: code("security.law-enforcement", "Law Enforcement Warning", "warning"),
  BLU: code("security.blue-alert", "Blue Alert"),
  CAE: code("security.child-abduction", "Child Abduction Emergency"),
  MEP: code("security.missing-person", "Missing and Endangered Persons"),
  TOE: code("infra.telecom.911-outage", "911 Telephone Outage Emergency"),
  // Tests and messages of the systems
  TST: code("system.test", "Test Message"),
  RWT: code("system.test", "Required Weekly Test"),
  RMT: code("system.test", "Required Monthly Test"),
  NPT: code("system.test", "National Periodic Test"),
  NAT: code("system.test", "National Audible Test"),
  NST: code("system.test", "National Silent Test"),
  DMO: code("system.test", "Practice/Demo Warning"),
  ADR: code("system.admin", "Administrative Message"),
  NMN: code("system.admin", "Network Message Notification"),
};

/** This function calculates the event code of a phenomenon and a significance, for example `TO` and `W`. */
export function fromPhenomenon(phenomenon: string, significance: string): EventCode | undefined {
  const hazard = PHENOMENA[phenomenon];
  const stage = SIGNIFICANCE[significance];
  if (hazard === undefined || stage === undefined) return undefined;
  return { code: hazard.code, label: `${hazard.label} ${STAGE_WORDS[stage]}`, significance: stage };
}

/** This function gives the event code of a three-letter code: a row of the table, or a phenomenon and a significance. */
export function fromEventCode(value: string): EventCode | undefined {
  const upper = value.trim().toUpperCase();
  return EVENT_CODES[upper] ?? (upper.length === 3 ? fromPhenomenon(upper.slice(0, 2), upper.slice(2)) : undefined);
}

/**
 * The other names of some events: names that do not follow the pattern of hazard and stage. The NWS
 * gives one name to the river floods and the areal floods, so these names give the broad code.
 */
export const NAME_ALIASES: Readonly<Record<string, EventCode>> = {
  "flood warning": code("met.flood", "Flood Warning", "warning"),
  "flood watch": code("met.flood", "Flood Watch", "watch"),
  "flood advisory": code("met.flood", "Flood Advisory", "advisory"),
  "flood statement": code("met.flood", "Flood Statement", "statement"),
  "red flag warning": code("fire.weather", "Red Flag Warning", "warning"),
  "small craft advisory for hazardous seas": code("met.marine.small-craft.seas", "Small Craft Advisory for Hazardous Seas", "advisory"),
  "small craft advisory for rough bar": code("met.marine.small-craft.rough-bar", "Small Craft Advisory for Rough Bar", "advisory"),
  "small craft advisory for winds": code("met.marine.small-craft.wind", "Small Craft Advisory for Winds", "advisory"),
};

/**
 * The index of the event names, in lower case. A name of a phenomenon and a stage comes first, then a
 * name of the table of event codes, then an alias. The first row of a name wins, but an alias replaces it.
 */
const NAMES: ReadonlyMap<string, EventCode> = (() => {
  const index = new Map<string, EventCode>();
  const add = (event: EventCode): void => {
    const name = event.label.toLowerCase();
    if (!index.has(name)) index.set(name, event);
  };
  for (const phenomenon of Object.keys(PHENOMENA)) {
    for (const letter of ["W", "A", "Y", "S", "O"]) {
      const event = fromPhenomenon(phenomenon, letter);
      if (event !== undefined) add(event);
    }
  }
  for (const event of Object.values(EVENT_CODES)) add(event);
  for (const [name, event] of Object.entries(NAME_ALIASES)) index.set(name, event);
  return index;
})();

/** This function gives the event code of an event name, for example `Tornado Warning`. */
export function fromEventName(name: string): EventCode | undefined {
  return NAMES.get(name.trim().replace(/\s+/g, " ").toLowerCase());
}

/** The facts of a message that give its kind. */
export interface KindFacts {
  /** The VTEC strings of the message, in parts. */
  readonly vtec?: readonly Vtec[];
  /** The NWS event code, for example `TOW` or `SPS`. */
  readonly nwsCode?: string;
  /** The SAME event code, for example `TOR`. The value `NWS` means "no SAME code". */
  readonly sameCode?: string;
  /** The event name that the source gives, for example `Tornado Warning`. */
  readonly name?: string;
}

/** The kind of a message. The value `known` is true if a table knew the kind. */
export interface ResolvedKind {
  readonly kind: Kind;
  readonly known: boolean;
}

/**
 * This function calculates the kind of a message. The order is: the main VTEC, the NWS code, the
 * SAME code, the event name. The label of the kind is the name that the source gives, when it gives one.
 */
export function resolveKind(facts: KindFacts): ResolvedKind {
  const vtec = mainVtec(facts.vtec ?? []);
  const found =
    (vtec === undefined ? undefined : fromPhenomenon(vtec.phenomenon, vtec.significance)) ??
    (facts.nwsCode === undefined ? undefined : fromEventCode(facts.nwsCode)) ??
    (facts.sameCode === undefined || facts.sameCode.toUpperCase() === "NWS" ? undefined : fromEventCode(facts.sameCode)) ??
    (facts.name === undefined ? undefined : fromEventName(facts.name));
  const label = facts.name !== undefined && facts.name.trim() !== "" ? facts.name.trim() : (found?.label ?? "Unknown event");
  if (found === undefined) return { kind: { code: UNKNOWN_KIND, label }, known: false };
  const kind: Kind =
    found.significance === undefined ? { code: found.code, label } : { code: found.code, significance: found.significance, label };
  return { kind, known: true };
}

/**
 * This value is the function `categoryOf` of the core. Its home is the taxonomy of the core. Two sources
 * of open pull requests import it from this package, so it stays here for one more pull request.
 *
 * @deprecated Import `categoryOf` from `@mark1russell7/alerts`. The next pull request removes it from this package.
 */
export const categoryOf: typeof coreCategoryOf = coreCategoryOf;

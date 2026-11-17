/**
 * The kinds of the CAP messages of each alerting authority. The NWS tables of `format-nws` know the events of the NWS
 * family. The other authorities name their events in their own languages, so this module reads their event codes.
 *
 * - The OASIS Event Terms List gives one code for each event term. The WMO hub of CAP feeds writes it in each message, as
 *   the event code `OET:v1.2`.
 * - The CAP profile of MeteoAlarm writes the awareness type of each warning as a parameter, for example `10; rain`.
 * - The CAP category of the message decides when no code is known.
 *
 * The table of the OASIS terms comes from "Event Terms List for Use with the Common Alerting Protocol Version 1.2",
 * Committee Note 01 of 19 November 2020: https://docs.oasis-open.org/emergency/cap-etl/v1.2/cap-etl-v1.2.html.
 * Copyright OASIS Open 2020. All Rights Reserved. The table gives a code of the taxonomy of the system for each term.
 */

import type { CapInfo } from "./read.ts";

/** The name of the event code of the OASIS Event Terms List 1.2. The numbers of version 1.0 are different. */
export const OET_VERSION = "OET:v1.2";

/**
 * The code of the taxonomy for each term of the OASIS Event Terms List 1.2. The value `null` marks a term that names
 * no hazard, for example `other event` or `practice`. Then the CAP category of the message decides.
 */
export const OET_KINDS: Readonly<Record<string, string | null>> = {
  "OET-000": null, // other event
  "OET-001": "security.active-threat", // active shooter situation
  "OET-002": null, // administrative activity
  "OET-003": "transport.air.hazard-weather", // air hazard
  "OET-004": "env.air-quality", // air quality
  "OET-005": "rescue.search-and-rescue", // air search
  "OET-006": "env.air-stagnation", // air stagnation
  "OET-007": "transport.air.accident", // aircraft crash
  "OET-008": "transport.air.accident", // aircraft incident
  "OET-009": "transport.air.disruption", // airport closure
  "OET-010": "transport.air.disruption", // airspace closure
  "OET-011": "transport.air.notam", // airspace restriction
  "OET-012": "health", // ambulance
  "OET-013": "health.animal-disease", // animal disease
  "OET-014": "health", // animal feed
  "OET-015": "health.animal-disease", // animal health
  "OET-016": "met.cold", // arctic outflow
  "OET-017": "geo.volcano.ashfall", // ashfall
  "OET-018": "geo.avalanche", // avalanche
  "OET-019": "transport.air", // aviation hazard
  "OET-020": "security", // aviation security
  "OET-021": "met.beach-hazards", // beach hazard
  "OET-022": "cbrne.biological", // biological
  "OET-023": "met.winter.blizzard", // blizzard
  "OET-024": "health", // blood supply
  "OET-025": "met.blowing-dust", // blowing dust
  "OET-026": "met.winter", // blowing snow
  "OET-027": "env.water.harmful-algal-bloom", // blue-green algae
  "OET-028": "security", // bomb threat
  "OET-029": "transport.road", // bridge closure
  "OET-030": "infra.structure.collapse", // bridge collapse
  "OET-031": "infra.structure.collapse", // building collapse
  "OET-032": "infra.structure", // building structure hazard
  "OET-033": "fire.wildfire", // bush fire
  "OET-034": "infra.telecom.outage", // cable service issue
  "OET-035": "infra", // canal
  "OET-036": "cbrne.hazardous-materials", // chemical fire
  "OET-037": "cbrne.hazardous-materials", // chemical hazard
  "OET-038": "security.child-abduction", // child abduction
  "OET-039": "security.civil-unrest", // civil
  "OET-040": "security.civil-unrest", // civil protest
  "OET-041": "infra.gas", // coal gas
  "OET-042": "met.flood.coastal", // coastal flood
  "OET-043": "met.cold", // cold
  "OET-044": "met.cold", // cold weather
  "OET-045": "infra.telecom.outage", // communications service disruption
  "OET-046": "health.outbreak", // contagious disease
  "OET-047": "env.water.drinking-advisory", // contaminated water
  "OET-048": "cbrne", // contamination
  "OET-049": "security.crime", // criminal activity
  "OET-050": "cyber", // cybercrime threat
  "OET-051": "met.tropical", // cyclone
  "OET-052": "infra.dam.failure", // dam break
  "OET-053": "infra.dam", // dam issue
  "OET-054": "safety.wildlife", // dangerous animal
  "OET-055": "security.active-threat", // dangerous person threat
  "OET-056": "geo.debris-flow", // debris flow
  "OET-057": "security.civil-unrest", // demonstration
  "OET-058": "met.fog", // dense fog
  "OET-059": "env.smoke", // dense smoke
  "OET-060": "infra.fuel", // diesel fuel issue
  "OET-061": "health", // disease
  "OET-062": "health.outbreak", // disease outbreak
  "OET-063": "met.drought", // drought
  "OET-064": "safety.recall.drug", // drug safety
  "OET-065": "health.drug-shortage", // drug supply
  "OET-066": "met.dust-storm", // dust storm
  "OET-067": "met.flood", // dyke break
  "OET-068": "geo.earthquake", // earthquake
  "OET-069": "infra", // electronic infrastructure
  "OET-070": "safety", // emergency responder incident
  "OET-071": "safety", // emergency responder threat
  "OET-072": "infra", // emergency support facilities incident
  "OET-073": "infra", // emergency support services incident
  "OET-074": "infra.telecom.911-outage", // emergency telephone outage
  "OET-075": "env", // environmental issue
  "OET-076": "cbrne.explosion", // explosion threat
  "OET-077": "safety", // falling object
  "OET-078": "fire", // fire
  "OET-079": "met.flood.flash", // flash flood
  "OET-080": "met.freeze", // flash freeze
  "OET-081": "met.flood", // flood
  "OET-082": "met.fog", // fog
  "OET-083": "safety.recall.food", // food contamination
  "OET-084": "safety.recall.food", // food safety
  "OET-085": "infra.supply-chain", // food supply
  "OET-086": "fire.wildfire", // forest fire
  "OET-087": "met.freeze", // freeze
  "OET-088": "met.winter.freezing-rain", // freezing drizzle
  "OET-089": "met.winter.freezing-rain", // freezing rain
  "OET-090": "met.marine.freezing-spray", // freezing spray
  "OET-091": "met.frost", // frost
  "OET-092": "infra.fuel", // fuel issue
  "OET-093": "geo", // geophysical issue
  "OET-094": "fire.wildfire", // grass fire
  "OET-095": "met.thunderstorm", // hail
  "OET-096": "met.marine.hazardous-seas", // hazardous seas
  "OET-097": "health", // health issue
  "OET-098": "met.heat", // heat
  "OET-099": "infra.fuel", // heating oil issue
  "OET-100": "met.marine.hazardous-seas", // high seas
  "OET-101": "met.surf", // high surf
  "OET-102": "met.flood.coastal", // high tide
  "OET-103": "met.flood", // high water
  "OET-104": "security.crime", // home crime
  "OET-105": "met", // humidity issue
  "OET-106": "met.tropical.hurricane", // hurricane
  "OET-107": "met.winter", // ice
  "OET-108": "met.marine", // ice pressure issue
  "OET-109": "met.winter.ice-storm", // ice storm
  "OET-110": "met.marine", // iceberg
  "OET-111": "security.crime", // industrial crime
  "OET-112": "safety", // industrial facility
  "OET-113": "fire.structure", // industrial fire
  "OET-114": "infra", // infrastructure
  "OET-115": "infra.internet.outage", // internet service
  "OET-116": "met.winter.lake-effect-snow", // lake effect snow
  "OET-117": "met.wind.lake", // lake wind
  "OET-118": "infra.telecom.outage", // landline service
  "OET-119": "geo.landslide", // landslide
  "OET-120": "security.law-enforcement", // law enforcement
  "OET-121": "met.flood", // levee break
  "OET-122": "met.lightning", // lightning
  "OET-123": "met.fog", // limited visibility
  "OET-124": "met.marine.low-water", // low tide
  "OET-125": "met.marine.low-water", // low water
  "OET-126": "infra.water", // low water pressure
  "OET-127": "geo.fireball", // meteoroid
  "OET-128": "met", // meteorological issue
  "OET-129": "security.air-raid", // missile threat
  "OET-130": "security.missing-person", // missing person(s)
  "OET-131": "infra.telecom.outage", // mobile communication
  "OET-132": "met", // monsoon
  "OET-133": "geo.debris-flow", // mudslide
  "OET-134": "infra.gas", // natural gas
  "OET-135": null, // network message notification
  "OET-136": "cbrne.nuclear-plant", // nuclear power plant
  "OET-137": "env.spill", // oil leak
  "OET-138": "env.spill", // oil spill
  "OET-139": "rescue.search-and-rescue", // over water search
  "OET-140": "met.flood.areal", // overland flood
  "OET-141": "rescue.search-and-rescue", // overland search
  "OET-142": "infra.gas.pipeline-incident", // pipeline rupture
  "OET-143": "env.pest-quarantine", // plant health issue
  "OET-144": "env.water.drinking-advisory", // potable water
  "OET-145": "infra.power.outage", // power outage
  "OET-146": "infra.power", // power utility
  "OET-147": null, // practice
  "OET-148": "safety.recall.consumer-product", // product safety
  "OET-149": "infra", // public facility
  "OET-150": "health", // public health
  "OET-151": "infra", // public service issue
  "OET-152": "transport.transit.service-alert", // public transit issue
  "OET-153": "geo.volcano.eruption", // pyroclastic flow
  "OET-154": "cbrne.radiological", // radiation
  "OET-155": "infra.telecom", // radio transmitter
  "OET-156": "cbrne.radiological", // radioactive material release
  "OET-157": "cbrne.radiological", // radiological fire
  "OET-158": "transport.rail", // railway issue
  "OET-159": "met.rain", // rain
  "OET-160": "transport.sea", // rapid ice closing of water passage
  "OET-161": "env.water.harmful-algal-bloom", // red tide
  "OET-162": "rescue", // rescue
  "OET-163": "security.crime", // retail crime issue
  "OET-164": "met.rip-current", // rip current issue
  "OET-165": "transport.road", // road closure
  "OET-166": "transport.road", // road issue
  "OET-167": "transport.road.incident", // road vehicle accident
  "OET-168": "met.marine.hazardous-seas", // rogue waves
  "OET-169": "safety", // safety
  "OET-170": "met.dust-storm", // sandstorm
  "OET-171": "geo.space-debris", // satellite debris
  "OET-172": "infra.telecom", // satellite service
  "OET-173": "transport.road", // school bus issue
  "OET-174": "civic", // school closing
  "OET-175": "security.active-threat", // school lockdown
  "OET-176": "rescue.search-and-rescue", // search event
  "OET-177": "security", // security
  "OET-178": "env.water.sewage-overflow", // sewer
  "OET-179": "met.beach-hazards", // shoreline threat
  "OET-180": "geo.subsidence", // sinkhole
  "OET-181": "met.winter.weather", // sleet
  "OET-182": "met.winter.weather", // snow
  "OET-183": "met.winter.storm", // snowstorm
  "OET-184": "geo.space-debris", // space debris
  "OET-185": "geo.space-weather", // space weather
  "OET-186": "met.wind", // squall
  "OET-187": "met.severe-weather", // storm
  "OET-188": "infra.water", // storm drain
  "OET-189": "met.surge", // storm surge
  "OET-190": "fire.structure", // structure fire
  "OET-191": "met.marine.hazardous-seas", // swells
  "OET-192": "infra.telecom.outage", // telephone
  "OET-193": "security.terrorism", // terrorist incident
  "OET-194": "met.thunderstorm", // thunderstorm
  "OET-195": "met.tornado", // tornadic waterspout
  "OET-196": "met.tornado", // tornado
  "OET-197": "cbrne.hazardous-materials", // toxic plume
  "OET-198": "cbrne.hazardous-materials", // toxic spill
  "OET-199": "transport.road", // traffic
  "OET-200": "transport", // transportation
  "OET-201": "met.tropical", // tropical depression
  "OET-202": "met.tropical.storm", // tropical storm
  "OET-203": "geo.tsunami", // tsunami
  "OET-204": "met.tropical.typhoon", // typhoon
  "OET-205": "env.uv", // ultraviolet
  "OET-206": "infra", // utility
  "OET-207": "security.crime", // vehicle crime
  "OET-208": "geo.volcano", // volcanic activity
  "OET-209": "geo.volcano.eruption", // volcanic eruption
  "OET-210": "geo.volcano", // volcanic lahar
  "OET-211": "geo.volcano.eruption", // volcanic lava
  "OET-212": "infra", // waste management
  "OET-213": null, // water
  "OET-214": "infra.water.outage", // water main break
  "OET-215": "met.tornado", // waterspout
  "OET-216": "met", // weather
  "OET-217": "fire.wildfire", // wildfire
  "OET-218": "met.wind", // wind
  "OET-219": "met.wind", // wind change
  "OET-220": "met.cold.wind-chill", // wind chill
  "OET-221": "transport.air.hazard-weather", // wind shear
  "OET-222": "met.winter.storm", // winter storm
  "OET-223": "met.winter.weather", // winter weather
};

/**
 * The code of the taxonomy for each awareness type of the CAP profile of MeteoAlarm, by the name of the type in lower
 * case. A message writes the number and the name, for example `6; low-temperature`. The map reads the name.
 */
export const METEOALARM_KINDS: Readonly<Record<string, string>> = {
  wind: "met.wind",
  "snow-ice": "met.winter",
  thunderstorm: "met.thunderstorm",
  fog: "met.fog",
  "high-temperature": "met.heat",
  "low-temperature": "met.cold",
  coastalevent: "met.flood.coastal",
  "forest-fire": "fire.weather",
  avalanches: "geo.avalanche",
  rain: "met.rain",
  flooding: "met.flood",
  "rain-flood": "met.flood",
};

/** The name of the parameter of the awareness type in the CAP profile of MeteoAlarm. */
export const METEOALARM_TYPE = "awareness_type";

/** A kind that an event code of a message gives, with the code that gave it. */
export interface CodedKind {
  /** The code of the taxonomy. */
  readonly code: string;
  /** The code of the message that gave the kind, for example `OET:v1.2 OET-218` or `awareness_type 10; rain`. */
  readonly from: string;
}

/** The facts that `codedKind` found in one info block. A code that the tables do not know is in `unknown`. */
export interface CodedKinds {
  readonly kind?: CodedKind;
  /** Each event code or awareness type of the block that the tables do not know, as the message has it. */
  readonly unknown: readonly string[];
}

/** This function gives the name of the awareness type of MeteoAlarm in lower case. For example, the value `10; rain` gives `rain`. */
export function meteoalarmTypeName(value: string): string {
  const at = value.indexOf(";");
  return (at < 0 ? value : value.slice(at + 1)).trim().toLowerCase();
}

/**
 * This function finds the kind of an info block from its event codes. The first OASIS term with a known code wins.
 * When no term is known, the first awareness type of MeteoAlarm wins. The function ignores the event codes of other systems, for example the codes of
 * the NWS. It gives each OASIS code and each awareness type that its tables do not know.
 */
export function codedKind(info: Pick<CapInfo, "eventCodes" | "parameters">): CodedKinds {
  const unknown: string[] = [];
  let kind: CodedKind | undefined;
  for (const pair of info.eventCodes) {
    if (!/^OET:v\d/i.test(pair.valueName.trim())) continue;
    const value = pair.value.trim().toUpperCase();
    const code = pair.valueName.trim() === OET_VERSION && Object.hasOwn(OET_KINDS, value) ? OET_KINDS[value] : undefined;
    if (code === undefined) unknown.push(`${pair.valueName.trim()} ${pair.value.trim()}`);
    else if (code !== null) kind ??= { code, from: `${OET_VERSION} ${value}` };
  }
  for (const pair of info.parameters) {
    if (pair.valueName.trim() !== METEOALARM_TYPE) continue;
    const name = meteoalarmTypeName(pair.value);
    const code = Object.hasOwn(METEOALARM_KINDS, name) ? METEOALARM_KINDS[name] : undefined;
    if (code === undefined) unknown.push(`${METEOALARM_TYPE} ${pair.value.trim()}`);
    else kind ??= { code, from: `${METEOALARM_TYPE} ${pair.value.trim()}` };
  }
  return kind === undefined ? { unknown } : { kind, unknown };
}

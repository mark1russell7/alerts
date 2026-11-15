/**
 * The first assessment of the alert system: the level of an incident for a person.
 *
 * The level is a calculation on data. The policy gives a table for each class of kinds. The table
 * gives the highest level for the severity and the highest level for the urgency, and the lower of
 * the two applies. The level for a person is the highest level at the places of the person, after the rules
 * of the person. The assessment reads no clock: the field `live` of the incident holds the time.
 */
import type {
  AssessedLevel,
  AssessPolicy,
  AssessReason,
  Assessment,
  Incident,
  LevelTable,
  PersonWatch,
  PlaceId,
  RegionCode,
  WatchedPlace,
} from "./contracts.ts";
import { ASSESSED_LEVELS } from "./contracts.ts";

/**
 * The kinds that can reach `life-safety` in the first policy: the list of `docs/CONTRACTS.md`, as
 * prefixes of the taxonomy codes.
 */
export const LIFE_SAFETY_KINDS: readonly string[] = [
  "met.tornado",
  "met.flood.flash",
  "met.wind.extreme",
  "met.tropical.hurricane",
  "met.surge",
  "fire.wildfire",
  "geo.tsunami",
  "geo.earthquake",
  "safety.evacuation",
  "safety.shelter-in-place",
  "safety.civil-danger",
  "safety.civil-emergency",
  "cbrne",
];

/**
 * The table of the kinds that can reach `life-safety`. An `unknown` severity or urgency counts as
 * high, because a miss costs more than a false alarm for these kinds.
 */
const LIFE_SAFETY_TABLE: LevelTable = {
  severity: { extreme: "life-safety", severe: "life-safety", moderate: "urgent", minor: "notice", unknown: "life-safety" },
  urgency: { immediate: "life-safety", expected: "life-safety", future: "urgent", past: "digest", unknown: "life-safety" },
};

/** The table of the other kinds. These kinds reach `urgent` at most. */
const OTHER_TABLE: LevelTable = {
  severity: { extreme: "urgent", severe: "urgent", moderate: "notice", minor: "digest", unknown: "digest" },
  urgency: { immediate: "urgent", expected: "urgent", future: "notice", past: "digest", unknown: "notice" },
};

/**
 * The first policy. An incident is `life-safety` when its status is `actual` and its kind is in
 * `LIFE_SAFETY_KINDS`. Its severity must be `severe` or `extreme`, and its urgency must be
 * `immediate` or `expected`. A place of the person must be in its areas.
 */
export const DEFAULT_ASSESS_POLICY: AssessPolicy = {
  statuses: ["actual"],
  classes: [{ id: "life-safety", kinds: LIFE_SAFETY_KINDS, ...LIFE_SAFETY_TABLE }],
  otherwise: OTHER_TABLE,
};

/**
 * This function tells if a kind has one of the prefixes. A prefix ends at a dot: `met.flood` has
 * `met.flood.flash`, but `met.fl` does not have `met.flood`. The adapters and the core use this one rule.
 */
export function hasKind(prefixes: readonly string[], kind: string): boolean {
  return prefixes.some((prefix) => kind === prefix || kind.startsWith(`${prefix}.`));
}

/** This function gives the lower of two levels. */
export function lowerLevel(a: AssessedLevel, b: AssessedLevel): AssessedLevel {
  return rank(a) <= rank(b) ? a : b;
}

/** This function gives the higher of two levels. */
export function higherLevel(a: AssessedLevel, b: AssessedLevel): AssessedLevel {
  return rank(a) >= rank(b) ? a : b;
}

/** The result of the table for one incident. */
export interface TableResult {
  /** The id of the class of the kind. It is absent for the table `otherwise`. */
  readonly class?: string;
  readonly bySeverity: AssessedLevel;
  readonly byUrgency: AssessedLevel;
  /** The lower of the two levels. */
  readonly level: AssessedLevel;
}

/** This function gives the level of the table for an incident: the lower of its two lookups. */
export function tableLevel(policy: AssessPolicy, incident: Pick<Incident, "kind" | "severity" | "urgency">): TableResult {
  const found = policy.classes.find((candidate) => hasKind(candidate.kinds, incident.kind.code));
  const table = found ?? policy.otherwise;
  const bySeverity = table.severity[incident.severity];
  const byUrgency = table.urgency[incident.urgency];
  const level = lowerLevel(bySeverity, byUrgency);
  return found === undefined ? { bySeverity, byUrgency, level } : { class: found.id, bySeverity, byUrgency, level };
}

/**
 * This function tells if a code of an area covers a code of a place. The codes must be of one
 * system and equal, with one more rule for SAME. The first digit of a SAME code is a part of the
 * county, and `0` is the full county. So two SAME codes of one county match unless they name two
 * different parts. This choice is on the safe side.
 */
export function regionCovers(area: RegionCode, place: RegionCode): boolean {
  if (area.system !== place.system) return false;
  if (area.code === place.code) return true;
  if (area.system !== "same" || !SAME.test(area.code) || !SAME.test(place.code)) return false;
  const [areaPart, placePart] = [area.code[0], place.code[0]];
  return area.code.slice(1) === place.code.slice(1) && (areaPart === "0" || placePart === "0");
}

/** A place in the areas of an incident, with the codes of the place that the areas cover. */
export interface PlaceMatch {
  readonly place: PlaceId;
  readonly codes: readonly RegionCode[];
}

/**
 * This function gives the places that the areas of an incident cover, in the order of the places.
 * It matches by codes only. The tests of polygons and circles with the buffer of a place wait for
 * the home of geography, `@mark1russell7/geo`. Until then, an area with no code covers no place.
 */
export function matchPlaces(incident: Pick<Incident, "areas">, places: readonly WatchedPlace[]): PlaceMatch[] {
  const codes = incident.areas.flatMap((area) => (area.type === "code" ? [area] : []));
  return places.flatMap((place) => {
    const covered = place.codes.filter((code) => codes.some((area) => regionCovers(area, code)));
    return covered.length > 0 ? [{ place: place.id, codes: covered }] : [];
  });
}

/**
 * This function gives the level of an incident for a person, with its reasons. The level is `none`
 * when the incident ended or when the policy does not send its status. It is also `none` when the
 * areas of the incident contain no place of the person. Else it is the highest level at the places of the person. At each place, the
 * first rule of the person that matches the place and the kind can lower the level of the table.
 */
export function assess(
  incident: Incident,
  person: PersonWatch,
  places: readonly WatchedPlace[],
  policy: AssessPolicy = DEFAULT_ASSESS_POLICY,
): Assessment {
  const byId = new Map(places.map((place) => [place.id, place]));
  const reasons: AssessReason[] = [];
  const watched: WatchedPlace[] = [];
  for (const id of person.places) {
    const place = byId.get(id);
    if (place === undefined) reasons.push({ kind: "unknown-place", place: id });
    else watched.push(place);
  }
  const matches = matchPlaces(incident, watched);
  const result = (level: AssessedLevel): Assessment => ({
    incident: incident.anchor,
    person: person.person,
    level,
    places: matches.map((match) => match.place),
    reasons,
  });
  if (!incident.live) {
    reasons.push({ kind: "ended" });
    return result("none");
  }
  if (!policy.statuses.includes(incident.status)) {
    reasons.push({ kind: "status", status: incident.status });
    return result("none");
  }
  if (matches.length === 0) {
    reasons.push({ kind: incident.areas.some((area) => area.type === "code") ? "no-place" : "no-codes" });
    return result("none");
  }
  const table = tableLevel(policy, incident);
  reasons.push({ kind: "table", ...table });
  let level: AssessedLevel = "none";
  for (const match of matches) {
    reasons.push({ kind: "place", place: match.place, codes: match.codes });
    const index = person.rules.findIndex(
      (rule) =>
        (rule.places === undefined || rule.places.includes(match.place)) &&
        (rule.kinds === undefined || hasKind(rule.kinds, incident.kind.code)),
    );
    const rule = person.rules[index];
    let atPlace = table.level;
    if (rule !== undefined && rank(rule.max) < rank(atPlace)) {
      atPlace = rule.max;
      reasons.push({ kind: "rule", place: match.place, index, max: rule.max });
    }
    level = higherLevel(level, atPlace);
  }
  return result(level);
}

// A SAME code: a part digit, two digits of the state and three digits of the county.
const SAME = /^\d{6}$/;

function rank(level: AssessedLevel): number {
  return ASSESSED_LEVELS.indexOf(level);
}

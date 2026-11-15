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
  KindClass,
  LevelTable,
  PersonWatch,
  PlaceId,
  RegionCode,
  SubjectWatch,
  WatchedPlace,
} from "./contracts.ts";
import { ASSESSED_LEVELS } from "./contracts.ts";

/**
 * The kinds that can reach `life-safety` in the first policy: the list of `docs/CONTRACTS.md`, as
 * prefixes of the taxonomy codes. A kind is in the list when its warning tells the people at a place
 * to act at once to save their lives. They take shelter, leave, or go to high ground.
 */
export const LIFE_SAFETY_KINDS: readonly string[] = [
  "met.tornado",
  "met.flood.flash",
  "met.wind.extreme",
  "met.tropical.hurricane",
  "met.tropical.typhoon",
  "met.surge",
  "fire.wildfire",
  "geo.tsunami",
  "geo.earthquake",
  "geo.debris-flow",
  "geo.volcano.eruption",
  "safety.national-emergency",
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
 * The prefix of the kinds of the health reports of the core. The state follows it:
 * `system.health.failing`. An adapter does not map a message to this prefix.
 */
export const HEALTH_KIND = "system.health";

/**
 * The prefix of the kinds of the coverage reports of the core. The covered kind follows it:
 * `system.coverage.met.tornado`. An adapter does not map a message to this prefix.
 */
export const COVERAGE_KIND = "system.coverage";

/** The table of the coverage of the kinds that can reach `life-safety`. */
const COVERAGE_TABLE: LevelTable = {
  severity: { extreme: "life-safety", severe: "urgent", moderate: "notice", minor: "digest", unknown: "urgent" },
  urgency: { immediate: "life-safety", expected: "urgent", future: "notice", past: "digest", unknown: "urgent" },
};

/** The table of the other reports of the system. These reports reach `notice` at most. */
const SYSTEM_TABLE: LevelTable = {
  severity: { extreme: "notice", severe: "notice", moderate: "notice", minor: "digest", unknown: "notice" },
  urgency: { immediate: "notice", expected: "notice", future: "digest", past: "digest", unknown: "notice" },
};

/**
 * The first policy. An incident is `life-safety` when its status is `actual` and its kind is in
 * `LIFE_SAFETY_KINDS`. Its severity must be `severe` or `extreme`, and its urgency must be
 * `immediate` or `expected`. A place of the person must be in its areas.
 *
 * The two system classes hold the reports of the core, and they admit only the status `system`. The
 * coverage of a life-safety kind can reach `life-safety`. Each other report of the core reaches
 * `notice` at most. The NWS kinds `system.test` and `system.admin` are not in these classes.
 */
export const DEFAULT_ASSESS_POLICY: AssessPolicy = {
  statuses: ["actual"],
  classes: [
    { id: "life-safety", kinds: LIFE_SAFETY_KINDS, ...LIFE_SAFETY_TABLE },
    { id: "system-coverage", kinds: LIFE_SAFETY_KINDS.map((kind) => `${COVERAGE_KIND}.${kind}`), statuses: ["system"], ...COVERAGE_TABLE },
    { id: "system", kinds: [HEALTH_KIND, COVERAGE_KIND], statuses: ["system"], ...SYSTEM_TABLE },
  ],
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

/** This function gives the first class of the policy with a prefix of a kind, or `undefined`. */
export function classOf(policy: AssessPolicy, kind: string): KindClass | undefined {
  return policy.classes.find((candidate) => hasKind(candidate.kinds, kind));
}

/**
 * This function tells if the policy sends an incident of this status and kind. The class of the kind
 * gives the statuses, else the policy gives them.
 */
export function admits(policy: AssessPolicy, incident: Pick<Incident, "status" | "kind">): boolean {
  return (classOf(policy, incident.kind.code)?.statuses ?? policy.statuses).includes(incident.status);
}

/** This function gives the level of the table for an incident: the lower of its two lookups. */
export function tableLevel(policy: AssessPolicy, incident: Pick<Incident, "kind" | "severity" | "urgency">): TableResult {
  const found = classOf(policy, incident.kind.code);
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
 * It matches by codes, and an area of a watched place covers that place. The tests of polygons and
 * circles with the buffer of a place wait for the home of geography, `@mark1russell7/geo`. Until
 * then, an area with only a shape covers no place.
 */
export function matchPlaces(incident: Pick<Incident, "areas">, places: readonly WatchedPlace[]): PlaceMatch[] {
  const codes = incident.areas.flatMap((area) => (area.type === "code" ? [area] : []));
  const ids = new Set(incident.areas.flatMap((area) => (area.type === "place" ? [area.place] : [])));
  return places.flatMap((place) => {
    const covered = place.codes.filter((code) => codes.some((area) => regionCovers(area, code)));
    return covered.length > 0 || ids.has(place.id) ? [{ place: place.id, codes: covered }] : [];
  });
}

/**
 * This function gives the watches of a person that a subject of an incident matches, in the order
 * of the watches. A watch with no id matches each subject of its system.
 */
export function matchSubjects(incident: Pick<Incident, "about">, watches: readonly SubjectWatch[]): SubjectWatch[] {
  return watches.filter((watch) =>
    incident.about.some((subject) => subject.system === watch.system && (watch.id === undefined || watch.id === subject.id)),
  );
}

/**
 * This function gives the level of an incident for a person, with its reasons. The level is `none`
 * when the incident ended, or when the policy does not send its status for its kind. It is also
 * `none` when the incident has no place and no subject that the person watches.
 *
 * Else the level is the highest level at the matches of the person: each place in the areas, and
 * each watched subject. At each match, the first rule of the person that matches can lower the
 * level of the table. A rule with places does not match a subject.
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
  const subjects = matchSubjects(incident, person.subjects ?? []);
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
  if (!admits(policy, incident)) {
    reasons.push({ kind: "status", status: incident.status });
    return result("none");
  }
  if (matches.length === 0 && subjects.length === 0) {
    reasons.push({ kind: noMatch(incident) });
    return result("none");
  }
  const table = tableLevel(policy, incident);
  reasons.push({ kind: "table", ...table });
  let level: AssessedLevel = "none";
  // The level at one match: the first rule that matches can lower the level of the table.
  const atMatch = (place: PlaceId | undefined): AssessedLevel => {
    const index = person.rules.findIndex(
      (rule) =>
        (rule.places === undefined || (place !== undefined && rule.places.includes(place))) &&
        (rule.kinds === undefined || hasKind(rule.kinds, incident.kind.code)),
    );
    const rule = person.rules[index];
    if (rule === undefined || rank(rule.max) >= rank(table.level)) return table.level;
    reasons.push(place === undefined ? { kind: "rule", index, max: rule.max } : { kind: "rule", place, index, max: rule.max });
    return rule.max;
  };
  for (const match of matches) {
    reasons.push({ kind: "place", place: match.place, codes: match.codes });
    level = higherLevel(level, atMatch(match.place));
  }
  for (const subject of subjects) {
    reasons.push({ kind: "subject", subject });
    level = higherLevel(level, atMatch(undefined));
  }
  return result(level);
}

// The reason when the incident has no place and no subject of the person.
function noMatch(incident: Pick<Incident, "areas" | "about">): "no-place" | "no-subject" | "no-codes" {
  if (incident.areas.some((area) => area.type === "code" || area.type === "place")) return "no-place";
  if (incident.areas.length === 0 && incident.about.length > 0) return "no-subject";
  return "no-codes";
}

// A SAME code: a part digit, two digits of the state and three digits of the county.
const SAME = /^\d{6}$/;

function rank(level: AssessedLevel): number {
  return ASSESSED_LEVELS.indexOf(level);
}

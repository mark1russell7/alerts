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
  Position,
  RegionCode,
  SubjectWatch,
  WatchedPlace,
} from "./contracts.ts";
import { ASSESSED_LEVELS } from "./contracts.ts";
import type { MapShape } from "./map.ts";
import { isShape, shapeDistanceKm } from "./shapes.ts";

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

/**
 * The prefix of the kinds of the quota reports of the core. The stage follows it:
 * `system.quota.reserve`. An adapter does not map a message to this prefix.
 */
export const QUOTA_KIND = "system.quota";

/**
 * The prefix of the kinds of the balance reports of the core. The stage follows it:
 * `system.balance.low`. An adapter does not map a message to this prefix.
 */
export const BALANCE_KIND = "system.balance";

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
 * `LIFE_SAFETY_KINDS`. Its severity must be `severe`, `extreme` or `unknown`, and its urgency must
 * be `immediate`, `expected` or `unknown`. A place of the person must be in its areas.
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
    { id: "system", kinds: [HEALTH_KIND, COVERAGE_KIND, QUOTA_KIND, BALANCE_KIND], statuses: ["system"], ...SYSTEM_TABLE },
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
 * This function tells if a code of an area and a code of a place name regions that meet. The codes
 * must be of one system and equal, with one more rule for SAME (`sameScope`). Thus a SAME code of a
 * state meets each county of that state, and a part of a county meets the full county. The match of
 * the places uses this rule. It is on the safe side: an alert for a part of a region goes to the places
 * of that region.
 */
export function regionCovers(area: RegionCode, place: RegionCode): boolean {
  if (area.system !== place.system) return false;
  if (area.code === place.code) return true;
  return area.system === "same" && sameRelation(area.code, place.code, "meets");
}

/**
 * This function tells if the region of a code of an area holds all of the region of a code of a place.
 * The codes must be of one system and equal, with one more rule for SAME (`sameScope`). The coverage of
 * the sources uses this rule. It is on the safe side: a source of a part of a county does not hide a gap
 * of the full county.
 */
export function regionContains(area: RegionCode, place: RegionCode): boolean {
  if (area.system !== place.system) return false;
  if (area.code === place.code) return true;
  return area.system === "same" && sameRelation(area.code, place.code, "contains");
}

/** A place in the areas of an incident, with the codes or the distance that decided the match. */
export interface PlaceMatch {
  readonly place: PlaceId;
  /** The codes of the place that decided the match. The list is empty for a match by a shape only. */
  readonly codes: readonly RegionCode[];
  /**
   * The great-circle distance in kilometers from the place to the nearest shape that decided. It is 0 in
   * a shape. It is present only when that distance is in the buffer of the place.
   */
  readonly distanceKm?: number;
  /**
   * True when the codes of a block decided the match because `@mark1russell7/geo` refuses each shape of
   * that block. The view shows it, because the shape of that block did not decide.
   */
  readonly shapeRefused?: true;
}

/**
 * This function gives the places that the areas of an incident cover, in the order of the places. One
 * block that matches is enough.
 *
 * - An area of a watched place covers that place.
 * - A block with a shape decides by its shapes for a place with a position. The place matches when the
 *   great-circle distance to the nearest polygon or circle of the block is not more than its buffer. The
 *   codes of that block do not decide for that place.
 * - A block with no shape decides by its codes. So does each block for a place with no position.
 * - When `@mark1russell7/geo` refuses each shape of a block, the codes of the block decide. This is on the
 *   safe side, and the match tells it with `shapeRefused`.
 * - The areas with no block key keep the union rule. Their codes are the floor of the match, and a shape
 *   adds a place in its buffer. A shape that geo refuses adds no place.
 */
export function matchPlaces(incident: Pick<Incident, "areas">, places: readonly WatchedPlace[]): PlaceMatch[] {
  const ids = new Set(incident.areas.flatMap((area) => (area.type === "place" ? [area.place] : [])));
  const groups = new Map<string | undefined, (MapShape | (RegionCode & { readonly type: "code" }))[]>();
  for (const area of incident.areas) {
    if (area.type === "place") continue;
    const group = groups.get(area.block) ?? [];
    group.push(area);
    groups.set(area.block, group);
  }
  return places.flatMap((place): PlaceMatch[] => {
    const covered = new Set<RegionCode>();
    let nearest = Number.POSITIVE_INFINITY;
    let shapeRefused = false;
    for (const [block, areas] of groups) {
      const shapes = areas.filter(isShape);
      const distance = place.at === undefined || shapes.length === 0 ? undefined : nearestShape(shapes, place.at);
      if (distance !== undefined) nearest = Math.min(nearest, distance);
      // A block decides by its shapes when geo reads one of them. The areas with no block always give their codes.
      if (block !== undefined && distance !== undefined) continue;
      const byBlock = place.codes.filter((code) => areas.some((area) => area.type === "code" && regionCovers(area, code)));
      for (const code of byBlock) covered.add(code);
      if (byBlock.length > 0 && block !== undefined && place.at !== undefined && shapes.length > 0) shapeRefused = true;
    }
    const codes = place.codes.filter((code) => covered.has(code));
    const near = nearest <= place.bufferKm;
    if (codes.length === 0 && !near && !ids.has(place.id)) return [];
    return [{ place: place.id, codes, ...(near ? { distanceKm: nearest } : {}), ...(shapeRefused ? { shapeRefused: true as const } : {}) }];
  });
}

// The distance to the nearest shape that geo reads, or `undefined` when geo refuses each shape.
function nearestShape(shapes: readonly MapShape[], at: Position): number | undefined {
  let nearest: number | undefined;
  for (const shape of shapes) {
    const distance = shapeDistanceKm(shape, at);
    if (distance !== undefined) nearest = Math.min(nearest ?? distance, distance);
  }
  return nearest;
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
    reasons.push({ kind: noMatch(incident, watched) });
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
    reasons.push({ kind: "place", ...match });
    level = higherLevel(level, atMatch(match.place));
  }
  for (const subject of subjects) {
    reasons.push({ kind: "subject", subject });
    level = higherLevel(level, atMatch(undefined));
  }
  return result(level);
}

// The reason when the incident has no place and no subject of the person. A shape can match only a
// place with a position.
function noMatch(incident: Pick<Incident, "areas" | "about">, places: readonly WatchedPlace[]): "no-place" | "no-subject" | "no-codes" {
  if (incident.areas.some((area) => area.type === "code" || area.type === "place")) return "no-place";
  if (incident.areas.some(isShape) && places.some((place) => place.at !== undefined)) return "no-place";
  if (incident.areas.length === 0 && incident.about.length > 0) return "no-subject";
  return "no-codes";
}

// A SAME code: a part digit, two digits of the state and three digits of the county.
const SAME = /^\d{6}$/;

/**
 * This function gives the levels of a SAME code `PSSCCC`: the state `SS`, the county `CCC` and the part
 * `P`. `undefined` is all of a level. The part `0` is the full county, the county `000` is the full
 * state, and `000000` is the full country (47 CFR 11.31). A code that is not 6 digits gives `undefined`.
 */
function sameScope(code: string): readonly (string | undefined)[] | undefined {
  if (!SAME.test(code)) return undefined;
  const [part, state, county] = [code.slice(0, 1), code.slice(1, 3), code.slice(3)];
  if (county === "000") return state === "00" ? [undefined, undefined, undefined] : [state, undefined, undefined];
  return [state, county, part === "0" ? undefined : part];
}

/**
 * This function compares the levels of two SAME codes. The first contains the second when each of its
 * levels is all of the level or equal. The two meet when each level is all of the level in one of them,
 * or equal.
 */
function sameRelation(first: string, second: string, relation: "meets" | "contains"): boolean {
  const [outer, inner] = [sameScope(first), sameScope(second)];
  if (outer === undefined || inner === undefined) return false;
  return outer.every((level, at) => level === undefined || level === inner[at] || (relation === "meets" && inner[at] === undefined));
}

function rank(level: AssessedLevel): number {
  return ASSESSED_LEVELS.indexOf(level);
}

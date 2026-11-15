/**
 * The coverage of each kind at each place. It gives the sources that are up, the count of their
 * independent outside failure domains, and the resources of the cell that they share. It is a pure
 * calculation on the descriptors, the health and the places. It reads no clock.
 *
 * `independent` is the size of the smallest set of outside domains whose faults stop each of the
 * sources. That is a minimum hitting set, and `@mark1russell7/collections/graph` calculates it.
 */
import { minimumHittingSet, type HittingSetChoice } from "@mark1russell7/collections/graph";
import { hasKind, LIFE_SAFETY_KINDS, regionCovers } from "./assess.ts";
import type { Coverage, HealthState, SourceDescriptor, SourceHealth, SourceId, WatchedPlace } from "./contracts.ts";
import { CELL_RESOURCES } from "./contracts.ts";

/** The count of independent outside domains that a class of kinds needs. */
export interface CoverageNeed {
  /** The prefixes of the taxonomy codes of the class. */
  readonly kinds: readonly string[];
  readonly required: number;
}

/** The policy of the coverage. */
export interface CoveragePolicy {
  /** The health states in which a source counts for the coverage. */
  readonly up: readonly HealthState[];
  /** The needs of the classes of kinds. The first need whose prefixes have the kind applies. */
  readonly needs: readonly CoverageNeed[];
  /** The count for a kind that no need has. */
  readonly otherwise: number;
  /** The largest count of steps of the search of the hitting set. Absent: the default of the search. */
  readonly maxSteps?: number;
}

/**
 * The first policy. A source counts when it is `healthy` or `slow`. Each life-safety kind needs 2
 * independent domains, so no single outside fault stops it. Each other kind needs 1.
 */
export const DEFAULT_COVERAGE_POLICY: CoveragePolicy = {
  up: ["healthy", "slow"],
  needs: [{ kinds: LIFE_SAFETY_KINDS, required: 2 }],
  otherwise: 1,
};

/** What the coverage needs: the sources, their health, the places and the kinds to examine. */
export interface CoverageInput {
  readonly sources: readonly SourceDescriptor[];
  /** The health of the sources. A source with no health is `unknown`. */
  readonly health: readonly SourceHealth[];
  readonly places: readonly WatchedPlace[];
  /** The taxonomy codes or prefixes to examine at each place. */
  readonly kinds: readonly string[];
}

/**
 * This function tells if a source covers a kind at a place, when the source is up.
 *
 * - One prefix of the source must have the kind. A source of a part of the kind does not count: the
 *   prefix `met.tornado.warning` does not cover the kind `met.tornado`.
 * - The coverage of the source must be `global`, or an area with a code must cover a code of the place.
 * - An area with only a shape covers no place until `@mark1russell7/geo` has the tests.
 */
export function sourceCovers(source: SourceDescriptor, place: WatchedPlace, kind: string): boolean {
  if (!hasKind(source.kinds, kind)) return false;
  if (source.coverage === "global") return true;
  return source.coverage.some((area) => area.type === "code" && place.codes.some((code) => regionCovers(area, code)));
}

/**
 * This function gives the outside failure domains of a source for the coverage. A source with no
 * domain gets its own domain `source:<id>`, so it is independent of each other source.
 */
export function failureDomains(source: SourceDescriptor): readonly string[] {
  return source.dependsOn.length > 0 ? source.dependsOn : [`source:${source.id}`];
}

/** This function gives the count of independent domains that the policy needs for a kind. */
export function requiredFor(policy: CoveragePolicy, kind: string): number {
  return policy.needs.find((need) => hasKind(need.kinds, kind))?.required ?? policy.otherwise;
}

/**
 * This function gives the coverage of each kind at each place, in the order of the places and then
 * of the kinds. The sources of each coverage are in the order of the input.
 */
export function coverage(input: CoverageInput, policy: CoveragePolicy = DEFAULT_COVERAGE_POLICY): Coverage[] {
  const states = new Map<SourceId, HealthState>(input.health.map((entry) => [entry.source, entry.state]));
  const up = input.sources.filter((source) => policy.up.includes(states.get(source.id) ?? "unknown"));
  return input.places.flatMap((place) =>
    input.kinds.map((kind) => coverageOf(place.id, kind, up.filter((source) => sourceCovers(source, place, kind)), requiredFor(policy, kind), policy)),
  );
}

/**
 * This function tells if a coverage is below its policy. A coverage that the search did not prove
 * is also below, because its true count can be smaller.
 */
export function coverageShort(entry: Coverage): boolean {
  return !entry.proven || entry.independent < entry.required;
}

function coverageOf(place: Coverage["place"], kind: string, sources: readonly SourceDescriptor[], required: number, policy: CoveragePolicy): Coverage {
  const search = minimumHittingSet<string>(sources.map(failureDomains), policy.maxSteps === undefined ? {} : { maxSteps: policy.maxSteps });
  // Each set of domains has one or more domains, so the result is never none.
  const found: HittingSetChoice<string> = search.kind === "budget" ? search.best : search.kind === "exact" ? search : { elements: [], weight: 0 };
  const commonResources = CELL_RESOURCES.filter((resource) => sources.length > 0 && sources.every((source) => source.uses.includes(resource)));
  return {
    place,
    kind,
    sources: sources.map((source) => source.id),
    independent: found.elements.length,
    proven: search.kind === "exact",
    faults: found.elements,
    commonResources,
    required,
  };
}

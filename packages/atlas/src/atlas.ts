/**
 * The source atlas of the alert system. The atlas holds each signal class that can touch a person, and
 * the candidate sources of each class. Each source has its access, terms, cost, delay, coverage and a
 * decision with its reason. Each research round has a record of the lists and queries that it searched.
 *
 * The data is in the folder `data`. The functions of this file read the data and check it. The gate of
 * coverage needs 2 or more sources with no risk for each class, or a reason that fewer exist.
 *
 * The id of each class is a code of `TAXONOMY` of the core, and the core holds its plain name and its
 * summary. Thus the system has one id for each kind of signal. The gate also needs a class for each code
 * of the taxonomy, so a new code of an adapter gets its sources in the atlas.
 *
 * Each source names its origins and its path. The cover of a class has layers: the adopted sources, the
 * paths with no shared part, and the origins. Each layer is a measure, not a filter.
 *
 * An origin of a source can hold only in a region. For example, an aggregator of earthquakes gives the solutions
 * of the US networks for the events in the United States. Each region of `regions.json` less its children is one
 * part of the Earth, and the origin layer counts the part with the fewest origins.
 *
 * A parent class counts its sources at each of its leaf codes, and each count takes the leaf code with the
 * most. Thus two sources of two different children are not a pair of the parent.
 *
 * A family is a set of sources of one kind with a public list of members, for example the numbering
 * authorities of the CVE Program. The count of a family measures the sources that exist. The sources that name
 * the family measure the members that the atlas knows.
 */

import {
  categoryOf,
  DIMENSION_IDS,
  isDimensionId,
  knownKind,
  SUBJECT_SYSTEMS,
  TAXONOMY,
  type Category,
  type DimensionId,
  type SubjectKind,
  type SubjectSystem,
} from "@mark1russell7/alerts";
import { compareCodeUnits } from "@mark1russell7/text/order";

/** The ways to get the data of a source. */
export const ACCESS = ["api", "feed", "stream", "file", "page", "push", "email"] as const;
/** One way to get the data of a source. */
export type Access = (typeof ACCESS)[number];
/** The authorization that is necessary to read the data of a source. The value `unknown` means that the research did not find it. */
export const AUTH = ["none", "key", "account", "paid", "partner", "unknown"] as const;
/** One authorization of a source. */
export type Auth = (typeof AUTH)[number];
/** The permission of the terms of a source for one use. */
export const PERMISSIONS = ["allowed", "limited", "forbidden", "unclear"] as const;
/** One permission of the terms of a source. */
export type Permission = (typeof PERMISSIONS)[number];
/** The cost of the data of a source. */
export const COSTS = ["free", "free-tier", "paid", "unknown"] as const;
/** One cost of a source. */
export type Cost = (typeof COSTS)[number];
/**
 * The decision of the atlas for a source.
 *
 * - `adopt`: a source adapter of this repository reads the source.
 * - `plan`: the decision is to write an adapter.
 * - `later`: no adapter is planned at this time. The reason tells why.
 * - `reject`: the system does not use the source.
 */
export const DECISIONS = ["adopt", "plan", "later", "reject"] as const;
/** One decision of the atlas. */
export type Decision = (typeof DECISIONS)[number];
/** The decisions that count in the coverage of a class. */
export const LIVE_DECISIONS: readonly Decision[] = ["adopt", "plan"];

/** The least count of sources of a class, with no reason of a gap. With 2 sources, one source can fail and the class stays live. */
export const MIN_SOURCES = 2;

/** The formats of the public list of the members of a family. */
export const LIST_FORMATS = ["json", "csv", "xml", "html", "git"] as const;
/** One format of a list of members. */
export type ListFormat = (typeof LIST_FORMATS)[number];

/** The kinds of the parts of a path. */
export const PATH_KINDS = ["host", "cdn", "carrier", "provider"] as const;
/** One kind of a part of a path. */
export type PathKind = (typeof PATH_KINDS)[number];
/** The id of an origin or a part of a path that the research did not find. The measures count it apart. */
export const UNKNOWN = "unknown";

/** One origin: the body that issues a signal, for example the NWS. When an origin fails, its sources lose its signals. */
export interface Origin {
  readonly id: string;
  readonly name: string;
  /** The codes that the origin issues, or `null` for each class of the sources that carry it. */
  readonly issues: readonly string[] | null;
  /** The basis of the record. */
  readonly note: string;
}

/**
 * One region of the Earth: a node of the tree of `regions.json`. The root is the whole Earth. The measures take
 * each region less its children as one part of the Earth, so each region holds a part outside its children.
 */
export interface Region {
  readonly id: string;
  readonly name: string;
  /** The region that holds this region, or `null` for the root. */
  readonly parent: string | null;
  /** The basis of the record. */
  readonly note: string;
}

/** The origins of the signals of a source in one region. In the region, they replace the field `origins` of the source. */
export interface RegionalOrigins {
  /** The id of a region of `regions.json` that is not the root. */
  readonly region: string;
  /** The ids of the origins in `origins.json`, or `unknown`. */
  readonly origins: readonly string[];
  /** The basis of the record, for example a measure of the authors of the solutions. */
  readonly note: string;
}

/**
 * One part of the path of a signal. The first part of a path is the host that the adapter reads. A CDN serves
 * a host from its own network. A carrier brings the signal to a host, and a provider operates a host or a carrier.
 *
 * The id of a host is its name. The id of each other part is its kind, a colon and a name, for example
 * `cdn:akamai`. The `dependsOn` of a source descriptor uses the same ids.
 */
export interface PathPart {
  readonly id: string;
  readonly name: string;
  readonly kind: PathKind;
  /** The basis of the record, for example a page or a DNS lookup with its date. */
  readonly note: string;
}

/** One signal class: one kind of signal that can touch a person. */
export interface SignalClass {
  /**
   * The code of the class in `TAXONOMY` of the core, for example `infra.power.outage`. The core gives its
   * plain name and its summary. The parent of the class is the longest prefix of the id that is a class.
   * `parentOf` gives it.
   */
  readonly id: string;
  /** The kinds of subject that a signal of the class can have. */
  readonly subjectKinds: readonly SubjectKind[];
  /** Real examples of the signal. */
  readonly examples: readonly string[];
  /** The lists, products and studies that name the class. */
  readonly references: readonly string[];
  /** The reason that the class has fewer than `MIN_SOURCES` sources with no risk, or `null`. */
  readonly gap: string | null;
  /** The research round that added the class. */
  readonly round: number;
}

/** The terms of a source for automated reading and for redistribution. */
export interface Terms {
  /** The page of the terms, or `null` when the research found none. */
  readonly url: string | null;
  readonly automated: Permission;
  readonly redistribution: Permission;
  readonly note: string;
}

/** One candidate source of one or more classes. */
export interface Source {
  readonly id: string;
  readonly name: string;
  /** The classes that the source gives events of. A source of indicators only has no class. */
  readonly classes: readonly string[];
  /**
   * The dimensions of the indicators of the source: the ids of `DIMENSIONS` of the core. Each measure of the
   * descriptor of the source has one of them. Absent: the source gives only events.
   */
  readonly dimensions?: readonly DimensionId[];
  /** The page of the documentation. */
  readonly url: string;
  readonly access: Access;
  readonly auth: Auth;
  readonly terms: Terms;
  readonly cost: Cost;
  /** The usual time from the event to the data, as text, or `unknown`. */
  readonly delay: string;
  /** The time span of the past data that the source keeps, as text, or `unknown`. */
  readonly history: string;
  /** The published limit of requests, as text, or `unknown`. */
  readonly rateLimit: string;
  /** A published measure of the accuracy of the signals, for example a Brier score, or `null`. */
  readonly calibration: string | null;
  /** The places and the subjects that the source covers. */
  readonly coverage: string;
  /** The systems of the public subject ids that the signals give, or `null` when the research did not record them. */
  readonly subjectIds: readonly SubjectSystem[] | null;
  /** The ids of the origins of the signals in `origins.json`, or `unknown`. */
  readonly origins: readonly string[];
  /**
   * The origins of the signals in some regions, when they are not `origins`. A part of the Earth gets the entry of
   * the smallest region that holds it. The field `origins` holds in the rest of the Earth.
   */
  readonly regionalOrigins?: readonly RegionalOrigins[];
  /** The path from the origin to the adapter: the ids of `paths.json`, the host first, or `unknown`. */
  readonly path: readonly string[];
  /** Each known event that can stop the source. The coverage does not count a source with a risk. */
  readonly risks: readonly string[];
  readonly decision: Decision;
  /** The package of the adapter for an `adopt` decision, else `null`. */
  readonly adapter: string | null;
  /** The reason of the decision. */
  readonly reason: string;
  /** Each page that the research opened for this record. An adopted or planned source needs one or more. */
  readonly evidence: readonly string[];
  /** The research round that added or last changed the record. */
  readonly round: number;
  /** The ids of the families in `families.json` that the source is a member of. Absent: the source is in no family. */
  readonly families?: readonly string[];
}

/** The public list of the members of a family. */
export interface MemberList {
  readonly url: string;
  readonly format: ListFormat;
}

/**
 * One family of sources: the sources of one kind with a public list of members. The atlas does not hold a
 * record of each member. The count gives the size of the family on one date.
 */
export interface Family {
  readonly id: string;
  readonly name: string;
  /** The classes that the members give events of. */
  readonly classes: readonly string[];
  /** The rule that makes a source a member, in one sentence. */
  readonly memberRule: string;
  readonly list: MemberList;
  /** The members on the list at the date `countAt`, or `null` when the research did not count them. */
  readonly count: number | null;
  /** The local date of the count, `YYYY-MM-DD`, or `null` when `count` is `null`. */
  readonly countAt: string | null;
  /** The usual formats of the data of the members, for example `csaf` or `rss`. */
  readonly formats: readonly string[];
  /** The basis of the record and the method of the count. */
  readonly note: string;
  /** Each page that the research opened for this record. */
  readonly evidence: readonly string[];
  /** The research round that added or last changed the record. */
  readonly round: number;
}

/** One study that a round read, for example a study of the lead time of a signal. */
export interface Study {
  readonly title: string;
  readonly url: string;
  readonly finding: string;
  /** This value is `false` when the round did not open the study and read the finding only in search results. */
  readonly verified: boolean;
}

/**
 * The layers of the cover of a class, from the adopted sources with no risk. No layer replaces another
 * one, and a shared origin or path does not remove a source from a layer.
 */
export interface Layers {
  /** The adopted sources with no risk. */
  readonly adopted: number;
  /** The most of these sources with a known path and no shared part of a path. */
  readonly paths: number;
  /** The known origins of these sources that issue the class, in the part of the Earth with the fewest. */
  readonly origins: number;
}

/** The names of the layers, in order. */
export const LAYERS: readonly (keyof Layers)[] = ["adopted", "paths", "origins"];

/**
 * The measures of the atlas at one time. The gap count measures the research and the plans. The layers
 * measure the signals that reach a person at this time.
 */
export interface Measures {
  readonly classes: number;
  /** The classes with fewer than `MIN_SOURCES` adopted or planned sources with no risk. */
  readonly gaps: number;
  /** For each layer, the classes with `MIN_SOURCES` or more. */
  readonly cover: Layers;
  /** For each layer, the sum over the classes. It shows each gain above `MIN_SOURCES`. */
  readonly total: Layers;
  /** The sources that are not rejected, with an unknown origin. This is a gap of the research, not of the cover. */
  readonly unknownOrigins: number;
  /** The sources that are not rejected, with an unknown part of the path. */
  readonly unknownPaths: number;
  /**
   * The dimensions of indicators with `MIN_SOURCES` or more adopted or planned sources with no risk. The
   * records of the rounds before round 10 do not have this measure.
   */
  readonly dimensions?: number;
  /** The records of families. The records of the rounds before round 15 do not have this measure. */
  readonly families?: number;
  /**
   * The sum of the counts of the families. A source in two families counts two times, so this measure is the
   * size of the lists, not of a set. The records of the rounds before round 15 do not have this measure.
   */
  readonly members?: number;
}

/** The measures that a round records, with the cause of the change from the record before. */
export interface RoundMeasures extends Measures {
  /** The cause tells a gain of research or of the class list from a gain of delivery. Only a new adapter adds delivery. */
  readonly cause: string;
}

/** The record of one research round. */
export interface Round {
  readonly round: number;
  /** The local date of the round, `YYYY-MM-DD`. */
  readonly date: string;
  /** The agents or the persons that did the round. */
  readonly by: string;
  readonly method: string;
  /** The reference lists, catalogs and products that the round searched. */
  readonly lists: readonly string[];
  /** The search queries of the round. */
  readonly queries: readonly string[];
  readonly notes: readonly string[];
  readonly studies: readonly Study[];
  /** The measures of the atlas at the end of the round. Each layer of the atlas stays at or above the measure of the latest round. */
  readonly measures: RoundMeasures;
}

/** The whole atlas. */
export interface Atlas {
  readonly classes: readonly SignalClass[];
  readonly sources: readonly Source[];
  readonly rounds: readonly Round[];
  readonly origins: readonly Origin[];
  readonly paths: readonly PathPart[];
  /** The tree of the regions. An empty list is the whole Earth as one part. */
  readonly regions: readonly Region[];
  /** The families of sources. */
  readonly families: readonly Family[];
}

/** One problem of the atlas. */
export interface AtlasProblem {
  /** The record, for example `class infra.power.outage` or `source eia-930`. */
  readonly at: string;
  readonly problem: string;
}

/**
 * The coverage of one class. The lists hold each source of the class and of its descendants. The counts
 * take the leaf code of the class with the most sources, so they count only sources that reach one code.
 */
export interface Coverage {
  readonly id: string;
  /** The sources of the class and of its descendants, with a decision of `LIVE_DECISIONS`. */
  readonly sources: readonly string[];
  /** The sources of `sources` with one or more risks. The gate does not count them. */
  readonly atRisk: readonly string[];
  /** The sources of `sources` with the decision `adopt`: an adapter of the repository reads them at this time. */
  readonly adopted: readonly string[];
  /** The most sources of `sources` with no risk at one leaf code of the class. The gate compares it with `MIN_SOURCES`. */
  readonly shared: number;
  /** For each layer, the most at one leaf code of the class. */
  readonly layers: Layers;
  readonly gap: string | null;
}

/**
 * The claim of the atlas for two sources of a shared class: the origins and the parts of a path that they
 * share. A shared origin or part is a claim that the two fail together. The claim can be wrong, and the
 * joint outages in the health log can test it.
 */
export interface PairClaim {
  readonly a: string;
  readonly b: string;
  /** The classes whose cover counts the two sources: the two sources reach one leaf code of each. */
  readonly classes: readonly string[];
  readonly origins: readonly string[];
  readonly path: readonly string[];
}

/** The facts of the repository that the gate compares with the atlas. */
export interface AtlasContext {
  /** The names of the packages of the workspace. Each adapter must be one of them. */
  readonly packages?: ReadonlySet<string>;
  /** The codes that the atlas must reach, for example the codes of `TAXONOMY`. `unreachedCodes` tells the rule. */
  readonly codes?: Iterable<string>;
}

/**
 * The categories of the codes that need no class: the messages of the system about itself, and the
 * unknown kind. No outside source gives a signal of them.
 */
export const EXEMPT_CATEGORIES: readonly Category[] = ["system", "other"];

const ID = /^[a-z][a-z0-9]*(\.[a-z0-9]+(-[a-z0-9]+)*)+$/;
const SOURCE_ID = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const PART_ID = /^([a-z]+:)?[a-z0-9]+([.-][a-z0-9]+)*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SUBJECT_KINDS: ReadonlySet<string> = new Set(Object.values(SUBJECT_SYSTEMS));

const isUrl = (text: string): boolean => {
  try {
    const { protocol } = new URL(text);
    return protocol === "https:" || protocol === "http:";
  } catch {
    return false;
  }
};

const isUnder = (name: string, id: string): boolean => name === id || name.startsWith(`${id}.`);
// The ancestors of a code: for `a.b.c` they are `a` and `a.b`.
const ancestors = (code: string): string[] => code.split(".").slice(0, -1).map((_, index, parts) => parts.slice(0, index + 1).join("."));
// A source reaches a leaf code of a class through one of its classes: the class, the leaf code or a code between them.
const reachesLeaf = (source: Pick<Source, "classes">, id: string, leaf: string): boolean => source.classes.some((name) => isUnder(name, id) && isUnder(leaf, name));
const known =(list: readonly string[]): string[] => list.filter((id) => id !== UNKNOWN);
// The JSON of a source is not parsed by a schema. A source with no list counts as a source with an unknown list.
const listOf = (list: readonly string[] | undefined): readonly string[] => list ?? [UNKNOWN];
// The measures skip a regional entry with no region, no list of origins or no note. The gate tells of it.
const isEntry = (value: unknown): value is RegionalOrigins => {
  const entry = value as Partial<RegionalOrigins> | null;
  return typeof value === "object" && entry !== null && typeof entry.region === "string" && Array.isArray(entry.origins) && typeof entry.note === "string";
};
const entriesOf = (source: { readonly regionalOrigins?: unknown }): RegionalOrigins[] =>
  Array.isArray(source.regionalOrigins) ? (source.regionalOrigins as unknown[]).filter(isEntry) : [];
// Each origin that a source names, in each region.
const allOrigins = (source: Pick<Source, "origins" | "regionalOrigins">): string[] => [
  ...new Set([...listOf(source.origins), ...entriesOf(source).flatMap((entry) => entry.origins)]),
];
const parentsOf = (regions: readonly Region[]): Map<string, string | null> => new Map(regions.map((region) => [region.id, region.parent]));
// The walk up the tree stops at a region that it saw before, so a cycle of parents does not stop the measures.
const originsWithin = (source: Pick<Source, "origins" | "regionalOrigins">, region: string | null, parents: ReadonlyMap<string, string | null>): readonly string[] => {
  const entries = entriesOf(source);
  const seen = new Set<string>();
  for (let at = region; at !== null && !seen.has(at); at = parents.get(at) ?? null) {
    seen.add(at);
    const entry = entries.find((each) => each.region === at);
    if (entry !== undefined) return entry.origins;
  }
  return listOf(source.origins);
};
// A region reaches the root when its chain of parents has no cycle. A lost parent ends the chain, and the gate tells of it apart.
const reachesRoot = (id: string, parents: ReadonlyMap<string, string | null>): boolean => {
  const seen = new Set<string>();
  for (let at: string | null | undefined = id; at !== null && at !== undefined; at = parents.get(at)) {
    if (seen.has(at)) return false;
    seen.add(at);
  }
  return true;
};

/**
 * This function gives the origins of a source in a region. The entry of the region or of the nearest region that
 * holds it gives them. With no entry, the field `origins` gives them.
 */
export function originsAt(source: Pick<Source, "origins" | "regionalOrigins">, region: string, regions: readonly Region[]): readonly string[] {
  return originsWithin(source, region, parentsOf(regions));
}

/**
 * This function gives the most sets of the list with no shared item. The search is exact. A class has few
 * adopted sources, so the cost stays small.
 */
export function mostDisjoint(sets: readonly (readonly string[])[]): number {
  const [first, ...rest] = sets;
  if (first === undefined) return 0;
  const apart = rest.filter((other) => !other.some((item) => first.includes(item)));
  const withFirst = 1 + mostDisjoint(apart);
  return withFirst >= rest.length ? withFirst : Math.max(withFirst, mostDisjoint(rest));
}

/** This function gives the parent of a class: the longest prefix of its id that is a class, or `null`. */
export function parentOf(id: string, classIds: ReadonlySet<string>): string | null {
  const parts = id.split(".");
  for (let end = parts.length - 1; end >= 2; end--) {
    const prefix = parts.slice(0, end).join(".");
    if (classIds.has(prefix)) return prefix;
  }
  return null;
}

/**
 * This function gives each code that no class reaches, sorted. A class reaches a code when the class is the
 * code, an ancestor of it or a descendant of it. The codes of `EXEMPT_CATEGORIES` need no class.
 */
export function unreachedCodes(classes: readonly Pick<SignalClass, "id">[], codes: Iterable<string> = Object.keys(TAXONOMY)): string[] {
  const ids = classes.map((item) => item.id);
  const reached = (code: string): boolean => ids.some((id) => isUnder(id, code) || isUnder(code, id));
  return [...new Set(codes)].filter((code) => !EXEMPT_CATEGORIES.includes(categoryOf(code)) && !reached(code)).sort(compareCodeUnits);
}

/**
 * This function gives the leaf codes of a class, sorted: each code of the list under the class with no code
 * under it. A class with no code under it is its own leaf code.
 */
export function leafCodes(id: string, codes: Iterable<string> = Object.keys(TAXONOMY)): string[] {
  const list = [...new Set(codes)];
  const inner = new Set(list.flatMap(ancestors));
  const leaves = list.filter((code) => isUnder(code, id) && !inner.has(code)).sort(compareCodeUnits);
  return leaves.length > 0 ? leaves : [id];
}

/**
 * This function gives the block that stops a decision of `adopt` or `plan` for a source, or `null`.
 * A live source needs an auth of none, key or account, a cost of free or free-tier, and terms that do
 * not forbid automated reading. The terms of a page source must also let automated reading, with or without limits.
 */
export function planBlock(source: Pick<Source, "access" | "auth" | "cost" | "terms">): string | null {
  if (!["none", "key", "account"].includes(source.auth)) return `the auth is ${source.auth}`;
  if (!["free", "free-tier"].includes(source.cost)) return `the cost is ${source.cost}`;
  if (source.terms.automated === "forbidden") return "the terms forbid automated reading";
  if (source.access === "page" && !["allowed", "limited"].includes(source.terms.automated)) return "a page source needs terms that let automated reading";
  return null;
}

// The leaf codes of each class of the atlas. The codes are the taxonomy and the class ids.
const leavesOfClasses = (atlas: Atlas): Map<string, string[]> => {
  const codes = [...Object.keys(TAXONOMY), ...atlas.classes.map((item) => item.id)];
  return new Map(atlas.classes.map(({ id }) => [id, leafCodes(id, codes)]));
};

/**
 * This function gives the coverage of each class: the adopted and planned sources of the class and of its
 * descendants, and the counts. Each count is the most at one leaf code of the class. At a leaf code, the origin
 * count is the fewest in one part of the Earth.
 */
export function coverage(atlas: Atlas): Coverage[] {
  const origins = new Map(atlas.origins.map((origin) => [origin.id, origin]));
  const parents = parentsOf(atlas.regions);
  // Each region less its children is one part of the Earth. With no region, the whole Earth is one part.
  const earthParts: readonly (string | null)[] = atlas.regions.length > 0 ? atlas.regions.map((region) => region.id) : [null];
  const leaves = leavesOfClasses(atlas);
  return atlas.classes.map(({ id, gap }) => {
    const live = atlas.sources.filter((source) => LIVE_DECISIONS.includes(source.decision) && source.classes.some((name) => isUnder(name, id)));
    const ids = (list: readonly Source[]): string[] => list.map((source) => source.id);
    const at = (leaf: string): { shared: number; layers: Layers } => {
      const here = live.filter((source) => reachesLeaf(source, id, leaf));
      const counted = here.filter((source) => source.decision === "adopt" && source.risks.length === 0);
      const issues = (origin: string): boolean => {
        const issued = origins.get(origin)?.issues;
        return issued === null || (issued !== undefined && issued.some((code) => isUnder(leaf, code) || isUnder(code, leaf)));
      };
      // A path with an unknown part cannot show that it is apart, so the path layer does not count it.
      const knownPaths = counted.map((source) => listOf(source.path)).filter((path) => !path.includes(UNKNOWN));
      const originsIn = (part: string | null): number => new Set(counted.flatMap((source) => originsWithin(source, part, parents).filter(issues))).size;
      return {
        shared: here.filter((source) => source.risks.length === 0).length,
        layers: { adopted: counted.length, paths: mostDisjoint(knownPaths), origins: Math.min(...earthParts.map(originsIn)) },
      };
    };
    const counts = (leaves.get(id) ?? [id]).map(at);
    const most = (pick: (count: { shared: number; layers: Layers }) => number): number => Math.max(0, ...counts.map(pick));
    return {
      id,
      sources: ids(live),
      atRisk: ids(live.filter((source) => source.risks.length > 0)),
      adopted: ids(live.filter((source) => source.decision === "adopt")),
      shared: most((count) => count.shared),
      layers: {
        adopted: most((count) => count.layers.adopted),
        paths: most((count) => count.layers.paths),
        origins: most((count) => count.layers.origins),
      },
      gap,
    };
  });
}

/**
 * This function gives the claim of each pair of sources that reach one leaf code of a class, for the
 * sources of the decisions. The measures do not remove a source because of a claim.
 */
export function pairClaims(atlas: Atlas, decisions: readonly Decision[] = LIVE_DECISIONS): PairClaim[] {
  const chosen = atlas.sources.filter((source) => decisions.includes(source.decision));
  const leaves = leavesOfClasses(atlas);
  const claims: PairClaim[] = [];
  for (const [index, a] of chosen.entries()) {
    for (const b of chosen.slice(index + 1)) {
      const both = (id: string, leaf: string): boolean => reachesLeaf(a, id, leaf) && reachesLeaf(b, id, leaf);
      const classes = atlas.classes.filter(({ id }) => (leaves.get(id) ?? [id]).some((leaf) => both(id, leaf))).map(({ id }) => id);
      if (classes.length === 0) continue;
      const shared = (pick: (source: Source) => readonly string[] | undefined): string[] => known(listOf(pick(a))).filter((id) => listOf(pick(b)).includes(id));
      claims.push({ a: a.id, b: b.id, classes, origins: shared(allOrigins), path: shared((source) => source.path) });
    }
  }
  return claims;
}

/** This function gives the measures of the atlas: the classes, the gaps, the cover and the total of each layer, and the unknowns. */
export function measures(atlas: Atlas): Measures {
  const rows = coverage(atlas);
  const per =(pick: (value: number) => number): Layers => {
    const sum = (name: keyof Layers): number => rows.reduce((total, row) => total + pick(row.layers[name]), 0);
    return { adopted: sum("adopted"), paths: sum("paths"), origins: sum("origins") };
  };
  const kept = atlas.sources.filter((source) => source.decision !== "reject");
  return {
    classes: rows.length,
    gaps: rows.filter((row) => row.shared < MIN_SOURCES).length,
    cover: per((value) => (value >= MIN_SOURCES ? 1 : 0)),
    total: per((value) => value),
    unknownOrigins: kept.filter((source) => allOrigins(source).includes(UNKNOWN)).length,
    unknownPaths: kept.filter((source) => listOf(source.path).includes(UNKNOWN)).length,
    dimensions: dimensionCoverage(atlas).filter((row) => row.sources.length >= MIN_SOURCES).length,
    families: atlas.families.length,
    members: atlas.families.reduce((total, family) => total + (family.count ?? 0), 0),
  };
}

/** The members of one family that the atlas knows. */
export interface FamilyCoverage {
  readonly id: string;
  /** The members on the public list, or `null` when the research did not count them. */
  readonly count: number | null;
  /** The ids of the sources that name the family, with each decision. */
  readonly sources: readonly string[];
  /** The ids of the adopted and planned sources of `sources` with no risk. */
  readonly live: readonly string[];
}

/** This function gives the sources of each family, in the order of `families.json`. */
export function familyCoverage(atlas: Atlas): FamilyCoverage[] {
  return atlas.families.map((family) => {
    const sources = atlas.sources.filter((source) => source.families?.includes(family.id) === true);
    const live = sources.filter((source) => LIVE_DECISIONS.includes(source.decision) && source.risks.length === 0);
    return { id: family.id, count: family.count, sources: sources.map((source) => source.id), live: live.map((source) => source.id) };
  });
}

/** The live sources of one dimension of indicators. */
export interface DimensionCoverage {
  readonly id: DimensionId;
  /** The ids of the adopted and planned sources of the dimension with no risk. */
  readonly sources: readonly string[];
}

/** This function gives the adopted and planned sources with no risk of each dimension of the core, in the order of `DIMENSIONS`. */
export function dimensionCoverage(atlas: Atlas): DimensionCoverage[] {
  const live = atlas.sources.filter((source) => LIVE_DECISIONS.includes(source.decision) && source.risks.length === 0);
  return DIMENSION_IDS.map((id) => ({ id, sources: live.filter((source) => source.dimensions?.includes(id) === true).map((source) => source.id) }));
}

/** This function gives each problem of the atlas. An empty list is a pass of the gate. */
export function checkAtlas(atlas: Atlas, context: AtlasContext = {}): AtlasProblem[] {
  const problems: AtlasProblem[] = [];
  const add = (at: string, problem: string): void => void problems.push({ at, problem });
  const rounds = new Set(atlas.rounds.map((round) => round.round));
  for (const round of atlas.rounds) {
    const at = `round ${String(round.round)}`;
    if (!DATE.test(round.date)) add(at, `the date ${round.date} is not YYYY-MM-DD`);
    if (round.lists.length === 0 && round.queries.length === 0) add(at, "the round has no list and no query");
    for (const study of round.studies) if (study.title.trim() === "" || !isUrl(study.url)) add(at, `the study "${study.title}" has no title or no http or https URL`);
    // The JSON of a round is not parsed by a schema, so the gate reports a round with no measures.
    const recorded = (round as Partial<Round>).measures;
    if (recorded === undefined) add(at, "the round has no measures");
    else {
      const layered = (group: Layers | undefined): unknown[] => LAYERS.map((name) => group?.[name]);
      const optional = [recorded.dimensions, recorded.families, recorded.members].filter((value) => value !== undefined);
      const values = [recorded.classes, recorded.gaps, ...layered(recorded.cover), ...layered(recorded.total), recorded.unknownOrigins, recorded.unknownPaths, ...optional];
      for (const value of values) if (!Number.isSafeInteger(value) || (value as number) < 0) add(at, `the measure ${String(value)} is not a count`);
      if (typeof recorded.cause !== "string" || recorded.cause.trim() === "") add(at, "the measures have no cause");
    }
  }
  if (rounds.size !== atlas.rounds.length) add("atlas", "two records of rounds have one number");
  // Each layer is an outcome. Its floor is the measure of the latest round. Thus a real loss of a
  // source needs a new round whose cause names the loss, and no record of an old round changes.
  const latest = atlas.rounds.reduce<Round | undefined>((last, round) => (last === undefined || round.round > last.round ? round : last), undefined);
  const originIds = new Set<string>();
  for (const origin of atlas.origins) {
    const at = `origin ${origin.id}`;
    if (originIds.has(origin.id)) add(at, "the id is not unique");
    originIds.add(origin.id);
    if (!PART_ID.test(origin.id) || origin.id === UNKNOWN) add(at, "the id is not in lower case with hyphens and dots, or it is unknown");
    if (origin.name.trim() === "" || origin.note.trim() === "") add(at, "the origin has no name or no note");
    for (const code of origin.issues ?? []) if (!knownKind(code)) add(at, `the code ${code} is not in the taxonomy`);
  }
  const regions = new Map<string, Region>();
  for (const region of atlas.regions) {
    const at = `region ${region.id}`;
    if (regions.has(region.id)) add(at, "the id is not unique");
    regions.set(region.id, region);
    if (!PART_ID.test(region.id) || region.id === UNKNOWN) add(at, "the id is not in lower case with hyphens and dots, or it is unknown");
    if (region.name.trim() === "" || region.note.trim() === "") add(at, "the region has no name or no note");
  }
  const roots = atlas.regions.filter((region) => region.parent === null).length;
  if (atlas.regions.length > 0 && roots !== 1) add("regions", `the tree has ${String(roots)} roots, not 1`);
  const parents = parentsOf(atlas.regions);
  for (const region of regions.values()) {
    const at = `region ${region.id}`;
    if (region.parent !== null && !regions.has(region.parent)) add(at, `the parent ${region.parent} is not a region`);
    else if (!reachesRoot(region.id, parents)) add(at, "the chain of parents of the region has a cycle");
  }
  const parts = new Map<string, PathPart>();
  for (const part of atlas.paths) {
    const at = `path ${part.id}`;
    if (parts.has(part.id)) add(at, "the id is not unique");
    parts.set(part.id, part);
    if (!PART_ID.test(part.id) || part.id === UNKNOWN) add(at, "the id is not in lower case with hyphens and dots, or it is unknown");
    if (!(PATH_KINDS as readonly string[]).includes(part.kind)) add(at, `the kind ${part.kind} is not known`);
    else if (part.kind === "host" && part.id.includes(":")) add(at, "the id of a host has no prefix");
    else if (part.kind !== "host" && !part.id.startsWith(`${part.kind}:`)) add(at, `the id of a part of the kind ${part.kind} starts with ${part.kind}:`);
    if (part.name.trim() === "" || part.note.trim() === "") add(at, "the part has no name or no note");
  }
  // The JSON of a source is not parsed by a schema, so the gate reads the layers only when each source has its lists.
  const listed = atlas.sources.every((source) => Array.isArray(source.origins) && Array.isArray(source.path));
  if (listed) {
    const named = (pick: (source: Source) => readonly string[]): Set<string> => new Set(atlas.sources.flatMap(pick));
    const usedOrigins = named(allOrigins);
    const usedRegions = named((source) => entriesOf(source).map((entry) => entry.region));
    for (const region of regions.values()) if (region.parent !== null && !usedRegions.has(region.id)) add(`region ${region.id}`, "no source names the region");
    const usedParts = named((source) => source.path);
    for (const id of originIds) if (!usedOrigins.has(id)) add(`origin ${id}`, "no source names the origin");
    for (const id of parts.keys()) if (!usedParts.has(id)) add(`path ${id}`, "no source names the part");
    const now = measures(atlas);
    for (const group of ["cover", "total"] as const) {
      for (const name of LAYERS) {
        const floor = (latest as Partial<Round> | undefined)?.measures?.[group]?.[name] ?? 0;
        if (latest !== undefined && now[group][name] < floor) {
          add("atlas", `the ${group} of the layer ${name} is ${String(now[group][name])}, below the ${String(floor)} of round ${String(latest.round)}`);
        }
      }
    }
    const dimensionFloor = (latest as Partial<Round> | undefined)?.measures?.dimensions ?? 0;
    if (latest !== undefined && (now.dimensions ?? 0) < dimensionFloor) {
      add("atlas", `${String(now.dimensions ?? 0)} dimensions have ${String(MIN_SOURCES)} live sources, below the ${String(dimensionFloor)} of round ${String(latest.round)}`);
    }
    // A list of an outside body can become shorter. Then a new round records the count and names the cause.
    for (const name of ["families", "members"] as const) {
      const floor = (latest as Partial<Round> | undefined)?.measures?.[name] ?? 0;
      if (latest !== undefined && (now[name] ?? 0) < floor) add("atlas", `the ${name} measure is ${String(now[name] ?? 0)}, below the ${String(floor)} of round ${String(latest.round)}`);
    }
  }
  const classIds = new Set(atlas.classes.map((item) => item.id));
  const familyIds = new Set<string>();
  for (const family of atlas.families) {
    const at = `family ${family.id}`;
    if (familyIds.has(family.id)) add(at, "the id is not unique");
    familyIds.add(family.id);
    if (!SOURCE_ID.test(family.id)) add(at, "the id is not in lower case with hyphens");
    if (family.name.trim() === "" || family.memberRule.trim() === "" || family.note.trim() === "") add(at, "the family has no name, no rule of a member or no note");
    if (family.classes.length === 0) add(at, "the family has no class");
    for (const id of family.classes) if (!classIds.has(id)) add(at, `the class ${id} is not a class of the atlas`);
    if (!isUrl(family.list.url)) add(at, "the url of the list is not an http or https URL");
    if (!(LIST_FORMATS as readonly string[]).includes(family.list.format)) add(at, `the format ${family.list.format} of the list is not known`);
    if (family.count === null ? family.countAt !== null : !Number.isSafeInteger(family.count) || family.count < 0 || family.countAt === null || !DATE.test(family.countAt)) {
      add(at, "the count is not a count with a date YYYY-MM-DD, or a date has no count");
    }
    if (family.evidence.length === 0) add(at, "the family has no evidence");
    for (const url of family.evidence) if (!isUrl(url)) add(at, `the evidence ${url} is not an http or https URL`);
    if (!rounds.has(family.round)) add(at, `the round ${String(family.round)} has no record`);
  }
  for (const source of atlas.sources) {
    const named: unknown = (source as Partial<Source>).families;
    if (named === undefined) continue;
    const at = `source ${source.id}`;
    if (!Array.isArray(named) || named.length === 0) add(at, "the field families has no id: give one or more, or no field");
    else {
      if (new Set(named).size !== named.length) add(at, "the families have a duplicate");
      for (const id of named as string[]) if (!familyIds.has(id)) add(at, `the family ${id} is not in families.json`);
    }
  }
  const seenClasses = new Set<string>();
  for (const item of atlas.classes) {
    const at = `class ${item.id}`;
    if (seenClasses.has(item.id)) add(at, "the id is not unique");
    seenClasses.add(item.id);
    if (!ID.test(item.id)) add(at, "the id is not a dotted id in lower case");
    if (!knownKind(item.id)) add(at, "the id is not a code of the taxonomy of the core");
    if (item.subjectKinds.length === 0) add(at, "the class has no subject kind");
    for (const kind of item.subjectKinds) if (!SUBJECT_KINDS.has(kind)) add(at, `the subject kind ${kind} is not known`);
    if (!rounds.has(item.round)) add(at, `the round ${String(item.round)} has no record`);
  }
  const sourceIds = new Set<string>();
  for (const source of atlas.sources) {
    const at = `source ${source.id}`;
    if (sourceIds.has(source.id)) add(at, "the id is not unique");
    sourceIds.add(source.id);
    if (!SOURCE_ID.test(source.id)) add(at, "the id is not in lower case with hyphens");
    const dimensions = source.dimensions;
    if (source.classes.length === 0 && dimensions === undefined) add(at, "the source has no class and no dimension");
    if (dimensions !== undefined) {
      if (!Array.isArray(dimensions) || dimensions.length === 0) add(at, "the field dimensions has no id: give one or more, or no field");
      else {
        if (new Set(dimensions).size !== dimensions.length) add(at, "the dimensions have a duplicate");
        for (const id of dimensions) if (!isDimensionId(id)) add(at, `the dimension ${String(id)} is not in DIMENSIONS of the core`);
      }
    }
    for (const name of source.classes) if (!classIds.has(name)) add(at, `the class ${name} is not in the atlas`);
    if (!isUrl(source.url)) add(at, "the url is not an http or https URL");
    if (source.terms.url !== null && !isUrl(source.terms.url)) add(at, "the url of the terms is not an http or https URL");
    if (!(ACCESS as readonly string[]).includes(source.access)) add(at, `the access ${source.access} is not known`);
    if (!(AUTH as readonly string[]).includes(source.auth)) add(at, `the auth ${source.auth} is not known`);
    if (!(COSTS as readonly string[]).includes(source.cost)) add(at, `the cost ${source.cost} is not known`);
    if (!(DECISIONS as readonly string[]).includes(source.decision)) add(at, `the decision ${source.decision} is not known`);
    for (const value of [source.terms.automated, source.terms.redistribution]) if (!(PERMISSIONS as readonly string[]).includes(value)) add(at, `the permission ${value} is not known`);
    if (source.reason.trim() === "") add(at, "the decision has no reason");
    if (LIVE_DECISIONS.includes(source.decision)) {
      const block = planBlock(source);
      if (block !== null) add(at, `the decision ${source.decision} has a block: ${block}`);
    }
    if (source.decision === "adopt" && source.adapter === null) add(at, "an adopted source has no adapter");
    if (source.decision !== "adopt" && source.adapter !== null) add(at, "only an adopted source has an adapter");
    if (source.adapter !== null && context.packages !== undefined && !context.packages.has(source.adapter)) add(at, `the adapter ${source.adapter} is not a package of the workspace`);
    if (source.decision === "adopt" && source.subjectIds === null) add(at, "an adopted source has no subject ids");
    for (const system of source.subjectIds ?? []) if (!Object.hasOwn(SUBJECT_SYSTEMS, system)) add(at, `the subject id ${system} is not a system of the core`);
    for (const risk of source.risks) if (risk.trim() === "") add(at, "a risk is empty");
    if (LIVE_DECISIONS.includes(source.decision) && source.evidence.length === 0) add(at, "an adopted or planned source has no evidence");
    for (const url of source.evidence) if (!isUrl(url)) add(at, `the evidence ${url} is not an http or https URL`);
    if (!rounds.has(source.round)) add(at, `the round ${String(source.round)} has no record`);
    const regional: unknown = (source as Partial<Source>).regionalOrigins;
    const entries = entriesOf(source);
    if (regional !== undefined && (!Array.isArray(regional) || entries.length !== regional.length)) add(at, "each regional origin needs a region, a list of origins and a note");
    const seenRegions = new Set<string>();
    for (const entry of entries) {
      if (seenRegions.has(entry.region)) add(at, `the region ${entry.region} has two entries`);
      seenRegions.add(entry.region);
      const region = regions.get(entry.region);
      if (region === undefined) add(at, `the region ${entry.region} is not a region of the tree`);
      else if (region.parent === null) add(at, `the region ${entry.region} is the root: give its origins in the field origins`);
      if (entry.note.trim() === "") add(at, `the entry of the region ${entry.region} has no note`);
    }
    const lists = [
      { field: "origins", list: (source as Partial<Source>).origins, ids: originIds },
      ...entries.map((entry) => ({ field: `origins in ${entry.region}`, list: entry.origins, ids: originIds })),
      { field: "path", list: (source as Partial<Source>).path, ids: new Set(parts.keys()) },
    ];
    for (const { field, list, ids } of lists) {
      if (!Array.isArray(list) || list.length === 0) add(at, `the source has no ${field}: give the ids, or unknown`);
      else {
        if (new Set(list).size !== list.length) add(at, `the ${field} have a duplicate`);
        for (const id of list) if (id !== UNKNOWN && !ids.has(id)) add(at, `the id ${id} of the ${field} is not in its list`);
      }
    }
    const first = parts.get((source as Partial<Source>).path?.[0] ?? UNKNOWN);
    if (first !== undefined && first.kind !== "host") add(at, "the first part of the path is not a host");
  }
  if (context.codes !== undefined) for (const code of unreachedCodes(atlas.classes, context.codes)) add(`code ${code}`, "no class is the code, an ancestor of it or a descendant of it");
  for (const { id, shared, gap } of coverage(atlas)) {
    const count = String(shared);
    if (shared < MIN_SOURCES && (gap === null || gap.trim() === "")) add(`class ${id}`, `the class has ${count} sources with no risk at one leaf code and no reason of a gap`);
    if (shared >= MIN_SOURCES && gap !== null) add(`class ${id}`, `the class has ${count} sources with no risk at one leaf code, so its reason of a gap is out of date`);
  }
  return problems;
}

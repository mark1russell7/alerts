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
 */

import { categoryOf, knownKind, SUBJECT_SYSTEMS, TAXONOMY, type Category, type SubjectKind, type SubjectSystem } from "@mark1russell7/alerts";

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
  /** The classes that the source gives signals of. */
  readonly classes: readonly string[];
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
 * The measures of the atlas at one time. The gap count measures the research and the plans. The adopted
 * cover measures the signals that reach a person at this time.
 */
export interface Measures {
  readonly classes: number;
  /** The classes with fewer than `MIN_SOURCES` adopted or planned sources with no risk. */
  readonly gaps: number;
  /** The classes with `MIN_SOURCES` or more adopted sources with no risk. */
  readonly adoptedCover: number;
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
  /** The measures of the atlas at the end of the round. The adopted cover of the atlas stays at or above the measure of the latest round. */
  readonly measures: RoundMeasures;
}

/** The whole atlas. */
export interface Atlas {
  readonly classes: readonly SignalClass[];
  readonly sources: readonly Source[];
  readonly rounds: readonly Round[];
}

/** One problem of the atlas. */
export interface AtlasProblem {
  /** The record, for example `class infra.power.outage` or `source eia-930`. */
  readonly at: string;
  readonly problem: string;
}

/** The coverage of one class. */
export interface Coverage {
  readonly id: string;
  /** The sources of the class and of its descendants, with a decision of `LIVE_DECISIONS`. */
  readonly sources: readonly string[];
  /** The sources of `sources` with one or more risks. The gate does not count them. */
  readonly atRisk: readonly string[];
  /** The sources of `sources` with the decision `adopt`: an adapter of the repository reads them at this time. */
  readonly adopted: readonly string[];
  readonly gap: string | null;
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
  return [...new Set(codes)].filter((code) => !EXEMPT_CATEGORIES.includes(categoryOf(code)) && !reached(code)).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
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

/** This function gives the coverage of each class: the adopted and planned sources of the class and of its descendants. */
export function coverage(atlas: Atlas): Coverage[] {
  return atlas.classes.map(({ id, gap }) => {
    const live = atlas.sources.filter((source) => LIVE_DECISIONS.includes(source.decision) && source.classes.some((name) => isUnder(name, id)));
    const ids = (list: readonly Source[]): string[] => list.map((source) => source.id);
    return {
      id,
      sources: ids(live),
      atRisk: ids(live.filter((source) => source.risks.length > 0)),
      adopted: ids(live.filter((source) => source.decision === "adopt")),
      gap,
    };
  });
}

/** This function gives the measures of the atlas: the classes, the gaps and the adopted cover. */
export function measures(atlas: Atlas): Measures {
  const rows = coverage(atlas);
  const free = (list: readonly string[], atRisk: readonly string[]): number => list.filter((id) => !atRisk.includes(id)).length;
  return {
    classes: rows.length,
    gaps: rows.filter((row) => free(row.sources, row.atRisk) < MIN_SOURCES).length,
    adoptedCover: rows.filter((row) => free(row.adopted, row.atRisk) >= MIN_SOURCES).length,
  };
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
      for (const value of [recorded.classes, recorded.gaps, recorded.adoptedCover]) if (!Number.isSafeInteger(value) || value < 0) add(at, `the measure ${String(value)} is not a count`);
      if (typeof recorded.cause !== "string" || recorded.cause.trim() === "") add(at, "the measures have no cause");
    }
  }
  if (rounds.size !== atlas.rounds.length) add("atlas", "two records of rounds have one number");
  // The adopted cover is the outcome. Its floor is the measure of the latest round. Thus a real loss of a
  // source needs a new round whose cause names the loss, and no record of an old round changes.
  const latest = atlas.rounds.reduce<Round | undefined>((last, round) => (last === undefined || round.round > last.round ? round : last), undefined);
  const floor = (latest as Partial<Round> | undefined)?.measures?.adoptedCover ?? 0;
  const { adoptedCover } = measures(atlas);
  if (latest !== undefined && adoptedCover < floor) {
    add("atlas", `the adopted cover is ${String(adoptedCover)} classes, below the ${String(floor)} classes of round ${String(latest.round)}`);
  }
  const classIds = new Set<string>();
  for (const item of atlas.classes) {
    const at = `class ${item.id}`;
    if (classIds.has(item.id)) add(at, "the id is not unique");
    classIds.add(item.id);
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
    if (source.classes.length === 0) add(at, "the source has no class");
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
  }
  if (context.codes !== undefined) for (const code of unreachedCodes(atlas.classes, context.codes)) add(`code ${code}`, "no class is the code, an ancestor of it or a descendant of it");
  for (const { id, sources, atRisk, gap } of coverage(atlas)) {
    const count = sources.length - atRisk.length;
    if (count < MIN_SOURCES && (gap === null || gap.trim() === "")) add(`class ${id}`, `the class has ${String(count)} sources with no risk and no reason of a gap`);
    if (count >= MIN_SOURCES && gap !== null) add(`class ${id}`, `the class has ${String(count)} sources with no risk, so its reason of a gap is out of date`);
  }
  return problems;
}

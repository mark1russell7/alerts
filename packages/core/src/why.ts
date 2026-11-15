// The why line: why a message reaches a person, in the limit of each channel (AL-35, `docs/RELEVANCE.md`).

import { SUBJECT_SYSTEMS, type NodeKey, type PlaceId, type SubjectKind, type WhyLimit, type WhyRecord } from "./contracts.ts";

/**
 * The limit of the why line on each kind of channel. A channel descriptor gives the limit of its kind in its
 * field `why`. `docs/RELEVANCE.md` tells the reasons of the values.
 */
export const WHY_LIMITS = {
  /** A push message: 80 characters. */
  push: { chars: 80 },
  /** A text message: 40 characters, each of the GSM-7 base set. */
  text: { chars: 40 },
  /** A voice call: 12 words. */
  call: { words: 12 },
} as const satisfies Readonly<Record<string, WhyLimit>>;

/**
 * The label of a node of the interest graph for the person, or `undefined`. The runtime gives the labels from the
 * private configuration. A label is not in a `WhyRecord` at any time.
 */
export type WhyLabels = (node: NodeKey) => string | undefined;

/** A function of labels that gives no label. Each why line then uses plain nouns. */
export const NO_LABELS: WhyLabels = () => undefined;

/** A why with a coverage below this value tells that it is a part of the reason. */
export const WHY_FULL_COVERAGE = 0.99;

// A label goes into a text only when it is plain words: letters, spaces and the characters ' & . , -, with a
// lowercase letter and no two capitals in a row. Thus a why line has no digit (no address number, no point and no
// region code) and no code in capitals, and each of its characters is in the GSM-7 base set.
const PLAIN_LABEL = /^[A-Za-z][A-Za-z '&.,-]*$/;

/**
 * This function gives the label of a node when it is safe for a channel text, or `undefined`. A safe label has
 * only letters, spaces and the characters ' & . , -, a lowercase letter, and no two capitals in a row.
 */
export function plainLabel(labels: WhyLabels, node: NodeKey): string | undefined {
  const label = labels(node)?.trim().replace(/\s+/g, " ");
  if (label === undefined || !PLAIN_LABEL.test(label) || !/[a-z]/.test(label) || /[A-Z]{2}/.test(label)) return undefined;
  return label;
}

/** This function gives the kind of a node key from its system, or `undefined` for a key with no known system. */
export function kindOfNode(node: NodeKey): SubjectKind | undefined {
  const colon = node.indexOf(":");
  if (colon <= 0) return undefined;
  const system = node.slice(0, colon);
  return Object.hasOwn(SUBJECT_SYSTEMS, system) ? SUBJECT_SYSTEMS[system as keyof typeof SUBJECT_SYSTEMS] : undefined;
}

/** This function tells if a text keeps a limit of a why line. It counts code points and words. */
export function fitsWhy(text: string, limit: WhyLimit): boolean {
  if (limit.chars !== undefined && [...text].length > limit.chars) return false;
  if (limit.words !== undefined && text.split(/\s+/).filter((word) => word !== "").length > limit.words) return false;
  return true;
}

// The names of the nodes of one candidate line. An absent name gives a plain noun.
interface Names {
  readonly subject?: string;
  readonly via?: string;
  readonly anchor?: string;
}

// The plain noun of an anchor of each kind, for a path from another subject. The shortest plain line, with the
// prefix of a part, has 40 characters: "Why, in part: it can affect your service". Thus a why fits each limit of WHY_LIMITS.
const ANCHOR_NOUNS: Readonly<Record<SubjectKind, string>> = { place: "your place", topic: "your topic", entity: "your service" };

function sentence(record: WhyRecord, names: Names): string {
  const kind = kindOfNode(record.anchor) ?? record.kind;
  if (record.subject === record.anchor) {
    if (kind === "place") return `${names.anchor ?? "your place"} is in the area`;
    if (kind === "topic") return `you follow ${names.anchor ?? "this topic"}`;
    return `you use ${names.anchor ?? "this service"}`;
  }
  const via = names.via === undefined ? "" : ` via ${names.via}`;
  return `${names.subject ?? "this event"} can affect ${names.anchor ?? ANCHOR_NOUNS[kind]}${via}`;
}

/**
 * This function gives the why line of a record in a limit, or `undefined` when no line fits.
 *
 * - The line starts with `Why: `, or with `Why, in part: ` when the coverage is below `WHY_FULL_COVERAGE`.
 * - The function tries the lines from the fullest to the shortest. The fullest line has the labels of the subject,
 *   the `via` node and the anchor. The next lines have fewer labels, and the last lines have only plain nouns.
 * - The function gives the first line that fits. With the limits of `WHY_LIMITS`, a line always fits.
 * - A label goes in only when `plainLabel` keeps it. Thus the line holds no address, point or region code.
 */
export function whyLine(record: WhyRecord, labels: WhyLabels, limit: WhyLimit): string | undefined {
  const prefix = record.coverage < WHY_FULL_COVERAGE ? "Why, in part: " : "Why: ";
  const subject = record.subject === record.anchor ? undefined : plainLabel(labels, record.subject);
  const via = record.via === undefined ? undefined : plainLabel(labels, record.via);
  const anchor = plainLabel(labels, record.anchor);
  const named = anchor === undefined ? {} : { anchor };
  const candidates: readonly Names[] = [
    { ...(subject === undefined ? {} : { subject }), ...(via === undefined ? {} : { via }), ...named },
    { ...(subject === undefined ? {} : { subject }), ...named },
    named,
    { subject: "it", ...named },
    {},
    { subject: "it" },
  ];
  for (const names of candidates) {
    const line = `${prefix}${sentence(record, names)}`;
    if (fitsWhy(line, limit)) return line;
  }
  return undefined;
}

/**
 * This function gives the why of a match by places: the watched place with the first id in code-point order. Thus
 * the order of the configuration does not change it. It gives `undefined` when no place matches.
 */
export function placeWhy(places: readonly PlaceId[]): WhyRecord | undefined {
  if (places.length === 0) return undefined;
  const first = places.reduce((least, id) => (id < least ? id : least));
  const key = `place:${first}`;
  return { rule: "reach.place.places", subject: key, kind: "place", anchor: key, origin: "places", coverage: 1 };
}

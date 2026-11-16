/**
 * The exchange of the logs of the copies of the system (AL-16). A copy gives the shared events of its log, one page at a
 * time. Another copy adds them to its own log as events `import`. The design is in the section "The exchange" of
 * `docs/CONTRACTS.md`.
 *
 * This module has no transport. The procedures host serves the pages, and a worker of each copy reads them.
 */
import { acknowledgmentSchema, checkWith, copyIdSchema, deliverySchema, escalationEndSchema, reportSchema, type Instant } from "@mark1russell7/alerts";
import { err, ok, type Result } from "@mark1russell7/optional";
import { envelope, type ExchangeEvent, type ImportEvent, type RuntimeEvent, type SharedEvent } from "./events.ts";
import type { RuntimeLog } from "./log.ts";
import type { ExchangeCursor } from "./state.ts";

/** The format of a page of the exchange. */
export const EXCHANGE_FORMAT = "alerts-exchange/1";

/** The highest count of log entries that one page examines. */
export const EXCHANGE_PAGE = 500;

/**
 * The count of entries after which a read with no import writes its position again. Thus a restart reads this count
 * of entries again or fewer.
 */
export const EXCHANGE_CHECKPOINT = 10_000;

/** The types of the events that a page examines: the shared events, and the imports that a copy gives again. */
export const SHARED_TYPES: readonly RuntimeEvent["type"][] = ["fetch", "ended", "back", "delivery", "acknowledgment", "cancelled", "escalation-end", "import"];

/** One shared event of a page, with the id of the copy that wrote it. */
export interface SharedItem {
  readonly from: string;
  readonly event: SharedEvent;
}

/** One page of the shared events of the log of a copy. */
export interface ExchangePage {
  readonly format: typeof EXCHANGE_FORMAT;
  /** The id of the copy that gives the page. */
  readonly copy: string;
  /** The id of the first event of the log of the copy. A new log of the copy has a new id. */
  readonly log: string;
  /** The position after which the page starts. */
  readonly after: number;
  /** The position of the last entry that the page examined. The next page starts after it. */
  readonly next: number;
  /** The position of the last event of the log at the read. When `next` is below it, more entries wait. */
  readonly head: number;
  readonly items: readonly SharedItem[];
}

/** A page from another copy. Its form is correct, and the import examines each item. */
export type ReceivedPage = Omit<ExchangePage, "items"> & { readonly items: readonly unknown[] };

/** The events of the import of a page, and the position of the next read of the copy. */
export interface PageImport {
  /** The imports of the page, and the read position when it moved and the log needs it. */
  readonly events: readonly (ImportEvent | ExchangeEvent)[];
  /** The count of the imports in `events`. */
  readonly imports: number;
  /** The position of the next read of the copy, in the log `log`. */
  readonly position: ExchangeCursor;
  /** The problems of the page. A problem has no value of an event, thus it holds no place and no person. */
  readonly problems: readonly string[];
}

/** This function gives the shared item of an event of the log, or `undefined` for an event that stays in its copy. */
export function sharedItem(event: RuntimeEvent, copy: string): SharedItem | undefined {
  switch (event.type) {
    case "fetch":
      return event.reports.length === 0 ? undefined : { from: copy, event: { id: event.id, at: event.at, type: event.type, time: event.time, reports: event.reports } };
    case "delivery":
      return { from: copy, event: { id: event.id, at: event.at, type: event.type, time: event.time, delivery: event.delivery } };
    case "ended":
    case "back":
    case "acknowledgment":
    case "cancelled":
    case "escalation-end":
      return { from: copy, event };
    case "import":
      return { from: event.from, event: event.event };
    default:
      return undefined;
  }
}

/**
 * This function gives the page of the shared events of a log after a position. The page examines `limit` entries of the
 * shared types or fewer. A page that is not full examined each entry up to the head.
 */
export function sharePage(log: RuntimeLog, self: { readonly copy: string; readonly log: string }, after: number, limit: number = EXCHANGE_PAGE): ExchangePage {
  if (!Number.isInteger(after) || after < 0) throw new RangeError(`The position ${after} is not an integer of 0 or more.`);
  if (!Number.isInteger(limit) || limit < 1) throw new RangeError(`The limit ${limit} is not an integer of 1 or more.`);
  const items: SharedItem[] = [];
  let last = after;
  let count = 0;
  for (const entry of log.entries({ after, types: SHARED_TYPES, limit })) {
    count += 1;
    last = entry.seq;
    const item = sharedItem(entry.event, self.copy);
    if (item !== undefined) items.push(item);
  }
  const head = log.head();
  return { format: EXCHANGE_FORMAT, copy: self.copy, log: self.log, after, next: count < limit ? Math.max(after, head) : last, head, items };
}

/** This function examines the form of a page from another copy. It does not examine the items. */
export function parsePage(value: unknown): Result<ReceivedPage, readonly string[]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return err(["The page is not an object."]);
  const page = value as Partial<Record<keyof ExchangePage, unknown>>;
  const problems: string[] = [];
  if (page.format !== EXCHANGE_FORMAT) problems.push(`The page does not have the format ${EXCHANGE_FORMAT}.`);
  if (checkWith(copyIdSchema, page.copy).tag === "err") problems.push("The page does not have the id of a copy.");
  if (!isText(page.log)) problems.push("The page does not have the id of a log.");
  for (const field of ["after", "next", "head"] as const) {
    const position = page[field];
    if (typeof position !== "number" || !Number.isInteger(position) || position < 0) problems.push(`The field ${field} of the page is not an integer of 0 or more.`);
  }
  if (typeof page.after === "number" && typeof page.next === "number" && page.next < page.after) problems.push("The field next of the page is below its field after.");
  if (!Array.isArray(page.items)) problems.push("The page does not have a list of items.");
  return problems.length > 0 ? err(problems) : ok(value as ReceivedPage);
}

/** The input of `importPage`. */
export interface ImportInput {
  /** The id of this copy. An item of this copy came back from another copy, and the import skips it. */
  readonly self: string;
  /** The position of the next read of the copy of the page, in memory. */
  readonly position: ExchangeCursor | undefined;
  /** The read position of the copy of the page in the log of this copy. */
  readonly logged: ExchangeCursor | undefined;
  /** The time of the import on the clock of this copy. */
  readonly now: Instant;
}

/**
 * This function gives the events of the import of a page of another copy, and the position of the next read.
 *
 * A page of a new log of the copy that does not start at 0 gives no import, and the next read starts at 0. A page that
 * starts after the position gives no import, because it skips entries. The function writes the position to the log
 * with the imports of the page, or after `EXCHANGE_CHECKPOINT` entries with no import.
 */
export function importPage(page: ReceivedPage, input: ImportInput): PageImport {
  const { self, position, logged } = input;
  const known = position?.log === page.log ? position : undefined;
  const expected = known?.next ?? 0;
  if (page.copy === self) return refused(page, known, [`The copy ${self} reads its own log. Give the URL of another copy.`]);
  if (page.after > expected) return refused(page, known, []);
  const imports: ImportEvent[] = [];
  const problems: string[] = [];
  page.items.forEach((value, index) => {
    const problem = itemProblem(value);
    if (problem !== undefined) {
      problems.push(`The item ${index} of the page of ${page.copy} after ${page.after}: ${problem}`);
      return;
    }
    const item = value as SharedItem;
    if (item.from !== self) imports.push(importOf(item));
  });
  const next = Math.max(expected, page.next);
  // The position in the log of this copy, when the log of this copy has a position in the log of the page.
  const base = logged !== undefined && logged.log === page.log ? logged.next : undefined;
  const moved = base === undefined || next !== base;
  const due = imports.length > 0 || base === undefined || next - base >= EXCHANGE_CHECKPOINT;
  const events: (ImportEvent | ExchangeEvent)[] = [...imports];
  if (moved && due) events.push({ ...envelope("exchange", `exchange:${page.copy}:${page.log}:${next}`, input.now), peer: page.copy, log: page.log, next });
  return { events, imports: imports.length, position: { log: page.log, next }, problems };
}

// A page with no import. The next read starts at the known position in the log of the page, or at 0.
function refused(page: ReceivedPage, known: ExchangeCursor | undefined, problems: readonly string[]): PageImport {
  return { events: [], imports: 0, position: { log: page.log, next: known?.next ?? 0 }, problems };
}

// The types of the events of a source. Their ids are ids of their copy, thus the id of an import has the id of the copy
// first. The events of the ledger have the same id in each copy: one step of two copies is one event.
const SOURCE_TYPES: ReadonlySet<string> = new Set<SharedEvent["type"]>(["fetch", "ended", "back"]);

/** This function gives the import of a shared item. Two reads of one item give the same import. */
export function importOf(item: SharedItem): ImportEvent {
  const { event } = item;
  const id = SOURCE_TYPES.has(event.type) ? `${item.from}/${event.id}` : event.id;
  return { id, at: event.at, type: "import", time: event.time, from: item.from, event };
}

type Check = (value: unknown) => boolean;

const isText: Check = (value) => typeof value === "string" && value.length > 0;
const isInstant: Check = (value) => typeof value === "number" && Number.isFinite(value);
const isTexts: Check = (value) => Array.isArray(value) && value.every(isText);
const valid =
  <T>(schema: Parameters<typeof checkWith<T>>[0]): Check =>
  (value) =>
    checkWith(schema, value).tag === "ok";
const isReports: Check = (value) => Array.isArray(value) && value.every(valid(reportSchema));

// The fields of each shared event other than its envelope, with the check of each field.
const FIELDS: Readonly<Record<SharedEvent["type"], Readonly<Record<string, { readonly check: Check; readonly optional?: true }>>>> = {
  fetch: { reports: { check: isReports } },
  ended: { source: { check: isText }, reports: { check: isTexts }, asOf: { check: isInstant, optional: true } },
  back: { source: { check: isText }, reports: { check: isTexts } },
  delivery: { delivery: { check: valid(deliverySchema) } },
  acknowledgment: { acknowledgment: { check: valid(acknowledgmentSchema) } },
  cancelled: { delivery: { check: isText } },
  "escalation-end": { end: { check: valid(escalationEndSchema) } },
};

const ENVELOPE: ReadonlySet<string> = new Set(["id", "at", "type", "time"]);

/** This function gives the problem of an item of a page, or `undefined` for a shared item. The problem has no value. */
export function itemProblem(value: unknown): string | undefined {
  if (!isRecord(value)) return "the item is not an object.";
  if (checkWith(copyIdSchema, value["from"]).tag === "err") return "the item does not have the id of a copy.";
  const event = value["event"];
  if (!isRecord(event)) return "the item does not have an event.";
  if (!isText(event["id"]) || !isText(event["at"]) || !isInstant(event["time"])) return "the envelope of the event is not complete.";
  const type = event["type"];
  if (typeof type !== "string" || !Object.hasOwn(FIELDS, type)) return "the event does not have the type of a shared event.";
  const fields = FIELDS[type as SharedEvent["type"]];
  for (const key of Object.keys(event)) if (!ENVELOPE.has(key) && !Object.hasOwn(fields, key)) return `the event ${type} has the unknown field ${key}.`;
  for (const [key, field] of Object.entries(fields)) {
    if (!Object.hasOwn(event, key)) {
      if (field.optional === true) continue;
      return `the event ${type} does not have the field ${key}.`;
    }
    if (!field.check(event[key])) return `the field ${key} of the event ${type} is not valid.`;
  }
  return Object.keys(value).every((key) => key === "from" || key === "event") ? undefined : "the item has a field other than from and event.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * This module holds the pure parts of the messages of the operator (AL-92). The intake of the runtime (`tell-intake.ts`)
 * takes each message as an event of the source `tell`. Then the merge, the routes, the send limit, the quiet window, the
 * quota gate and the digest apply to it, as to each alert.
 *
 * - A message has a class (`TELL_CLASSES`), an item and a text. Its report is private: its addresses name its persons.
 * - A message with no persons goes to the operator. The operator is the one person who watches each source.
 * - Each item, class and audience has a line of reports, as the system reports have. The lines come from the live reports.
 * - A message with the same facts as its open line gives no report. A message with new facts updates the line.
 * - A message `done-you-asked` also cancels the open line `needs-you` of its item and its persons.
 * - A link of the local site goes to its phone form (`siteLink`). The intake refuses each other link on the loopback address.
 */
import {
  audienceKey,
  audienceOf,
  categoryOf,
  kindLabel,
  matchSubjects,
  reportId,
  TELL_CLASSES,
  TELL_KIND,
  type Instant,
  type PersonId,
  type Recipient,
  type Report,
  type SourceId,
  type Subject,
  type TellClass,
  type TellSite,
} from "@mark1russell7/alerts";
import { err, ok, type Result } from "@mark1russell7/optional";
import * as z from "zod";

/** The source of each message of the operator, in the id of its report. */
export const TELL_SOURCE = "tell" as SourceId;

/** The subject of a message of the operator. A watch of each source matches it, and a watch of one other source does not. */
export const TELL_SUBJECT: Subject = { system: "alerts.source", id: "tell" };

/** The characters of an item: letters, digits, `.`, `_` and `-`, 1 to 40 of them. A tracker id is an item. */
export const TELL_ITEM: RegExp = /^[A-Za-z0-9._-]{1,40}$/u;

/** The most characters of the text of a message. */
export const TELL_TEXT_LIMIT = 500;

/** The most characters of the title of a message. */
export const TELL_TITLE_LIMIT = 80;

/** The most persons of one message. */
export const TELL_PERSONS_LIMIT = 10;

/** The time from the intake of a message to its end, in milliseconds: one day. */
export const TELL_LIFE: number = 24 * 60 * 60_000;

/** One message of the operator, as the client gives it. */
export interface TellEvent {
  readonly class: TellClass;
  /** An urgent message sounds. Only a message `needs-you` can be urgent. */
  readonly urgent?: boolean;
  /** The item of the roadmap that the message is about. */
  readonly item: string;
  readonly title?: string;
  readonly text: string;
  /** A link for the message. The intake changes a link of the local site to its phone form. */
  readonly url?: string;
  /** The persons of the message. With no persons, the message goes to the operator. */
  readonly to?: readonly string[];
}

/** This schema checks one message of the operator, as the client gives it. Only a message `needs-you` can be urgent. */
export const tellEventSchema: z.ZodType<TellEvent> = z
  .strictObject({
    class: z.enum(TELL_CLASSES),
    urgent: z.boolean().exactOptional(),
    item: z.string().regex(TELL_ITEM, "The item has 1 to 40 letters, digits, dots, underscores or hyphens."),
    title: z.string().trim().min(1).max(TELL_TITLE_LIMIT).exactOptional(),
    text: z.string().trim().min(1, "The text is necessary.").max(TELL_TEXT_LIMIT),
    url: z.string().min(1).max(2000).exactOptional(),
    to: z.array(z.string().min(1).max(100)).min(1).max(TELL_PERSONS_LIMIT).exactOptional(),
  })
  .refine((event) => event.urgent !== true || event.class === "needs-you", "Only a message needs-you can be urgent.");

/** One message that the intake took. Its persons and its link are final. */
export interface TellDraft {
  readonly class: TellClass;
  readonly urgent: boolean;
  readonly item: string;
  readonly title?: string | undefined;
  readonly text: string;
  readonly url?: string | undefined;
  /** The persons of the message, in one order and with no repeat. */
  readonly persons: readonly PersonId[];
  /** The time of the intake. Each message of one intake has a later time than the message before it. */
  readonly received: Instant;
}

/**
 * This function gives the persons of a message. With `to`, each key must be a person of the configuration. With no `to`,
 * the message goes to the operator: the one person whose subjects watch each source. The problems name no person.
 */
export function tellPersons(to: readonly string[] | undefined, recipients: readonly Recipient[]): Result<readonly PersonId[], string> {
  if (to !== undefined) {
    const known = new Set<string>(recipients.map((recipient) => recipient.watch.person));
    const unknown = to.filter((key) => !known.has(key)).length;
    return unknown === 0 ? ok(audienceOf(to as readonly PersonId[])) : err(`The field to has ${unknown === 1 ? "1 person" : `${unknown} persons`} that the configuration does not have.`);
  }
  const operators = recipients.filter((recipient) => matchSubjects({ about: [TELL_SUBJECT] }, recipient.watch.subjects ?? []).length > 0);
  const [operator] = operators;
  if (operators.length === 1 && operator !== undefined) return ok([operator.watch.person]);
  return err(
    operators.length === 0
      ? "No person watches each source. Thus the message has no operator: give the field to."
      : `${operators.length} people watch each source. Thus the operator is not clear: give the field to.`,
  );
}

/** The result of `siteLink`: the link that the phone gets, or the reason of a refusal. */
export type SiteLink = { readonly url: string | undefined } | { readonly refused: string };

/**
 * This function gives the link that a phone opens. A link on the loopback address does not open on a phone.
 *
 * - A path that starts with `/` goes to the phone origin of the site.
 * - A link on the loopback address with the port of the local site goes to the phone origin, with its path, query and fragment.
 * - Each other link on the loopback address, and a path with no site, is refused. Thus no channel gets such a link.
 * - Each other `https` or `http` link stays as it is.
 */
export function siteLink(url: string | undefined, site: TellSite | undefined): SiteLink {
  if (url === undefined) return { url: undefined };
  if (url.startsWith("/") && !url.startsWith("//")) {
    return site === undefined ? { refused: "A path needs the local site in the configuration: the field tell.site." } : { url: `${site.phone}${url}` };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { refused: "The link is not an absolute URL or a path that starts with /." };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return { refused: "The link does not start with https: or http:." };
  if (!isLocalHost(parsed.hostname)) return { url };
  const local = site === undefined ? undefined : new URL(site.local);
  if (site === undefined || local === undefined || portOf(local) !== portOf(parsed)) {
    return { refused: "A link on the loopback address does not open on a phone, and it is not a link of the local site of tell.site." };
  }
  return { url: `${site.phone}${parsed.pathname}${parsed.search}${parsed.hash}` };
}

// The hosts that only this computer opens: the loopback addresses, the names under `localhost`, and the address of each interface.
// The URL class writes each form of an address in one form: `127.1` is `127.0.0.1`, and `[::ffff:127.0.0.1]` is `[::ffff:7f00:1]`.
function isLocalHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "[::1]" ||
    host === "0.0.0.0" ||
    host === "[::]" ||
    /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(host) ||
    /^\[::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}\]$/u.test(host)
  );
}

// The port of a URL. The URL class gives an empty port for the default port of the protocol.
function portOf(url: URL): string {
  return url.port !== "" ? url.port : url.protocol === "https:" ? "443" : "80";
}

/** An open line of messages: the key of its last report and the facts of that report. */
export interface TellLine {
  readonly key: string;
  readonly facts: string;
}

/** This function gives the name of the line of an item, a class and the persons. */
export function tellLineName(item: string, kind: TellClass, persons: readonly PersonId[]): string {
  return `tell:${item}:${kind}:${audienceKey({ addresses: persons })}`;
}

/** The fields of a report that are its facts. A change of one of them updates the line. */
type FactFields = Pick<Report, "headline" | "description" | "web" | "severity">;

/** This function gives the facts of a report: its headline, its text, its link and its severity. */
export function tellFacts(report: FactFields): string {
  return JSON.stringify([report.headline, report.description ?? null, report.web ?? null, report.severity]);
}

/**
 * This function gives the open lines at `at`, by their names. It reads the reports of the source `tell`, of each copy.
 * The last report of each line decides. A cancel closes the line, and so does the end of the report.
 * Thus the lines are a query over the live data, and they need no state of their own.
 */
export function tellLines(reports: readonly Report[], at: Instant): ReadonlyMap<string, TellLine> {
  const last = new Map<string, Report>();
  for (const report of reports) {
    const name = lineOf(report);
    if (name === undefined) continue;
    const before = last.get(name);
    if (before === undefined || report.sent > before.sent || (report.sent === before.sent && report.id > before.id)) last.set(name, report);
  }
  const open = new Map<string, TellLine>();
  for (const [name, report] of last) {
    if (report.op === "cancel" || (report.expires !== undefined && report.expires <= at)) continue;
    open.set(name, { key: report.key, facts: tellFacts(report) });
  }
  return open;
}

// The name of the line of a report of the source `tell`, or undefined for another report.
function lineOf(report: Report): string | undefined {
  if (report.source !== TELL_SOURCE || report.addresses === undefined) return undefined;
  const kind = TELL_CLASSES.find((name) => report.kind.code === `${TELL_KIND}.${name}`);
  const item = report.parameters["item"]?.[0];
  return kind === undefined || item === undefined ? undefined : tellLineName(item, kind, report.addresses);
}

/** A report of a message before its observation: the map of the source adds the id of the observation. */
export type TellReport = Omit<Report, "observation">;

/** The result of `tellStep`: the reports of one message and the open lines after them. */
export interface TellStep {
  readonly reports: readonly TellReport[];
  readonly lines: ReadonlyMap<string, TellLine>;
}

/**
 * This function gives the reports of one message, and the open lines after them.
 *
 * - A message with the same facts as its open line gives no report.
 * - A message with new facts gives an update that references the last key of the line. It is the same incident.
 * - A message with no open line gives an alert. It is a new incident, thus it sends.
 * - A message `done-you-asked` also gives a cancel of the open line `needs-you` of its item and persons.
 */
export function tellStep(lines: ReadonlyMap<string, TellLine>, draft: TellDraft): TellStep {
  const next = new Map(lines);
  const reports: TellReport[] = [];
  const name = tellLineName(draft.item, draft.class, draft.persons);
  const line = next.get(name);
  const report = tellReport(draft, draft.class, line === undefined ? { op: "alert", references: [] } : { op: "update", references: [line.key] });
  if (line === undefined || line.facts !== tellFacts(report)) {
    reports.push(report);
    next.set(name, { key: report.key, facts: tellFacts(report) });
  }
  if (draft.class === "done-you-asked") {
    const asked = tellLineName(draft.item, "needs-you", draft.persons);
    const open = next.get(asked);
    if (open !== undefined) {
      reports.push(tellReport(draft, "needs-you", { op: "cancel", references: [open.key] }));
      next.delete(asked);
    }
  }
  return { reports, lines: next };
}

// The report of a message in the line of the class `kind`. A cancel tells that the line ended.
function tellReport(draft: TellDraft, kind: TellClass, envelope: Pick<Report, "op" | "references">): TellReport {
  const code = `${TELL_KIND}.${kind}`;
  const label = kindLabel(code);
  const subject = draft.title ?? draft.item;
  const cancel = envelope.op === "cancel";
  const urgent = !cancel && draft.urgent && kind === "needs-you";
  const key = `${tellLineName(draft.item, kind, draft.persons)}#${draft.received}`;
  return {
    id: reportId({ source: TELL_SOURCE, key, sent: draft.received }),
    source: TELL_SOURCE,
    origin: TELL_SOURCE,
    key,
    references: envelope.references,
    correlation: [],
    status: "system",
    op: envelope.op,
    kind: { code, label },
    categories: [categoryOf(code)],
    severity: cancel ? "minor" : urgent ? "severe" : "moderate",
    urgency: cancel ? "past" : urgent ? "immediate" : "expected",
    certainty: "observed",
    response: cancel ? ["allclear"] : kind === "needs-you" ? ["assess"] : ["none"],
    sent: draft.received,
    received: draft.received,
    ...(cancel ? {} : { expires: draft.received + TELL_LIFE }),
    areas: [],
    about: [TELL_SUBJECT],
    addresses: draft.persons,
    sender: "alerts",
    headline: cancel ? `${label}: ${subject}. Done.` : `${label}: ${subject}`,
    description: draft.text,
    ...(draft.url === undefined ? {} : { web: draft.url }),
    parameters: { item: [draft.item] },
  };
}

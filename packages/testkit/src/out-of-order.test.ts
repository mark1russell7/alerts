import { incidents, messageKey, normalize, type Observation, type ObservationId, type Report, type ReportId, threats } from "@mark1russell7/alerts";
import { COPY_SUFFIX, mapObservation as mapIpaws, SOURCE_ID as IPAWS_ID } from "@mark1russell7/alerts-source-ipaws";
import { mapObservation as mapNws, NWS_DESCRIPTOR, SOURCE_ID as NWS_ID } from "@mark1russell7/alerts-source-nws-api";
import { describe, expect, it } from "vitest";
import { COPY_PLACES, type CopyPlace, readPair } from "./copy-late.ts";
import {
  arrivalOf,
  CASE_9_SETTINGS,
  DUPLICATE_FEEDS,
  expectationOf,
  FEED_SPAN,
  GATE_KEYS,
  type GateKey,
  lineCopyOf,
  lineFeatureOf,
  lineOf,
  lineReportsOf,
  lineVtecOf,
  ORDER_ARMS,
  ORDER_KNOWN_FAULTS,
  ORDER_PLACES,
  type OrderArm,
  orderBodiesOf,
  type OrderDelivery,
  type OrderFetch,
  orderGatesOf,
  type OrderKnownFault,
  orderRecipientsOf,
  type OrderRecord,
  orderSettingsProblems,
  orderVerdictOf,
  personOf,
  PLACE_COUNTIES,
  type PlaceExpectation,
  reorderedFeatureOf,
  sendLabel,
  spacedCopyOf,
  type TimedKey,
} from "./out-of-order.ts";

const PAIR = readPair();
const INTERVAL = NWS_DESCRIPTOR.interval;
const ANCHOR = "report-anchor" as ReportId;
let observations = 0;

const observe = (source: Observation["source"], body: string, contentType: string, fetched: number): Observation => {
  observations += 1;
  return { id: `observation-${source}-${String(observations)}` as ObservationId, source, fetched, contentType, body, transport: { latency: 0 } };
};

const one = (result: { readonly reports: readonly Report[]; readonly problems: readonly { readonly fatal?: boolean }[] }): Report => {
  expect(result.problems.filter((problem) => problem.fatal === true)).toEqual([]);
  expect(result.reports).toHaveLength(1);
  return result.reports[0] as Report;
};

/** This function gives the UGC codes of a report. The adapters also give the SAME code of each county. */
const codesOf = (report: Report): string[] => report.areas.flatMap((area) => (area.type === "code" && area.system === "ugc" ? [area.code] : []));

/** This function gives the NWS report and the IPAWS report of each message of the line of an arm. Each is read half an interval after its time `sent`. */
const reportsOf = (arm: OrderArm): { readonly name: string; readonly nws: Report; readonly ipaws: Report }[] =>
  lineReportsOf(arm).map((report) => ({
    name: report.message.name,
    nws: one(mapNws(observe(NWS_ID, JSON.stringify(lineFeatureOf(report, PAIR.newFeature)), "application/geo+json", report.sentAt + INTERVAL / 2))),
    ipaws: one(mapIpaws(observe(IPAWS_ID, lineCopyOf(report, PAIR.newCopy), "application/xml", report.sentAt + INTERVAL / 2))),
  }));

/** This function gives the places with a threat of some reports, at a time before the end of the event. */
const threatenedOf = (reports: readonly Report[], at: number): string[] =>
  threats(incidents(normalize({ reports }), at), COPY_PLACES)
    .map((threat) => threat.place as string)
    .sort();

const fetchesOf = (): OrderFetch[] => Array.from({ length: CASE_9_SETTINGS.fetches }, (_, fetch) => ({ at: fetch * INTERVAL + 1000, ok: true, complete: true, observations: 1 }));

/**
 * This function gives a record of an arm whose log has the sends of `expected`. Each send of episode 0 starts before
 * the first message of each arm. Each send of a later episode starts after the message `until`.
 */
function recordOf(arm: OrderArm, expected: Readonly<Record<CopyPlace, PlaceExpectation>> = expectationOf(arm)): OrderRecord {
  const fetches = { nws: fetchesOf(), ipaws: fetchesOf() };
  const deliveries: OrderDelivery[] = [];
  const attempts: TimedKey[] = [];
  const cancelled: TimedKey[] = [];
  const ends: { person: string; at: number }[] = [];
  const ledger: OrderRecord["ledger"][number][] = [];
  for (const place of ORDER_PLACES) {
    const want = expected[place];
    const person = personOf(place);
    const from = want.away === undefined ? undefined : arrivalOf({ arm, fetches }, want.away.from);
    const until = want.away?.until === undefined ? undefined : arrivalOf({ arm, fetches }, want.away.until);
    for (let end = 0; end < want.ends; end += 1) ends.push({ person, at: (from ?? 0) + 500 });
    for (const [index, send] of want.sends.entries()) {
      const at = send.episode === 0 ? 1000 + index * 100 : (until ?? 0) + 1000 + index * 100;
      const key = messageKey({ incident: ANCHOR, level: send.level, person, step: send.step, episode: send.episode });
      const receipt = `fakereceipt${String(ledger.length).padStart(19, "0")}`;
      deliveries.push({ key, incident: ANCHOR, person, level: send.level, step: send.step, at: at + 50, receipt });
      attempts.push({ key, at });
      if (send.cancelled) cancelled.push({ key, at: (from ?? at) + 600 });
      ledger.push({ receipt, priority: send.level === "life-safety" ? 2 : 1, cancelled: send.cancelled });
    }
  }
  return {
    arm,
    fetches,
    log: { deliveries, attempts, cancelled, ends, starts: [] },
    ledger,
    otherRequests: 0,
    live: { kept: expected.kept.live, dropped: expected.dropped.live },
    failures: [],
    duplicates: [],
    passes: 100,
  };
}

const failedOf = (record: OrderRecord): string[] => GATE_KEYS.filter((gate) => !orderGatesOf(record).gates[gate]);

describe("the lines of the arms", () => {
  it("gives each arm a line whose references name earlier messages, and each message comes at or after its time sent", () => {
    for (const arm of ORDER_ARMS) {
      const line = lineOf(arm);
      for (const [index, message] of line.entries()) {
        const earlier = new Set(line.slice(0, index).map((before) => before.name));
        for (const name of message.references) expect(earlier.has(name), `${arm}: ${message.name} references ${name}`).toBe(true);
        expect(message.nws).toBeGreaterThanOrEqual(message.sent);
        expect(message.ipaws).toBeGreaterThanOrEqual(message.sent);
      }
    }
  });

  it("gives each message of each arm its own id, each sent half an interval before its fetch", () => {
    const ids = ORDER_ARMS.flatMap((arm) => lineReportsOf(arm).map((report) => report.id));
    expect(new Set(ids).size).toBe(ids.length);
    for (const report of lineReportsOf("control")) expect(report.sentAt).toBe(CASE_9_SETTINGS.start + report.message.sent * INTERVAL - INTERVAL / 2);
  });

  it("gives the start of the event to the NEW message only", () => {
    const [alert, update] = lineReportsOf("control");
    if (alert === undefined || update === undefined) throw new Error("no line");
    expect(lineVtecOf(alert)).toBe("/O.NEW.KEWX.FF.W.0901.261109T0021Z-261109T0051Z/");
    expect(lineVtecOf(update)).toBe("/O.CON.KEWX.FF.W.0901.000000T0000Z-261109T0051Z/");
  });

  it("has valid settings, and finds a line that comes too late for a second step", () => {
    expect(orderSettingsProblems(CASE_9_SETTINGS)).toEqual([]);
    expect(orderSettingsProblems({ ...CASE_9_SETTINGS, fetches: 12 }).length).toBeGreaterThan(0);
  });

  it("gives each person an urgent policy and a life-safety policy of two steps, with no quiet window", () => {
    const recipients = orderRecipientsOf();
    expect(recipients.map((recipient) => recipient.watch.person)).toEqual(ORDER_PLACES.map(personOf));
    for (const recipient of recipients) {
      expect(recipient.policies.map((policy) => policy.level)).toEqual(["urgent", "life-safety"]);
      for (const policy of recipient.policies) expect(policy.steps).toHaveLength(2);
      expect(recipient.watch.quiet).toBeUndefined();
    }
  });
});

describe("the reports of the messages", () => {
  it("maps each NWS message and each IPAWS copy to one report with the operation, the time sent, the references and the places of the message", () => {
    for (const arm of ORDER_ARMS) {
      const line = lineReportsOf(arm);
      for (const [index, mapped] of reportsOf(arm).entries()) {
        const report = line[index];
        if (report === undefined) throw new Error("no report");
        expect(mapped.nws.key).toBe(report.id);
        expect(mapped.ipaws.key).toBe(`${report.id}${COPY_SUFFIX}`);
        for (const found of [mapped.nws, mapped.ipaws]) {
          expect(found.op, `${arm}: ${mapped.name}`).toBe(report.message.op);
          expect(found.sent).toBe(report.sentAt);
          expect(codesOf(found).sort()).toEqual(report.message.places.map((place) => PLACE_COUNTIES[place].ugc).sort());
          if (report.message.op !== "cancel") expect(found.severity).toBe(report.message.severity.toLowerCase());
        }
        expect(mapped.nws.references).toEqual(report.references.map((reference) => reference.id));
        expect(mapped.ipaws.references).toEqual(report.references.map((reference) => `${reference.id}${COPY_SUFFIX}`));
      }
    }
  });

  it("maps the second form of a message to the same report id as the first form", () => {
    for (const report of lineReportsOf("duplicates")) {
      const at = report.sentAt + INTERVAL / 2;
      const feature = lineFeatureOf(report, PAIR.newFeature);
      const copy = lineCopyOf(report, PAIR.newCopy);
      expect(JSON.stringify(reorderedFeatureOf(feature))).not.toBe(JSON.stringify(feature));
      expect(spacedCopyOf(copy)).not.toBe(copy);
      expect(one(mapNws(observe(NWS_ID, JSON.stringify(reorderedFeatureOf(feature)), "application/geo+json", at))).id).toBe(one(mapNws(observe(NWS_ID, JSON.stringify(feature), "application/geo+json", at))).id);
      expect(one(mapIpaws(observe(IPAWS_ID, spacedCopyOf(copy), "application/xml", at))).id).toBe(one(mapIpaws(observe(IPAWS_ID, copy, "application/xml", at))).id);
    }
  });

  it("gives a threat at each place before the cancel of the control, and no threat after it", () => {
    const mapped = reportsOf("control");
    const before = mapped.filter((item) => item.name !== "cancel").flatMap((item) => [item.nws, item.ipaws]);
    const at = CASE_9_SETTINGS.start + 8 * INTERVAL;
    expect(threatenedOf(before, at)).toEqual(["dropped", "kept"]);
    expect(threatenedOf(mapped.flatMap((item) => [item.nws, item.ipaws]), at)).toEqual([]);
  });

  it("keeps the threat at the place kept only, after the cancel and the update of the NWS form of a partial cancel", () => {
    const mapped = reportsOf("partial-nws");
    expect(threatenedOf(mapped.flatMap((item) => [item.nws, item.ipaws]), CASE_9_SETTINGS.start + 8 * INTERVAL)).toEqual(["kept"]);
  });

  it("gives no threat when the IPAWS cancel comes before the NWS messages that it cancels", () => {
    const mapped = reportsOf("cancel-first");
    const reports = [...mapped.map((item) => item.ipaws), ...mapped.filter((item) => item.name !== "cancel").map((item) => item.nws)];
    expect(threatenedOf(reports, CASE_9_SETTINGS.start + 10 * INTERVAL)).toEqual([]);
  });
});

describe("the bodies of each fetch", () => {
  const countOf = (text: string, part: string): number => text.split(part).length - 1;
  const featuresOf = (body: string): number => (JSON.parse(body) as { features: unknown[] }).features.length;

  it("keeps each NWS message in the list from its first fetch to the end", () => {
    const bodies = orderBodiesOf("control");
    expect(bodies.zone.map(featuresOf)).toEqual([0, 0, 1, 1, 2, 2, 3, 3, 3, 3, 3, 3, 3, 3, 3, 3]);
  });

  it("gives each NWS message two times in the arm duplicates, and its second form from the next fetch", () => {
    const bodies = orderBodiesOf("duplicates");
    expect(bodies.zone.slice(0, 6).map(featuresOf)).toEqual([0, 0, 2, 3, 5, 6]);
  });

  it("gives each IPAWS copy in FEED_SPAN feeds, and in the arm duplicates in DUPLICATE_FEEDS feeds and then its second form", () => {
    const copies = (arm: OrderArm): number[] => orderBodiesOf(arm).feed.map((feed) => countOf(feed, "<alert xmlns"));
    expect(FEED_SPAN).toBe(2);
    expect(copies("control")).toEqual([0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0]);
    expect(DUPLICATE_FEEDS).toBe(3);
    const duplicates = orderBodiesOf("duplicates").feed;
    expect(duplicates.map((feed) => countOf(feed, "<alert xmlns"))).toEqual([0, 0, 1, 1, 2, 2, 2, 2, 1, 1, 0, 0, 0, 0, 0, 0]);
    expect(duplicates.map((feed) => countOf(feed, "\n</alert>") > 0)).toEqual([
      false,
      false,
      false,
      false,
      false,
      true,
      false,
      true,
      false,
      true,
      false,
      false,
      false,
      false,
      false,
      false,
    ]);
  });

  it("gives the IPAWS cancel first in the arm cancel-first", () => {
    const feeds = orderBodiesOf("cancel-first").feed;
    const first = feeds.findIndex((feed) => feed.includes("<msgType>"));
    expect(first).toBe(4);
    expect(feeds[first]).toContain("<msgType>Cancel</msgType>");
  });

  it("gives a fresh keepalive in each canary body", () => {
    const canary = orderBodiesOf("control").canary.map((body) => Buffer.from(body).toString("utf8"));
    expect(new Set(canary).size).toBe(canary.length);
  });
});

describe("the gates", () => {
  it("passes each gate of each arm for a record of its expectation", () => {
    for (const arm of ORDER_ARMS) expect(failedOf(recordOf(arm)), arm).toEqual([]);
  });

  it("labels each send with its level, step and episode", () => {
    expect(sendLabel({ level: "life-safety", step: 1, episode: 0 })).toBe("ls10");
    expect(sendLabel({ level: "urgent", step: 0, episode: 1, cancelled: true })).toBe("u01c");
  });

  it("fails sends for an extra send, and ends for an extra end", () => {
    const record = recordOf("control");
    const extra = { ...record, log: { ...record.log, deliveries: [...record.log.deliveries, { ...(record.log.deliveries[0] as OrderDelivery), key: "extra", step: 2 }] } };
    expect(failedOf(extra)).toContain("kept:sends");
    const ended = { ...record, log: { ...record.log, ends: [{ person: personOf("dropped"), at: 9 * INTERVAL }] } };
    expect(failedOf(ended)).toEqual(["dropped:ends"]);
  });

  it("fails quietAway for a send that starts while the threat is away, and passes a send that starts before", () => {
    const record = recordOf("control");
    const from = arrivalOf(record, "cancel") ?? 0;
    const kept = record.log.deliveries.find((delivery) => delivery.person === personOf("kept"));
    if (kept === undefined) throw new Error("no send");
    const late = (at: number): OrderRecord => ({ ...record, log: { ...record.log, attempts: record.log.attempts.map((attempt) => (attempt.key === kept.key ? { ...attempt, at } : attempt)) } });
    expect(failedOf(late(from + 1000))).toEqual(["kept:quietAway"]);
    expect(failedOf(late(from - 1000))).toEqual([]);
  });

  it("fails episodes for a key of another episode", () => {
    const record = recordOf("control");
    const [first] = record.log.deliveries;
    if (first === undefined) throw new Error("no send");
    const key = messageKey({ incident: ANCHOR, level: first.level, person: personOf("kept"), step: first.step, episode: 1 });
    const swapped: OrderRecord = {
      ...record,
      log: {
        ...record.log,
        deliveries: record.log.deliveries.map((delivery) => (delivery.key === first.key ? { ...delivery, key } : delivery)),
        attempts: record.log.attempts.map((attempt) => (attempt.key === first.key ? { ...attempt, key } : attempt)),
        cancelled: record.log.cancelled.map((one) => (one.key === first.key ? { ...one, key } : one)),
      },
    };
    expect(failedOf(swapped)).toEqual(["kept:episodes"]);
  });

  it("fails oneKey for a second attempt of a key, and for a key that the channel accepted again", () => {
    const record = recordOf("control");
    const [attempt] = record.log.attempts;
    if (attempt === undefined) throw new Error("no attempt");
    expect(failedOf({ ...record, log: { ...record.log, attempts: [...record.log.attempts, { ...attempt, at: attempt.at + 10 }] } })).toEqual(["kept:oneKey"]);
    expect(failedOf({ ...record, duplicates: [attempt.key] })).toEqual(["kept:oneKey"]);
  });

  it("fails receipts when Pushover got a cancel that the log does not have, and live for a threat that stays", () => {
    const record = recordOf("partial-lone");
    const keptLs = record.log.deliveries.find((delivery) => delivery.person === personOf("kept") && delivery.level === "life-safety");
    if (keptLs === undefined) throw new Error("no send");
    expect(failedOf({ ...record, ledger: record.ledger.map((entry) => (entry.receipt === keptLs.receipt ? { ...entry, cancelled: true } : entry)) })).toEqual(["kept:receipts"]);
    expect(failedOf({ ...record, live: { kept: true, dropped: true } })).toEqual(["dropped:live"]);
  });
});

describe("the verdict", () => {
  const send = (level: "urgent" | "life-safety", step: number, cancelled: boolean) => ({ level, step, episode: 0, cancelled });
  /** The outcome before alerts #127. A cancel of a part of the areas ends the whole report. The update of re-entry gives the late step 1. */
  const BEFORE_127: Partial<Record<OrderArm, Readonly<Record<CopyPlace, PlaceExpectation>>>> = {
    "partial-lone": {
      kept: { sends: [send("urgent", 0, true), send("life-safety", 0, true)], ends: 0, live: false },
      dropped: { sends: [send("urgent", 0, true), send("life-safety", 0, true)], ends: 0, live: false },
    },
    "re-entry": {
      kept: { sends: [send("urgent", 0, true), send("life-safety", 0, true), send("life-safety", 1, false)], ends: 0, live: true },
      dropped: { sends: [send("urgent", 0, true), send("life-safety", 0, true), send("life-safety", 1, false)], ends: 0, live: true },
    },
  };

  /** The gates that the outcome before alerts #127 fails. */
  const FAULTS_127: readonly OrderKnownFault[] = [
    ["partial-lone", "kept:sends"],
    ["partial-lone", "kept:cancels"],
    ["partial-lone", "kept:live"],
    ["partial-lone", "dropped:ends"],
    ["re-entry", "kept:cancels"],
    ["re-entry", "dropped:sends"],
    ["re-entry", "dropped:ends"],
  ].map(([arm, gate]) => ({ arm: arm as OrderArm, gate: gate as GateKey, reason: "alerts #127" }));

  it("passes for the records of the expectations, with no known fault", () => {
    expect(ORDER_KNOWN_FAULTS).toEqual([]);
    const verdict = orderVerdictOf(ORDER_ARMS.map((arm) => recordOf(arm)));
    expect(verdict.problems).toEqual([]);
    expect(verdict.fixed).toEqual([]);
    expect(verdict.pass).toBe(true);
  });

  it("fails the outcome before alerts #127 at each gate of the fault, and passes it when these gates are known faults", () => {
    const records = ORDER_ARMS.map((arm) => recordOf(arm, BEFORE_127[arm]));
    const verdict = orderVerdictOf(records);
    expect(verdict.read).toBe(true);
    expect(verdict.pass).toBe(false);
    expect(verdict.problems).toEqual(FAULTS_127.map((fault) => `${fault.arm}: the gate ${fault.gate} fails.`));
    expect(orderVerdictOf(records, CASE_9_SETTINGS, FAULTS_127).pass).toBe(true);
  });

  it("names each known fault that passes, and the verdict then fails", () => {
    const verdict = orderVerdictOf(
      ORDER_ARMS.map((arm) => recordOf(arm)),
      CASE_9_SETTINGS,
      FAULTS_127,
    );
    expect(verdict.read).toBe(true);
    expect(verdict.fixed).toHaveLength(FAULTS_127.length);
    expect(verdict.pass).toBe(false);
  });

  it("has no read for a missing arm, a failed fetch or a failed call of the delivery", () => {
    const records = ORDER_ARMS.map((arm) => recordOf(arm));
    expect(orderVerdictOf(records.slice(1)).read).toBe(false);
    const [first, ...rest] = records;
    if (first === undefined) throw new Error("no record");
    const failed = { ...first, fetches: { ...first.fetches, ipaws: first.fetches.ipaws.map((fetch, index) => (index === 3 ? { ...fetch, ok: false } : fetch)) } };
    expect(orderVerdictOf([failed, ...rest]).read).toBe(false);
    expect(orderVerdictOf([{ ...first, failures: [{ at: 0, call: "send", kind: "network", message: "reset" }] }, ...rest]).read).toBe(false);
    expect(orderVerdictOf([failed, ...rest]).pass).toBe(false);
  });
});

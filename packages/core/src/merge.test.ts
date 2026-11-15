import { canonicalJson, random, seedsFrom, type Random } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import type { Acknowledgment, ChannelId, Delivery, Incident, MergeState, ObservationId, PersonId, Report, SourceId, Status } from "./contracts.ts";
import { reportId } from "./ids.ts";
import { EMPTY_STATE, acknowledgedLevel, add, incidents, join, normalize, sentLevel, type LinkRule } from "./merge.ts";

const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4, 5, 6, 7, 8]);
const HOUR = 3_600_000;
const T0 = 1_763_157_600_000;
const person = "person-1" as PersonId;
const pushover = "pushover" as ChannelId;

interface Draft extends Partial<Omit<Report, "id" | "source">> {
  readonly source?: string;
  readonly key: string;
}

function report(draft: Draft): Report {
  const source = (draft.source ?? "nws-api") as SourceId;
  const sent = draft.sent ?? T0;
  const { source: _source, ...rest } = draft;
  return {
    origin: "nws",
    references: [],
    correlation: [],
    status: "actual",
    op: "alert",
    kind: { code: "met.tornado", significance: "warning", label: "Tornado Warning" },
    categories: ["met"],
    severity: "extreme",
    urgency: "immediate",
    certainty: "observed",
    response: ["shelter"],
    received: sent,
    expires: sent + HOUR,
    areas: [{ type: "code", system: "ugc", code: "KSZ083" }],
    about: [],
    sender: "NWS Topeka KS",
    headline: "Tornado Warning",
    observation: "0".repeat(64) as ObservationId,
    parameters: {},
    ...rest,
    id: reportId({ source, key: draft.key, sent }),
    source,
    sent,
  };
}

const same = (a: unknown, b: unknown): void => expect(canonicalJson(a, { form: "json" })).toBe(canonicalJson(b, { form: "json" }));

// A random state over a small pool, so that two states share parts and have conflicts.
function randomState(r: Random): MergeState {
  const reports: Report[] = [];
  const deliveries: Delivery[] = [];
  const acks: Acknowledgment[] = [];
  for (let i = r.int(0, 8); i > 0; i -= 1) {
    const event = r.below(4);
    const key = `k${event}.${r.below(3)}`;
    reports.push(
      report({
        key,
        source: r.pick(["nws-api", "ipaws"]),
        origin: r.pick(["nws", "usgs"]),
        sent: T0 + r.below(3) * 60_000,
        references: r.chance(0.4) ? [`k${event}.${r.below(3)}`] : [],
        correlation: r.chance(0.5) ? [{ system: "vtec", id: `KTOP.TO.W.${event}` }] : [],
        // Two sizes of area, so that the rule of the copies replaces some reports and keeps others.
        areas: r.chance(0.5) ? [{ type: "code", system: "ugc", code: "KSZ083" }] : [{ type: "code", system: "ugc", code: "KSZ083" }, { type: "code", system: "ugc", code: "KSZ084" }],
        // An unknown value takes a value of its event, so the laws also hold for the fill.
        severity: r.pick(["unknown", "moderate", "severe", "extreme"] as const),
        urgency: r.pick(["unknown", "expected", "immediate"] as const),
        op: r.pick(["alert", "update", "cancel"] as const),
        status: r.chance(0.9) ? "actual" : "test",
        // Two contents for one id: the merge keeps the smaller canonical JSON.
        headline: r.pick(["Tornado Warning", "Tornado Warning (copy)"]),
      }),
    );
  }
  for (let i = r.int(0, 3); i > 0; i -= 1) {
    const incident = reports.length > 0 ? r.pick(reports).id : report({ key: "k0.0" }).id;
    deliveries.push({ key: `m${r.below(4)}`, incident, level: r.pick(["notice", "urgent", "life-safety"] as const), person, channel: pushover, step: r.below(2), at: T0, ...(r.chance(0.5) ? { receipt: { id: `r${r.below(3)}` } } : {}) });
  }
  for (let i = r.int(0, 2); i > 0; i -= 1) {
    const incident = reports.length > 0 ? r.pick(reports).id : report({ key: "k0.0" }).id;
    acks.push({ incident, level: r.pick(["urgent", "life-safety"] as const), person, at: T0 + r.below(3), via: "ui" });
  }
  return normalize({ reports, deliveries, acks });
}

describe("the join", () => {
  it.each(SEEDS)("is idempotent, commutative and associative (seed %i)", (seed) => {
    const r = random(seed);
    for (let round = 0; round < 50; round += 1) {
      const [a, b, c] = [randomState(r), randomState(r), randomState(r)];
      same(join(a, a), a);
      same(join(a, b), join(b, a));
      same(join(join(a, b), c), join(a, join(b, c)));
      same(join(a, EMPTY_STATE), a);
    }
  });

  it.each(SEEDS)("gives the same incidents for each order of arrival (seed %i)", (seed) => {
    const r = random(seed);
    for (let round = 0; round < 30; round += 1) {
      const all = join(join(randomState(r), randomState(r)), randomState(r));
      const parts = [...all.reports.map((x) => ({ reports: [x] })), ...all.deliveries.map((x) => ({ deliveries: [x] })), ...all.acks.map((x) => ({ acks: [x] }))];
      // Each part arrives one or more times, in a random order.
      const arrivals = r.shuffle([...parts, ...r.sample(parts, r.int(0, parts.length))]);
      const built = arrivals.reduce(add, EMPTY_STATE);
      same(built, all);
      const at = T0 + r.below(3) * HOUR;
      same(incidents(built, at), incidents(all, at));
    }
  });

  it("keeps one report for an id with two contents: the smaller canonical JSON", () => {
    const a = report({ key: "k", headline: "B" });
    const b = report({ key: "k", headline: "A" });
    expect(normalize({ reports: [a, b] }).reports).toEqual([b]);
    expect(normalize({ reports: [b, a] }).reports).toEqual([b]);
  });

  it("keeps each delivery and each acknowledgment one time", () => {
    const delivery: Delivery = { key: "m", incident: report({ key: "k" }).id, level: "urgent", person, channel: pushover, step: 0, at: T0 };
    const state = add(add(EMPTY_STATE, { deliveries: [delivery] }), { deliveries: [{ ...delivery }] });
    expect(state.deliveries).toHaveLength(1);
  });
});

describe("the incidents", () => {
  it("links an update and a cancel to their alert by the references (rule 1)", () => {
    const alert = report({ key: "a1" });
    const update = report({ key: "a2", references: ["a1"], op: "update", severity: "severe", sent: T0 + 60_000 });
    const [one] = incidents(normalize({ reports: [alert, update] }), T0);
    expect(one?.reports).toHaveLength(2);
    // The update is the head of the line, so its severity counts, not the severity of the alert.
    expect(one?.severity).toBe("severe");
    expect(one?.live).toBe(true);

    const cancel = report({ key: "a3", references: ["a2"], op: "cancel", sent: T0 + 120_000 });
    const [after] = incidents(normalize({ reports: [alert, update, cancel] }), T0);
    expect(after?.reports).toHaveLength(3);
    expect(after?.live).toBe(false);
  });

  it("links the copy of another source by a shared correlation key (rule 2), and counts the origins", () => {
    // The NWS API and IPAWS give one warning different CAP identifiers. Only the VTEC key links them.
    const vtec = [{ system: "vtec", id: "KTOP.TO.W.0038.2026" }];
    const api = report({ key: "urn:oid:2.49.0.1.840.0.example.001.1", correlation: vtec });
    const ipaws = report({ source: "ipaws", key: "urn:oid:2.49.0.1.840.0.example.001.1.IPAWS", correlation: vtec, sent: T0 + 30_000 });
    const [one, ...rest] = incidents(normalize({ reports: [api, ipaws] }), T0);
    expect(rest).toEqual([]);
    expect(one?.reports).toHaveLength(2);
    // Both copies come from the NWS: one witness, two times.
    expect(one?.corroboration).toBe(1);

    const quake = report({ source: "usgs", origin: "usgs", key: "us7000example", correlation: vtec });
    expect(incidents(normalize({ reports: [api, ipaws, quake] }), T0)[0]?.corroboration).toBe(2);
  });

  it("does not link a reference of one source to a key of another source", () => {
    const a = report({ key: "k1" });
    const b = report({ source: "ipaws", key: "k2", references: ["k1"] });
    expect(incidents(normalize({ reports: [a, b] }), T0)).toHaveLength(2);
  });

  it("keeps the reports of two statuses apart", () => {
    const correlation = [{ system: "vtec", id: "KTOP.TO.W.0001.2026" }];
    const statuses: Status[] = ["actual", "test"];
    const list = incidents(normalize({ reports: statuses.map((status) => report({ key: status, status, correlation })) }), T0);
    expect(list.map((incident) => incident.status).sort()).toEqual(statuses);
  });

  it("is not live after each head expires, and it is open while one head has no end", () => {
    const short = report({ key: "s", expires: T0 + HOUR });
    const long = report({ key: "l", expires: T0 + 2 * HOUR, correlation: [{ system: "vtec", id: "x" }] });
    const state = normalize({ reports: [short, long] });
    const holding = (list: readonly Incident[], r: Report): Incident | undefined => list.find((i) => i.reports.includes(r.id));
    // The end time is not part of the live time: at the end, the report is expired.
    const atOneHour = incidents(state, T0 + HOUR);
    expect(holding(atOneHour, short)?.live).toBe(false);
    expect(holding(atOneHour, long)?.live).toBe(true);
    expect(incidents(state, T0 + 2 * HOUR).every((i) => !i.live)).toBe(true);

    expect(incidents(normalize({ reports: [long] }), T0)[0]?.expires).toBe(T0 + 2 * HOUR);
    const { expires: _end, ...open } = report({ source: "ipaws", key: "o", correlation: [{ system: "vtec", id: "x" }] });
    const [linked] = incidents(normalize({ reports: [long, open] }), T0 + 3 * HOUR);
    expect(linked?.expires).toBeUndefined();
    expect(linked?.live).toBe(true);
  });

  it("gives each report a head when the references make a cycle, and does not throw", () => {
    const a = report({ key: "a", references: ["b"] });
    const b = report({ key: "b", references: ["a"] });
    const [one] = incidents(normalize({ reports: [a, b] }), T0);
    expect(one?.reports).toHaveLength(2);
    expect(one?.live).toBe(true);
  });

  it("links by the link rule only inside a block, and the links are transitive (rule 3)", () => {
    let tests = 0;
    const rule: LinkRule = {
      blocks: (r) => [r.kind.code],
      matches: (a, b) => {
        tests += 1;
        return Math.abs(a.sent - b.sent) <= 10 * 60_000;
      },
    };
    const reports = [
      report({ key: "t1", sent: T0 }),
      report({ key: "t2", sent: T0 + 8 * 60_000 }),
      report({ key: "t3", sent: T0 + 16 * 60_000 }),
      report({ key: "q1", sent: T0, kind: { code: "geo.earthquake", label: "Earthquake" } }),
    ];
    const list = incidents(normalize({ reports }), T0, { link: rule });
    expect(list.map((incident) => incident.reports.length).sort()).toEqual([1, 3]);
    // Three pairs share the tornado block. The earthquake shares no block, so the rule does not test it.
    expect(tests).toBe(3);
  });

  it("gives the incidents in the order of their anchors, and the anchor is the smallest report id", () => {
    const list = incidents(randomState(random(11)), T0);
    expect(list.map((i) => i.anchor)).toEqual([...list.map((i) => i.anchor)].sort());
    for (const incident of list) expect(incident.anchor).toBe([...incident.reports].sort()[0]);
  });
});

describe("the copies of one event", () => {
  const vtec = [{ system: "vtec", id: "KTOP.TO.W.0012.2025" }];
  const codes = (...list: string[]): Report["areas"] => list.map((code) => ({ type: "code", system: "ugc", code }));
  const later = T0 + 600_000;
  const at = T0 + 700_000;
  // The alert of the NWS API, and a copy of it from IPAWS: one origin, one VTEC event, one sent time.
  const alert = report({ key: "api-1", correlation: vtec, areas: codes("KSC177", "KSC045") });
  const copy = report({ key: "ipaws-1", source: "ipaws", correlation: vtec, areas: codes("KSC177", "KSC045") });
  const liveOf = (...reports: Report[]): boolean | undefined => incidents(normalize({ reports }), at)[0]?.live;

  it("ends the copy of another source when a later report of the origin names each of its codes", () => {
    const cancel = report({ key: "api-2", op: "cancel", sent: later, references: ["api-1"], correlation: vtec, areas: codes("KSC177", "KSC045") });
    expect(liveOf(alert, copy)).toBe(true);
    expect(liveOf(alert, copy, cancel)).toBe(false);
    // A later update replaces the copy too: the incident takes its severity.
    const update = report({ key: "api-2", op: "update", sent: later, references: ["api-1"], correlation: vtec, areas: codes("KSC177", "KSC045"), severity: "severe" });
    expect(incidents(normalize({ reports: [alert, copy, update] }), at)[0]?.severity).toBe("severe");
  });

  it("keeps the copy live when the later reports name only a part of its codes", () => {
    // The NWS cancels the warning for one county. The update for the other county is missing.
    const partial = report({ key: "api-2", op: "cancel", sent: later, references: ["api-1"], correlation: vtec, areas: codes("KSC045") });
    const [incident] = incidents(normalize({ reports: [alert, copy, partial] }), at);
    expect(incident?.live).toBe(true);
    expect(incident?.areas).toContainEqual({ type: "code", system: "ugc", code: "KSC177" });
  });

  it("does not end a copy of another origin, of the same sent time, of another event or with no code", () => {
    const cancel = (fields: Partial<Draft>): Report => report({ key: "api-2", op: "cancel", sent: later, references: ["api-1"], correlation: vtec, areas: codes("KSC177", "KSC045"), ...fields });
    expect(liveOf(alert, { ...copy, origin: "fema" }, cancel({}))).toBe(true);
    expect(liveOf(alert, copy, cancel({ sent: T0 }))).toBe(true);
    const other = report({ key: "ipaws-1", source: "ipaws", correlation: [{ system: "vtec", id: "KTOP.TO.W.0013.2025" }, ...vtec], areas: codes("KSC177", "KSC045") });
    // The copy shares the event of the cancel, so the cancel ends it. A copy that shares no key is not in the incident.
    expect(liveOf(alert, other, cancel({}))).toBe(false);
    const shapeOnly = report({ key: "ipaws-1", source: "ipaws", correlation: vtec, areas: [{ type: "polygon", rings: [[[-95.8, 39.0], [-95.6, 39.0], [-95.6, 39.1], [-95.8, 39.0]]] }] });
    expect(liveOf(alert, shapeOnly, cancel({}))).toBe(true);
  });

  it("ends a report when the later reports together name each of its codes", () => {
    // IEM gives one row for each county. Each row is a report of its own.
    const row = (code: string, op: Report["op"], sent = later): Report => report({ key: `iem-${code}-${sent}`, source: "iem", op, sent, correlation: vtec, areas: codes(code) });
    expect(liveOf(alert, row("KSC177", "cancel"), row("KSC045", "cancel"))).toBe(false);
    // The authority ends one county and keeps the other: the incident keeps only the other county.
    const [incident] = incidents(normalize({ reports: [alert, row("KSC177", "cancel"), row("KSC045", "update")] }), at);
    expect(incident?.live).toBe(true);
    expect(incident?.areas).toEqual(codes("KSC045"));
    // The rows of the first message end when the NWS API cancels the two counties.
    const cancel = report({ key: "api-2", op: "cancel", sent: later, references: ["api-1"], correlation: vtec, areas: codes("KSC177", "KSC045") });
    expect(liveOf(alert, row("KSC177", "alert", T0), row("KSC045", "alert", T0), cancel)).toBe(false);
  });

  it("fills an unknown value from the latest earlier report of the event that is not a cancel", () => {
    // IEM gives no severity, urgency or certainty.
    const blank = { severity: "unknown", urgency: "unknown", certainty: "unknown" } as const;
    const row = (code: string, sent: number): Report => report({ key: `iem-${code}-${sent}`, source: "iem", sent, correlation: vtec, areas: codes(code), ...blank });
    const api = report({ key: "api-1", correlation: vtec, areas: codes("KSC177", "KSC045"), severity: "moderate", urgency: "expected", certainty: "likely" });
    const values = (...reports: Report[]): unknown => {
      const [incident] = incidents(normalize({ reports }), at);
      return { live: incident?.live, severity: incident?.severity, urgency: incident?.urgency, certainty: incident?.certainty };
    };
    // The rows of a later product replace the message of the NWS API, and keep its values.
    expect(values(api, row("KSC177", later), row("KSC045", later))).toEqual({ live: true, severity: "moderate", urgency: "expected", certainty: "likely" });
    // With no known value, the value stays unknown.
    expect(values(row("KSC177", later))).toEqual({ live: true, ...blank });
    // A cancel gives the values of an end, so a row after the cancel takes the values of the alert.
    const cancel = report({ key: "api-2", op: "cancel", sent: later, references: ["api-1"], correlation: vtec, areas: codes("KSC177", "KSC045"), severity: "minor", urgency: "past", certainty: "observed" });
    expect(values(api, cancel, row("KSC177", later + 60_000))).toEqual({ live: true, severity: "moderate", urgency: "expected", certainty: "likely" });
    // A known value of a later report does not fill an earlier report. This later report has expired, so it is not live.
    const late = report({ key: "api-9", sent: at, expires: at, correlation: vtec, areas: codes("KSC139"), severity: "extreme", urgency: "immediate", certainty: "observed" });
    expect(values(row("KSC177", later), late)).toEqual({ live: true, ...blank });
  });

  it.each(SEEDS)("is live exactly when the latest report of some code is not a cancel (seed %i)", (seed) => {
    const r = random(seed);
    const pool = ["KSC177", "KSC045", "KSC139", "KSC197"];
    for (let round = 0; round < 50; round += 1) {
      const reports = Array.from({ length: r.int(2, 6) }, (_, i) =>
        report({
          key: `k${i}`,
          source: r.pick(["nws-api", "ipaws", "iem"]),
          sent: T0 + r.below(4) * 60_000,
          op: r.pick(["alert", "update", "cancel"] as const),
          correlation: vtec,
          // Half of the reports name one code, as the rows of IEM do.
          areas: codes(...r.sample(pool, r.chance(0.5) ? 1 : r.int(1, pool.length))),
          severity: r.pick(["unknown", "minor", "moderate", "severe", "extreme"] as const),
          urgency: r.pick(["unknown", "future", "expected", "immediate"] as const),
        }),
      );
      const [incident] = incidents(normalize({ reports }), at);
      // The latest statements of each code: the reports with the latest sent time that name the code.
      let live = false;
      for (const code of pool) {
        const naming = reports.filter((held) => held.areas.some((area) => area.type === "code" && area.code === code));
        const last = Math.max(...naming.map((held) => held.sent));
        if (!naming.some((held) => held.sent === last && held.op !== "cancel")) continue;
        // No later report names this code, so the incident keeps it.
        live = true;
        expect(incident?.areas, `seed ${seed} round ${round}`).toContainEqual({ type: "code", system: "ugc", code });
      }
      expect(incident?.live, `seed ${seed} round ${round}`).toBe(live);
      // The oracle: the rule in its direct form. A report stays a head when a code of it has no later report.
      const named = (held: Report, code: string): boolean => held.areas.some((area) => area.type === "code" && area.code === code);
      const heads = reports.filter((held) => pool.some((code) => named(held, code) && !reports.some((other) => other.sent > held.sent && named(other, code))));
      const liveHeads = heads.filter((held) => held.op !== "cancel");
      const basis = liveHeads.length > 0 ? liveHeads : heads;
      const expected = [...new Set(basis.flatMap((held) => held.areas.map((area) => (area.type === "code" ? area.code : ""))))].sort();
      expect(incident?.areas.map((area) => (area.type === "code" ? area.code : "")).sort(), `seed ${seed} round ${round}`).toEqual(expected);
      // The oracle of the values: an unknown value takes the highest value of the latest earlier known reports that are not cancels.
      const fill = <F extends "severity" | "urgency">(held: Report, field: F, order: readonly Report[F][]): number => {
        if (held[field] !== "unknown") return order.indexOf(held[field]);
        const known = reports.filter((other) => other.op !== "cancel" && other[field] !== "unknown" && other.sent <= held.sent);
        const last = Math.max(...known.map((other) => other.sent));
        return Math.max(0, ...known.filter((other) => other.sent === last).map((other) => order.indexOf(other[field])));
      };
      const severities = ["unknown", "minor", "moderate", "severe", "extreme"] as const;
      const urgencies = ["unknown", "past", "future", "expected", "immediate"] as const;
      expect(incident?.severity, `seed ${seed} round ${round}`).toBe(severities[Math.max(...basis.map((held) => fill(held, "severity", severities)))]);
      expect(incident?.urgency, `seed ${seed} round ${round}`).toBe(urgencies[Math.max(...basis.map((held) => fill(held, "urgency", urgencies)))]);
    }
  });
});

describe("the levels of a person", () => {
  const alert = report({ key: "a1" });
  const copy = report({ source: "ipaws", key: "a1.IPAWS", correlation: [{ system: "vtec", id: "KTOP.TO.W.0002.2026" }] });
  const linked = report({ key: "a2", correlation: [{ system: "vtec", id: "KTOP.TO.W.0002.2026" }], references: ["a1"] });
  const send = (incident: Report, level: Delivery["level"]): Delivery => ({
    key: `${incident.key}.${level}`,
    incident: incident.id,
    level,
    person,
    channel: pushover,
    step: 0,
    at: T0,
  });

  it("gives the highest level of the deliveries to the person", () => {
    const state = normalize({ reports: [alert], deliveries: [send(alert, "notice"), send(alert, "urgent")] });
    const [incident] = incidents(state, T0);
    expect(sentLevel(state, incident!, person)).toBe("urgent");
    expect(sentLevel(state, incident!, "person-2" as PersonId)).toBeUndefined();
  });

  it("keeps the sent level and the acknowledgment when two incidents merge", () => {
    const before = normalize({
      reports: [alert, copy],
      deliveries: [send(copy, "urgent")],
      acks: [{ incident: copy.id, level: "urgent", person, at: T0, via: "ui" }],
    });
    expect(incidents(before, T0)).toHaveLength(2);
    const after = add(before, { reports: [linked] });
    const [merged, ...rest] = incidents(after, T0);
    expect(rest).toEqual([]);
    expect(sentLevel(after, merged!, person)).toBe("urgent");
    expect(acknowledgedLevel(after, merged!, person)).toBe("urgent");
  });
});

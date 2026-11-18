import { describe, expect, it } from "vitest";
import type { AssessPolicy, Delivery, Incident, MergeState, PersonId, PersonWatch, PlaceId, Report, ReportId, Severity, SourceId, WatchedPlace } from "./contracts.ts";
import { incidents } from "./merge.ts";
import { durationText, mostInWindow, OBSERVE_DIGEST_PER_DAY, OBSERVE_WINDOW, observeConditions, observeCut, observeVerdict } from "./observe.ts";
import { DEFAULT_SEND_LIMITS } from "./send-limit.ts";

const HOUR = 3_600_000;
const T0 = Date.UTC(2026, 3, 1, 18);
const NEW = "gtfs-new" as SourceId;
const OLD = "nws-api" as SourceId;
const person = "person-1" as PersonId;
const home = "place-1" as PlaceId;
const places: readonly WatchedPlace[] = [{ id: home, codes: [{ system: "ugc", code: "KSC173" }], bufferKm: 5 }];
const watch: PersonWatch = { person, places: [home], rules: [] };
const atHome = [{ type: "code", system: "ugc", code: "KSC173" }] as const;
const away = [{ type: "code", system: "ugc", code: "KSC015" }] as const;

/** A policy where the severity alone gives the level: extreme is life-safety, severe urgent, moderate notice and minor digest. */
const BY_SEVERITY: AssessPolicy = {
  statuses: ["actual"],
  classes: [],
  otherwise: {
    severity: { extreme: "life-safety", severe: "urgent", moderate: "notice", minor: "digest", unknown: "none" },
    urgency: { immediate: "life-safety", expected: "life-safety", future: "life-safety", past: "life-safety", unknown: "life-safety" },
  },
};

const idOf = (n: number): ReportId => n.toString(16).padStart(64, "0") as ReportId;

function report(n: number, received: number, fields: { readonly source?: SourceId; readonly severity?: Severity; readonly areas?: Report["areas"] } = {}): Report {
  return {
    id: idOf(n),
    source: fields.source ?? NEW,
    origin: "test",
    key: `k${String(n)}`,
    references: [],
    correlation: [],
    status: "actual",
    op: "alert",
    kind: { code: "met.flood", label: "Flood" },
    categories: ["met"],
    severity: fields.severity ?? "moderate",
    urgency: "immediate",
    certainty: "observed",
    response: ["monitor"],
    sent: received,
    received,
    areas: fields.areas ?? atHome,
    about: [],
    sender: "test",
    headline: `report ${String(n)}`,
    observation: "obs" as Report["observation"],
    parameters: {},
  };
}

const stateOf = (reports: readonly Report[], deliveries: readonly Delivery[] = []): MergeState => ({ reports, deliveries, acks: [], ends: [], retired: [] });

describe("durationText", () => {
  it("gives a duration in plain words", () => {
    expect([durationText(HOUR), durationText(2 * HOUR), durationText(30 * 60_000), durationText(60_000)]).toEqual(["1 hour", "2 hours", "30 minutes", "1 minute"]);
  });
});

describe("mostInWindow", () => {
  it("gives the most times in one window, with its start and not its end", () => {
    expect(mostInWindow([], HOUR)).toBe(0);
    expect(mostInWindow([20, 0, 10], 15)).toBe(2);
    expect(mostInWindow([0, 15], 15)).toBe(1);
    expect(mostInWindow([0, 14], 15)).toBe(2);
    expect(mostInWindow([5, 5, 5], 1)).toBe(3);
  });
});

describe("observeCut", () => {
  const cut = (reports: readonly Report[], observing: readonly SourceId[], deliveries: readonly Delivery[] = []) => {
    const state = stateOf(reports, deliveries);
    return observeCut({ incidents: incidents(state, T0), state, observing: new Set(observing), people: [watch], places, assess: BY_SEVERITY, at: T0 });
  };

  it("sends each incident when no source observes", () => {
    const found = cut([report(1, T0)], []);
    expect(found.sent.map((incident) => incident.anchor)).toEqual([idOf(1)]);
    expect(found.held).toEqual([]);
  });

  it("holds an incident below life-safety when each report comes from an observing source", () => {
    const found = cut([report(1, T0, { severity: "severe" }), report(2, T0, { source: OLD })], [NEW]);
    expect(found.held.map((incident) => incident.anchor)).toEqual([idOf(1)]);
    expect(found.sent.map((incident) => incident.anchor)).toEqual([idOf(2)]);
    expect(found.lifeSafety).toEqual([]);
  });

  it("sends an incident with a report of a live source, or with a report that the state does not have", () => {
    const state = stateOf([report(1, T0)]);
    const [one] = incidents(state, T0);
    const mixed: Incident = { ...one!, reports: [idOf(1), idOf(9)] };
    const found = observeCut({ incidents: [mixed], state, observing: new Set([NEW]), people: [watch], places, assess: BY_SEVERITY, at: T0 });
    expect(found.sent).toEqual([mixed]);
  });

  it("sends an incident with a delivery in the log, because its escalation started before the observe mode", () => {
    const delivery = { key: "d", incident: idOf(1), level: "notice", person, channel: "pushover", step: 0, at: T0, receipt: {} } as unknown as Delivery;
    expect(cut([report(1, T0)], [NEW], [delivery]).sent.map((incident) => incident.anchor)).toEqual([idOf(1)]);
  });

  it("sends a live life-safety incident of an observing source, and names it for a note to the operator", () => {
    const found = cut([report(1, T0, { severity: "extreme" })], [NEW]);
    expect(found.sent.map((incident) => incident.anchor)).toEqual([idOf(1)]);
    expect(found.lifeSafety.map((incident) => incident.anchor)).toEqual([idOf(1)]);
    // Away from each place, the same incident reaches no person, so the mode holds it.
    expect(cut([report(1, T0, { severity: "extreme", areas: away })], [NEW]).held.map((incident) => incident.anchor)).toEqual([idOf(1)]);
  });
});

describe("observeVerdict", () => {
  const verdict = (reports: readonly Report[], extra: { readonly at?: number; readonly share?: number; readonly limits?: typeof DEFAULT_SEND_LIMITS } = {}) =>
    observeVerdict({ source: NEW, since: T0, at: extra.at ?? T0 + OBSERVE_WINDOW, state: stateOf(reports), incidents: incidents(stateOf(reports), extra.at ?? T0 + OBSERVE_WINDOW), people: [watch], places, assess: BY_SEVERITY, ...extra });

  it("does not pass before the observed time is one day", () => {
    const found = verdict([report(1, T0)], { at: T0 + 2 * HOUR });
    expect(found.pass).toBe(false);
    expect(found.reason).toBe("2.0 of 24 hours observed");
    expect(found.perHour).toBe(0.5);
  });

  it("passes after one day with no cap passed, and gives the rate and the share of each person", () => {
    const found = verdict([report(1, T0), report(2, T0 + HOUR, { areas: away }), report(3, T0 + 2 * HOUR, { severity: "minor" }), report(4, T0 + 3 * HOUR, { areas: away })]);
    expect(found).toMatchObject({ pass: true, incidents: 4, hours: 24, from: T0, caps: { notice: 6, urgent: 12 }, capWindow: HOUR });
    expect(found.perHour).toBeCloseTo(4 / 24);
    expect(found.people).toEqual([{ person, matched: 2, share: 0.5, worst: { notice: 1, urgent: 0 }, lifeSafety: 0, digestDay: 1, over: [] }]);
  });

  it("fails when a person gets more notices in one window than the send limit", () => {
    const burst = Array.from({ length: 7 }, (_, index) => report(index + 1, T0 + index * 60_000));
    const found = verdict(burst);
    expect(found.pass).toBe(false);
    expect(found.people[0]?.worst.notice).toBe(7);
    expect(found.reason).toBe("person 1: 7 notices in 1 hour, limit 6");
    // The same 7 notices over 7 hours pass.
    expect(verdict(burst.map((item, index) => ({ ...item, received: T0 + index * HOUR }))).pass).toBe(true);
  });

  it("names each person by the number of its place, with each limit that the person passes, and the observed time", () => {
    const other: PersonWatch = { person: "person-2" as PersonId, places: [home], rules: [] };
    const burst = [...Array.from({ length: 7 }, (_, index) => report(index + 1, T0 + index * 60_000)), ...Array.from({ length: 13 }, (_, index) => report(index + 20, T0 + index * 60_000, { severity: "severe" }))];
    const found = observeVerdict({ source: NEW, since: T0, at: T0 + 3 * HOUR, state: stateOf(burst), incidents: incidents(stateOf(burst), T0), people: [watch, other], places, assess: BY_SEVERITY });
    expect(found.reason).toBe(
      "person 1: 7 notices in 1 hour, limit 6; person 1: 13 urgent alerts in 1 hour, limit 12; person 2: 7 notices in 1 hour, limit 6; person 2: 13 urgent alerts in 1 hour, limit 12; 3.0 of 24 hours observed",
    );
    expect(JSON.stringify(found.reason)).not.toContain("person-");
  });

  it("takes the configured send limit times the share of the copy, and 1 at least", () => {
    const four = Array.from({ length: 4 }, (_, index) => report(index + 1, T0 + index * 60_000));
    expect(verdict(four).pass).toBe(true);
    expect(verdict(four, { share: 0.5 })).toMatchObject({ pass: false, caps: { notice: 3, urgent: 6 } });
    expect(verdict(four, { limits: { window: HOUR, notice: 3, urgent: 12 } }).pass).toBe(false);
    expect(verdict([report(1, T0)], { share: 0.01 })).toMatchObject({ pass: true, caps: { notice: 1, urgent: 1 } });
  });

  it("fails on more digest entries in one day than the cap", () => {
    const entries = (count: number) => Array.from({ length: count }, (_, index) => report(index + 1, T0 + index * 60_000, { severity: "minor" }));
    expect(verdict(entries(OBSERVE_DIGEST_PER_DAY)).pass).toBe(true);
    expect(verdict(entries(OBSERVE_DIGEST_PER_DAY + 1)).people[0]?.over).toEqual([`21 digest entries in 1 day, limit ${String(OBSERVE_DIGEST_PER_DAY)}`]);
  });

  it("gives a held condition for a verdict that fails after its window, and a life-safety condition for each source of a sent incident", () => {
    const burst = Array.from({ length: 7 }, (_, index) => report(index + 1, T0 + index * 60_000));
    const state = stateOf([...burst, report(30, T0, { severity: "extreme" })]);
    const failed = verdict(burst);
    const early = verdict(burst, { at: T0 + HOUR });
    const [extreme] = incidents(state, T0).filter((incident) => incident.anchor === idOf(30));
    expect(observeConditions([failed, early], [extreme!], state, new Map([[NEW, T0]]))).toEqual([
      { source: NEW, state: "held", since: T0, reason: "person 1: 7 notices in 1 hour, limit 6", incidents: [] },
      { source: NEW, state: "life-safety", since: T0, reason: "", incidents: [idOf(30)] },
    ]);
    expect(observeConditions([verdict([report(1, T0)])], [], state, new Map())).toEqual([]);
  });

  it("counts the life-safety incidents with no cap", () => {
    const found = verdict(Array.from({ length: 20 }, (_, index) => report(index + 1, T0 + index * 60_000, { severity: "extreme" })));
    expect(found.people[0]).toMatchObject({ lifeSafety: 20, over: [] });
    expect(found.pass).toBe(true);
  });

  it("judges the last window only, thus a source passes one window after a burst", () => {
    const burst = Array.from({ length: 7 }, (_, index) => report(index + 1, T0 + HOUR + index * 60_000));
    expect(verdict(burst, { at: T0 + OBSERVE_WINDOW + HOUR }).pass).toBe(false);
    const later = verdict(burst, { at: T0 + OBSERVE_WINDOW + 2 * HOUR });
    expect(later).toMatchObject({ pass: true, incidents: 0, hours: 26, from: T0 + 2 * HOUR });
  });

  it("counts only the reports of the source in the observed time, at the earliest receipt of the source", () => {
    const found = verdict([report(1, T0 - HOUR), report(2, T0 + HOUR, { source: OLD }), report(3, T0 + OBSERVE_WINDOW + 1), report(4, T0 + HOUR)]);
    expect(found.incidents).toBe(1);
    expect(found.people[0]?.matched).toBe(1);
  });
});

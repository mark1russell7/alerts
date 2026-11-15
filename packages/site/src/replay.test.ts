import { readdirSync, readFileSync } from "node:fs";
import { gapGrade, health, HEALTH_MACHINE, type PlaceId } from "@mark1russell7/alerts";
import { mapObservation } from "@mark1russell7/alerts-source-nws-api";
import { describe, expect, it } from "vitest";
import { COVERAGE_KINDS, FETCHES, FIRST_FETCH, OUTAGE, PEOPLE, PLACES, SOURCES, STEPS, ZONES } from "./demo.ts";
import { incidentLabel, joinFacts, reasonText, stepLabel } from "./explain.ts";
import { observe, replay, type Frame } from "./replay.ts";
import { zonesOf } from "./view.ts";

const WORLD = { sources: SOURCES, fetches: FETCHES, start: FIRST_FETCH, kinds: COVERAGE_KINDS };
const frames = replay(STEPS, PEOPLE, PLACES, WORLD);
const FIXTURES = new URL("../fixtures/", import.meta.url);

/** The index of the step at which the API stops, and of the step at which it is back. */
const STOPS = 5;
const BACK = 6;

/** One line for each incident and person: the kind, live or ended, the person, the level and the kinds of the reasons. */
const lines = (index: number): string[] => {
  const frame = frames[index]!;
  return frame.incidents.flatMap((incident) =>
    frame.assessments
      .filter((assessment) => assessment.incident === incident.anchor)
      .map((assessment) => `${incident.kind.code} ${incident.live ? "live" : "ended"} ${String(incident.reports.length)} | ${assessment.person} ${assessment.level} | ${assessment.reasons.map((reason) => reason.kind).join(" ")}`),
  );
};

/** The same lines for the system reports. A report of a coverage also names its place. */
const systemLines = (index: number): string[] => {
  const { sources } = frames[index]!;
  return sources.incidents.flatMap((incident) => {
    const place = incident.areas.flatMap((area) => (area.type === "place" ? [` ${area.place}`] : [])).join("");
    return sources.assessments
      .filter((assessment) => assessment.incident === incident.anchor)
      .map((assessment) => `${incident.kind.code}${place} ${incident.live ? "live" : "ended"} ${String(incident.reports.length)} | ${assessment.person} ${assessment.level} | ${assessment.reasons.map((reason) => reason.kind).join(" ")}`);
  });
};

const states = (frame: Frame): string[] => frame.sources.health.map((entry) => `${entry.source} ${entry.state}`);
const short = (frame: Frame): string[] =>
  frame.sources.coverage.filter((entry) => entry.short).map((entry) => `${entry.place} ${entry.kind} ${String(entry.independent)}/${String(entry.required)}`);

describe("the fixtures of the demo", () => {
  const names = readdirSync(FIXTURES).filter((name) => name.endsWith(".json"));

  it("are each a message of a step", () => {
    expect(names.sort()).toEqual(STEPS.flatMap((step) => (step.message === undefined ? [] : [step.message.name])).sort());
  });

  it.each(names)("%s maps to one report with no problem", (name) => {
    const body = readFileSync(new URL(name, FIXTURES), "utf8");
    const result = mapObservation(observe(body, Date.parse("2026-05-04T12:00:00Z")));
    expect(result.problems).toEqual([]);
    expect(result.reports).toHaveLength(1);
  });

  it.each(names)("%s holds only made-up codes, offices and senders", (name) => {
    const feature = JSON.parse(readFileSync(new URL(name, FIXTURES), "utf8")) as {
      properties: { geocode: { UGC: string[]; SAME: string[] }; sender: string; parameters: { VTEC?: string[] } };
    };
    const { geocode, sender, parameters } = feature.properties;
    for (const code of geocode.UGC) expect(code).toMatch(/^XX[ZC]\d{3}$/);
    for (const code of geocode.SAME) expect(code).toMatch(/^099\d{3}$/);
    expect(sender).toMatch(/\.example$/);
    for (const vtec of parameters.VTEC ?? []) expect(vtec).toMatch(/^\/O\.[A-Z]{3}\.X[A-Z]{3}\./);
  });
});

describe("the replay", () => {
  it("has a frame for each step, and the map functions find no problem", () => {
    expect(frames).toHaveLength(STEPS.length);
    expect(frames).toHaveLength(10);
    for (const frame of frames) expect(frame.problems).toEqual([]);
  });

  it("starts with no incident", () => {
    expect(lines(0)).toEqual([]);
  });

  it("step 1: the rule of Person B keeps the wind warning at notice", () => {
    expect(lines(1)).toEqual([
      "met.wind.high live 1 | person-a none | no-place",
      "met.wind.high live 1 | person-b notice | table place rule",
    ]);
  });

  it("step 2: the flash flood covers the home of Person A, so the level is life-safety", () => {
    expect(lines(2).slice(2)).toEqual([
      "met.flood.flash live 1 | person-a life-safety | table place",
      "met.flood.flash live 1 | person-b none | no-place",
    ]);
  });

  it("step 3: the message of the backup office joins the flood incident by its VTEC key", () => {
    expect(lines(3).slice(2)).toEqual([
      "met.flood.flash live 2 | person-a life-safety | table place",
      "met.flood.flash live 2 | person-b none | no-place",
    ]);
    expect(frames[3]!.incidents[1]!.severity).toBe("extreme");
  });

  it("step 4: the update adds East County, so Person B gets life-safety too", () => {
    expect(lines(4)).toEqual([
      "met.wind.high live 1 | person-a none | no-place",
      "met.wind.high live 1 | person-b notice | table place rule",
      "met.flood.flash live 3 | person-a life-safety | table place",
      "met.flood.flash live 3 | person-b life-safety | table place",
    ]);
  });

  it("steps 5 and 6: the outage of the API changes no incident of the source", () => {
    expect(lines(STOPS)).toEqual(lines(4));
    expect(lines(BACK)).toEqual(lines(4));
  });

  it("step 7: the test message reaches nobody, because the policy sends only actual messages", () => {
    expect(lines(7).slice(4)).toEqual(["system.test live 1 | person-a none | status", "system.test live 1 | person-b none | status"]);
  });

  it("step 8: the cancel ends the flood incident", () => {
    expect(lines(8).filter((line) => line.startsWith("met.flood.flash"))).toEqual([
      "met.flood.flash ended 4 | person-a none | ended",
      "met.flood.flash ended 4 | person-b none | ended",
    ]);
  });

  it("step 9: the time alone ends the wind warning", () => {
    expect(frames[9]!.reports).toEqual([]);
    expect(lines(9).filter((line) => line.startsWith("met.wind.high"))).toEqual([
      "met.wind.high ended 1 | person-a none | ended",
      "met.wind.high ended 1 | person-b none | ended",
    ]);
  });

  it("gives the same frames in each run, because the core reads the time only from the step", () => {
    expect(JSON.stringify(replay(STEPS, PEOPLE, PLACES, WORLD))).toBe(JSON.stringify(frames));
  });
});

describe("the sources", () => {
  it("are healthy, with each coverage met and no system report, before the outage", () => {
    for (const frame of frames.slice(0, STOPS)) {
      expect(states(frame)).toEqual(["nws-api healthy", "radio-x healthy"]);
      expect(short(frame)).toEqual([]);
      expect(frame.sources.reports).toEqual([]);
      expect(frame.sources.incidents).toEqual([]);
    }
    expect(frames[0]!.sources.transitions.map((change) => `${change.instance} ${change.from}>${change.to}`).sort()).toEqual(["nws-api unknown>healthy", "radio-x unknown>healthy"]);
  });

  it("step 5: the API is failing, the flood is short at each home, and the core makes 3 system reports", () => {
    const frame = frames[STOPS]!;
    expect(states(frame)).toEqual(["nws-api failing", "radio-x healthy"]);
    expect(short(frame)).toEqual(["home-a met.flood.flash 1/2", "home-b met.flood.flash 1/2"]);
    expect(frame.sources.coverage.filter((entry) => !entry.short).map((entry) => `${entry.place} ${entry.kind} ${String(entry.independent)}/${String(entry.required)}`)).toEqual([
      "home-a met.wind 1/1",
      "home-b met.wind 1/1",
    ]);
    // Two fetches in a row failed at 13:09:10: the fetch of 13:08 and the fetch of 13:09, each 10 s long.
    expect(frame.sources.transitions).toEqual([{ machine: "alerts.health", instance: "nws-api", from: "healthy", on: "app.fetch-failed", to: "failing", at: OUTAGE.from + 70_000 }]);
    expect(frame.sources.reports.map((report) => `${report.op} ${report.kind.code}`)).toEqual([
      "alert system.coverage.met.flood.flash",
      "alert system.coverage.met.flood.flash",
      "alert system.health.failing",
    ]);
    expect(systemLines(STOPS)).toEqual([
      "system.coverage.met.flood.flash home-a live 1 | person-a urgent | table place",
      "system.coverage.met.flood.flash home-a live 1 | person-b none | no-place",
      "system.coverage.met.flood.flash home-b live 1 | person-a none | no-place",
      "system.coverage.met.flood.flash home-b live 1 | person-b urgent | table place",
      "system.health.failing live 1 | person-a notice | table subject",
      "system.health.failing live 1 | person-b none | no-subject",
    ]);
  });

  it("step 5: the grade of each gap is the grade of its report", () => {
    const frame = frames[STOPS]!;
    for (const entry of frame.sources.coverage.filter((one) => one.short)) {
      const threatened = frame.sources.threats.some((threat) => threat.place === entry.place && threat.kind === entry.kind);
      expect(threatened).toBe(true);
      const grade = gapGrade(entry, threatened);
      expect(grade).toEqual({ severity: "severe", urgency: "expected" });
      const report = frame.sources.reports.find((one) => one.areas.some((area) => area.type === "place" && area.place === entry.place))!;
      expect({ severity: report.severity, urgency: report.urgency }).toEqual(grade);
    }
  });

  it("step 6: the API is back, and the core cancels each system report", () => {
    const frame = frames[BACK]!;
    expect(states(frame)).toEqual(["nws-api healthy", "radio-x healthy"]);
    expect(short(frame)).toEqual([]);
    expect(frame.sources.transitions).toEqual([{ machine: "alerts.health", instance: "nws-api", from: "failing", on: "app.fetch-passed", to: "healthy", at: OUTAGE.to + 400 }]);
    const alerts = frames[STOPS]!.sources.reports.map((report) => report.key);
    expect(frame.sources.reports.map((report) => report.op)).toEqual(["cancel", "cancel", "cancel"]);
    expect(frame.sources.reports.map((report) => report.references)).toEqual(alerts.map((key) => [key]));
    expect(systemLines(BACK)).toEqual([
      "system.coverage.met.flood.flash home-a ended 2 | person-a none | ended",
      "system.coverage.met.flood.flash home-a ended 2 | person-b none | ended",
      "system.coverage.met.flood.flash home-b ended 2 | person-a none | ended",
      "system.coverage.met.flood.flash home-b ended 2 | person-b none | ended",
      "system.health.failing ended 2 | person-a none | ended",
      "system.health.failing ended 2 | person-b none | ended",
    ]);
  });

  it("make no system report after the API is back", () => {
    for (const frame of frames.slice(BACK + 1)) {
      expect(states(frame)).toEqual(["nws-api healthy", "radio-x healthy"]);
      expect(short(frame)).toEqual([]);
      expect(frame.sources.reports).toEqual([]);
      expect(frame.sources.incidents.every((incident) => !incident.live)).toBe(true);
    }
  });

  it("give at each step the health that one call of `health` gives for the fetches that ended by then", () => {
    for (const frame of frames) {
      SOURCES.forEach((source, index) => {
        const done = FETCHES.filter((record) => record.source === source.id && record.at + record.took <= frame.step.at).sort((a, b) => a.at + a.took - (b.at + b.took));
        expect(frame.sources.health[index]).toEqual(health(source, FIRST_FETCH, done, frame.step.at).health);
      });
    }
  });

  it("make only the transitions of the health machine", () => {
    const changes = frames.flatMap((frame) => frame.sources.transitions);
    expect(changes.length).toBeGreaterThan(0);
    for (const change of changes) {
      const permitted = HEALTH_MACHINE.transitions.some(
        (rule) => rule.to === change.to && [rule.from].flat().includes(change.from) && [rule.on].flat().includes(change.on),
      );
      expect(permitted, `${change.from} > ${change.to} on ${change.on}`).toBe(true);
    }
  });
});

describe("the words of the page", () => {
  it("names the merge rule of each joined report of the flood", () => {
    const frame = frames[4]!;
    const flood = frame.incidents.find((incident) => incident.kind.code === "met.flood.flash")!;
    const reports = flood.reports.map((id) => frame.state.reports.find((report) => report.id === id)!).sort((a, b) => a.sent - b.sent);
    expect(reports.map((report, index) => joinFacts(report, reports.slice(0, index)).map((fact) => fact.rule))).toEqual([[], [2], [1, 2]]);
  });

  it("writes a sentence for each reason of each frame, also for the system reports", () => {
    for (const frame of frames) {
      const incidents = [...frame.incidents, ...frame.sources.incidents];
      for (const assessment of [...frame.assessments, ...frame.sources.assessments]) {
        const incident = incidents.find((one) => one.anchor === assessment.incident)!;
        for (const reason of assessment.reasons) {
          const sentence = reasonText(reason, incident);
          expect(sentence).toMatch(/^[A-Z].*\.$/);
          expect(sentence).not.toMatch(/: \.$/);
        }
      }
    }
  });

  it("names the home in the label of a system report of a coverage", () => {
    const [homeA, homeB, failing] = frames[STOPS]!.sources.incidents;
    expect(incidentLabel(homeA!)).toBe("Coverage gap: Flash flood, Home of A");
    expect(incidentLabel(homeB!)).toBe("Coverage gap: Flash flood, Home of B");
    expect(incidentLabel(failing!)).toBe(failing!.kind.label);
  });

  it("tells the distance of a match by a shape", () => {
    const [incident] = frames[1]!.incidents;
    const place = "home-a" as PlaceId;
    expect(reasonText({ kind: "place", place, codes: [], distanceKm: 0 }, incident!)).toBe(
      "A shape of the incident contains the home of A, in the Valley.",
    );
    expect(reasonText({ kind: "place", place, codes: [], distanceKm: 5.56 }, incident!)).toBe(
      "A shape of the incident is 5.6 km from the home of A, in the Valley, in the buffer of the place.",
    );
    expect(reasonText({ kind: "place", place, codes: [], distanceKm: 0.01 }, incident!)).toContain("less than 0.1 km");
    expect(reasonText({ kind: "place", place, codes: [{ system: "ugc", code: "KSC173" }], distanceKm: 0 }, incident!)).toBe(
      "The incident covers the home of A, in the Valley: KSC173. A shape of the incident contains the home of A, in the Valley.",
    );
  });

  it("tells when the codes of an area decided because its shape is not valid", () => {
    const [incident] = frames[1]!.incidents;
    const place = "home-a" as PlaceId;
    expect(reasonText({ kind: "place", place, codes: [{ system: "ugc", code: "KSC173" }], shapeRefused: true }, incident!)).toBe(
      "The incident covers the home of A, in the Valley: KSC173. The shape of an area of the incident is not valid, so its region codes decided.",
    );
  });

  it("counts the steps from 1 in the labels, and the last label names the count of the steps", () => {
    expect(stepLabel(0, frames.length)).toBe(`Step 1 of ${String(frames.length)}`);
    expect(stepLabel(4, frames.length)).toBe("Step 5 of 10");
    expect(stepLabel(frames.length - 1, frames.length)).toBe("Step 10 of 10");
  });

  it("draws the zones of the code areas: a zone, a county or a SAME code", () => {
    const names = (index: number, code: string): string[] =>
      zonesOf(frames[index]!.incidents.find((incident) => incident.kind.code === code)!).map((zone) => zone.name);
    expect(names(1, "met.wind.high")).toEqual(["Lake Shore", "Harbor"]);
    expect(names(2, "met.flood.flash")).toEqual(["Valley", "Ridge"]);
    expect(names(4, "met.flood.flash")).toEqual(ZONES.map((zone) => zone.name));
  });
});

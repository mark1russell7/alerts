import { readdirSync, readFileSync } from "node:fs";
import { mapObservation } from "@mark1russell7/alerts-source-nws-api";
import { describe, expect, it } from "vitest";
import { PEOPLE, PLACES, STEPS, ZONES } from "./demo.ts";
import { joinFacts, reasonText } from "./explain.ts";
import { observe, replay } from "./replay.ts";
import { zonesOf } from "./view.ts";

const frames = replay(STEPS, PEOPLE, PLACES);
const FIXTURES = new URL("../fixtures/", import.meta.url);

/** One line for each incident and person: the kind, live or ended, the person, the level and the kinds of the reasons. */
const lines = (index: number): string[] => {
  const frame = frames[index]!;
  return frame.incidents.flatMap((incident) =>
    frame.assessments
      .filter((assessment) => assessment.incident === incident.anchor)
      .map((assessment) => `${incident.kind.code} ${incident.live ? "live" : "ended"} ${String(incident.reports.length)} | ${assessment.person} ${assessment.level} | ${assessment.reasons.map((reason) => reason.kind).join(" ")}`),
  );
};

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

  it("step 5: the test message reaches nobody, because the policy sends only actual messages", () => {
    expect(lines(5).slice(4)).toEqual(["system.test live 1 | person-a none | status", "system.test live 1 | person-b none | status"]);
  });

  it("step 6: the cancel ends the flood incident", () => {
    expect(lines(6).filter((line) => line.startsWith("met.flood.flash"))).toEqual([
      "met.flood.flash ended 4 | person-a none | ended",
      "met.flood.flash ended 4 | person-b none | ended",
    ]);
  });

  it("step 7: the time alone ends the wind warning", () => {
    expect(frames[7]!.reports).toEqual([]);
    expect(lines(7).filter((line) => line.startsWith("met.wind.high"))).toEqual([
      "met.wind.high ended 1 | person-a none | ended",
      "met.wind.high ended 1 | person-b none | ended",
    ]);
  });

  it("gives the same frames in each run, because the core reads the time only from the step", () => {
    expect(JSON.stringify(replay(STEPS, PEOPLE, PLACES))).toBe(JSON.stringify(frames));
  });
});

describe("the words of the page", () => {
  it("names the merge rule of each joined report of the flood", () => {
    const frame = frames[4]!;
    const flood = frame.incidents.find((incident) => incident.kind.code === "met.flood.flash")!;
    const reports = flood.reports.map((id) => frame.state.reports.find((report) => report.id === id)!).sort((a, b) => a.sent - b.sent);
    expect(reports.map((report, index) => joinFacts(report, reports.slice(0, index)).map((fact) => fact.rule))).toEqual([[], [2], [1, 2]]);
  });

  it("writes a sentence for each reason of each frame", () => {
    for (const frame of frames) {
      for (const assessment of frame.assessments) {
        const incident = frame.incidents.find((one) => one.anchor === assessment.incident)!;
        for (const reason of assessment.reasons) expect(reasonText(reason, incident)).toMatch(/^[A-Z].*\.$/);
      }
    }
  });

  it("draws the zones of the code areas: a zone, a county or a SAME code", () => {
    const names = (index: number, code: string): string[] =>
      zonesOf(frames[index]!.incidents.find((incident) => incident.kind.code === code)!).map((zone) => zone.name);
    expect(names(1, "met.wind.high")).toEqual(["Lake Shore", "Harbor"]);
    expect(names(2, "met.flood.flash")).toEqual(["Valley", "Ridge"]);
    expect(names(4, "met.flood.flash")).toEqual(ZONES.map((zone) => zone.name));
  });
});

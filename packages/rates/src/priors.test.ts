import { readFileSync } from "node:fs";
import { scorePriorsSchema, shadowScore, type ScorePriors } from "@mark1russell7/alerts";
import { poissonInterval } from "@mark1russell7/rigor-statistics";
import { describe, expect, it } from "vitest";

import { committedPriors, PRIORS_URL } from "./committed.ts";
import { priorsOf } from "./priors.ts";
import { LEVEL, type RatesFile } from "./rates.ts";

const RATES_TEXT = readFileSync(new URL("../data/rates.json", import.meta.url), "utf8");
const PRIORS_TEXT = readFileSync(PRIORS_URL, "utf8");
const RATES = JSON.parse(RATES_TEXT) as RatesFile;
const PRIORS = priorsOf(RATES);

type Mutable<T> = { -readonly [K in keyof T]: Mutable<T[K]> };
const copy = (): Mutable<RatesFile> => structuredClone(RATES) as Mutable<RatesFile>;
const text = (priors: ScorePriors): string => `${JSON.stringify(priors, null, 2)}\n`;

describe("the committed priors", () => {
  it("are the priors of the committed rates, to the byte", () => {
    expect(PRIORS_TEXT).toBe(text(PRIORS));
  });

  it("are the priors that the runtime reads", () => {
    expect(committedPriors()).toEqual(PRIORS);
  });

  it("pass the schema of the core", () => {
    expect(scorePriorsSchema.parse(JSON.parse(PRIORS_TEXT))).toEqual(PRIORS);
  });

  it("give a shadow score with a read for a tornado warning", () => {
    const score = shadowScore({ kind: { code: "met.tornado", significance: "warning", label: "Tornado Warning" }, certainty: "likely" }, PRIORS);
    expect(score.read).toBe(true);
    if (!score.read) return;
    expect(score.probability.from).toEqual({ table: "kinds", key: "met.tornado" });
    expect(score.deaths.from).toEqual({ table: "kinds", key: "met.tornado" });
  });
});

describe("the verified share", () => {
  it("is the own share of Cow, with its gate interval", () => {
    const tornado = RATES.cow.phenomena.TO;
    expect(PRIORS.kinds[tornado.kind]?.verified).toEqual({ value: tornado.ownShare.value, low: tornado.ownShare.gate[0], high: tornado.ownShare.gate[1] });
  });

  it("is absent when the gate cannot read the share", () => {
    const rates = copy();
    rates.cow.phenomena.TO.ownShare.noRead = "too few verified or unverified warnings in a year (2021: 3 verified of 9)";
    expect(priorsOf(rates).kinds["met.tornado"]?.verified).toBeUndefined();
    expect(priorsOf(rates).kinds["met.tornado"]?.deaths).toEqual(PRIORS.kinds["met.tornado"]?.deaths);
  });

  it("does not come from the phenomena that Cow does not verify", () => {
    for (const rate of Object.values(RATES.cow.unverified)) expect(PRIORS.kinds[rate.kind]?.verified).toBeUndefined();
  });

  it("refuses two phenomena of one kind", () => {
    const rates = copy();
    rates.cow.phenomena.SV.kind = rates.cow.phenomena.TO.kind;
    expect(() => priorsOf(rates)).toThrow(/Two Cow phenomena/);
  });
});

describe("the deaths and injuries of one event", () => {
  it("sum the event types of a kind over each year", () => {
    const types = Object.values(RATES.ncei.types).filter((rate) => rate.kind === "met.thunderstorm.severe");
    expect(types.length).toBeGreaterThan(1);
    const sum = (part: "events" | "deaths" | "injuries"): number => types.reduce((total, rate) => total + Object.values(rate.byYear).reduce((s, year) => s + year[part], 0), 0);
    expect(PRIORS.kinds["met.thunderstorm.severe"]?.deaths?.value).toBe(sum("deaths") / sum("events"));
    expect(PRIORS.kinds["met.thunderstorm.severe"]?.injuries?.value).toBe(sum("injuries") / sum("events"));
  });

  it("have an interval that holds the value", () => {
    for (const prior of Object.values(PRIORS.kinds)) {
      for (const estimate of [prior.deaths, prior.injuries]) {
        if (estimate === undefined) continue;
        expect(estimate.low).toBeLessThanOrEqual(estimate.value);
        expect(estimate.value).toBeLessThanOrEqual(estimate.high);
        expect(estimate.low).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("have an interval that holds the exact Poisson interval of the count over the events", () => {
    const tornado = RATES.ncei.types["Tornado"];
    if (tornado === undefined) throw new Error("The rates have no Tornado type.");
    const years = Object.values(tornado.byYear);
    const exact = poissonInterval(
      years.reduce((sum, year) => sum + year.deaths, 0),
      years.reduce((sum, year) => sum + year.events, 0),
      LEVEL,
    );
    const deaths = PRIORS.kinds["met.tornado"]?.deaths;
    expect(deaths?.low).toBeLessThanOrEqual(exact.low);
    expect(deaths?.high).toBeGreaterThanOrEqual(exact.high);
  });

  it("give a count of 0 a wide interval, not a point, and the other count stays", () => {
    const rates = copy();
    const tornado = rates.ncei.types["Tornado"];
    if (tornado === undefined) throw new Error("The rates have no Tornado type.");
    for (const counts of Object.values(tornado.byYear)) counts.deaths = 0;
    const events = Object.values(tornado.byYear).reduce((sum, year) => sum + year.events, 0);
    const deaths = priorsOf(rates).kinds["met.tornado"]?.deaths;
    expect(deaths).toEqual({ value: 0, low: 0, high: poissonInterval(0, events, LEVEL).high });
    expect(deaths?.high).toBeGreaterThan(0);
    expect(priorsOf(rates).kinds["met.tornado"]?.injuries).toEqual(PRIORS.kinds["met.tornado"]?.injuries);
  });

  it("use only the exact interval when a year has no event, so no draw of the years divides by 0", () => {
    const rates = copy();
    const tornado = rates.ncei.types["Tornado"];
    if (tornado === undefined) throw new Error("The rates have no Tornado type.");
    const [first, ...others] = Object.keys(tornado.byYear);
    for (const year of others) tornado.byYear[year] = { events: 0, deaths: 0, injuries: 0 };
    const kept = tornado.byYear[first ?? ""];
    if (kept === undefined) throw new Error("The Tornado type has no year.");
    const exact = poissonInterval(kept.deaths, kept.events, LEVEL);
    const value = kept.deaths / kept.events;
    expect(priorsOf(rates).kinds["met.tornado"]?.deaths).toEqual({ value, low: Math.min(exact.low, value), high: Math.max(exact.high, value) });
  });

  it("are absent for a kind with no event in the years", () => {
    const rates = copy();
    const tornado = rates.ncei.types["Tornado"];
    if (tornado === undefined) throw new Error("The rates have no Tornado type.");
    for (const year of Object.keys(tornado.byYear)) tornado.byYear[year] = { events: 0, deaths: 0, injuries: 0 };
    expect(priorsOf(rates).kinds["met.tornado"]?.deaths).toBeUndefined();
    expect(priorsOf(rates).kinds["met.tornado"]?.injuries).toBeUndefined();
    expect(priorsOf(rates).kinds["met.tornado"]?.verified).toEqual(PRIORS.kinds["met.tornado"]?.verified);
  });

  it("are absent for a type with no kind", () => {
    const keys = new Set(Object.keys(PRIORS.kinds));
    expect(keys.has("null")).toBe(false);
  });

  it("refuse a year out of the years of the file", () => {
    const rates = copy();
    const tornado = rates.ncei.types["Tornado"];
    if (tornado === undefined) throw new Error("The rates have no Tornado type.");
    tornado.byYear["1990"] = { events: 1, deaths: 0, injuries: 0 };
    expect(() => priorsOf(rates)).toThrow(/out of the years/);
  });
});

describe("the certainty", () => {
  it("is the middle of each CAP band, with the band as its interval", () => {
    expect(PRIORS.certainty).toEqual({
      observed: { value: 1, low: 1, high: 1 },
      likely: { value: 0.75, low: 0.5, high: 1 },
      possible: { value: 0.25, low: 0, high: 0.5 },
      unlikely: { value: 0, low: 0, high: 0 },
      unknown: { value: 0.5, low: 0, high: 1 },
    });
  });

  it("refuses bands with no word for a certainty", () => {
    const rates = copy();
    const bands = rates.cap.bands as Record<string, unknown>;
    delete bands["unknown"];
    expect(() => priorsOf(rates)).toThrow(/no certainty unknown/);
  });
});

describe("the order", () => {
  it("of the types and the phenomena in the file does not change the priors", () => {
    const rates = copy();
    rates.ncei.types = Object.fromEntries(Object.entries(rates.ncei.types).reverse());
    rates.cow.phenomena = Object.fromEntries(Object.entries(rates.cow.phenomena).reverse()) as typeof rates.cow.phenomena;
    expect(text(priorsOf(rates))).toBe(text(PRIORS));
  });

  it("of the kinds of the priors is the order of the codes", () => {
    const keys = Object.keys(PRIORS.kinds);
    expect(keys).toEqual([...keys].sort());
  });
});

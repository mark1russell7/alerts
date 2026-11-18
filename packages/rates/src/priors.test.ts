import { readFileSync } from "node:fs";
import { scorePriorsSchema, shadowScore, type ScorePriors } from "@mark1russell7/alerts";
import { poissonInterval } from "@mark1russell7/rigor-statistics";
import { describe, expect, it } from "vitest";

import { committedPriors, PRIORS_URL } from "./committed.ts";
import { areaTypeOf, priorsOf } from "./priors.ts";
import { LEVEL, type RatesFile } from "./rates.ts";
import type { UnderKind, UnderRate } from "./under.ts";

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

  it("give a tornado warning the harm under the tornado warnings, and an observed tornado the harm of one event", () => {
    const warning = shadowScore({ kind: { code: "met.tornado", significance: "warning", label: "Tornado Warning" }, certainty: "likely" }, PRIORS);
    expect(warning).toMatchObject({ read: true, basis: "alert", deaths: { from: { table: "under", key: "met.tornado", significance: "warning" } } });
    const observed = shadowScore({ kind: { code: "met.tornado", significance: "warning", label: "Tornado Warning" }, certainty: "observed" }, PRIORS);
    expect(observed).toMatchObject({ read: true, basis: "event", probability: { from: { table: "certainty", key: "observed" } }, deaths: { from: { table: "kinds", key: "met.tornado" } } });
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
    const tornado = priorsOf(rates).kinds["met.tornado"];
    expect(tornado?.verified).toBeUndefined();
    expect(tornado?.deaths).toEqual(PRIORS.kinds["met.tornado"]?.deaths);
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
    const prior = priorsOf(rates).kinds["met.tornado"];
    const deaths = prior?.deaths;
    expect(deaths).toEqual({ value: 0, low: 0, high: poissonInterval(0, events, LEVEL).high });
    expect(deaths?.high).toBeGreaterThan(0);
    expect(prior?.injuries).toEqual(PRIORS.kinds["met.tornado"]?.injuries);
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
    const prior = priorsOf(rates).kinds["met.tornado"];
    expect(prior?.deaths).toBeUndefined();
    expect(prior?.injuries).toBeUndefined();
    expect(prior?.verified).toEqual(PRIORS.kinds["met.tornado"]?.verified);
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

describe("the harm under an alert", () => {
  const tornado = (): { readonly kind: UnderKind; readonly rate: UnderRate } => {
    const kind = RATES.under.kinds["met.tornado"];
    const rate = kind?.significances.W;
    if (kind === undefined || rate === undefined) throw new Error("The rates have no tornado warnings.");
    return { kind, rate };
  };

  it("is the harm in the area type with more placed events, over the areas of that type", () => {
    const { kind, rate } = tornado();
    const type = areaTypeOf(kind, rate);
    const area = rate.byArea[type];
    const areas = Object.values(area.areas).reduce((sum, count) => sum + count, 0);
    const deaths = Object.values(area.harm).reduce((sum, count) => sum + count.deaths, 0);
    const injuries = Object.values(area.harm).reduce((sum, count) => sum + count.injuries, 0);
    const prior = PRIORS.kinds["met.tornado"]?.under?.warning;
    expect(prior?.area).toBe(type === "counties" ? "county" : "zone");
    expect(prior?.deaths.value).toBe(deaths / areas);
    expect(prior?.injuries.value).toBe(injuries / areas);
    const exact = poissonInterval(deaths, areas, LEVEL);
    expect(prior?.deaths.low).toBeLessThanOrEqual(exact.low);
    expect(prior?.deaths.high).toBeGreaterThanOrEqual(exact.high);
  });

  it("takes the area type with more placed events, then the type with more areas, then the counties", () => {
    const { kind, rate } = tornado();
    const areas = (counties: number, zones: number): UnderRate => ({
      ...rate,
      byArea: { counties: { areas: { "2024": counties }, harm: {} }, zones: { areas: { "2024": zones }, harm: {} } },
    });
    expect(areaTypeOf({ ...kind, placed: { counties: 3, zones: 1 } }, areas(1, 9))).toBe("counties");
    expect(areaTypeOf({ ...kind, placed: { counties: 1, zones: 3 } }, areas(9, 1))).toBe("zones");
    expect(areaTypeOf({ ...kind, placed: { counties: 0, zones: 0 } }, areas(1, 9))).toBe("zones");
    expect(areaTypeOf({ ...kind, placed: { counties: 2, zones: 2 } }, areas(5, 5))).toBe("counties");
  });

  it("has the VTEC words of the significances, and an interval that holds each value", () => {
    let measures = 0;
    for (const prior of Object.values(PRIORS.kinds)) {
      for (const [word, under] of Object.entries(prior.under ?? {})) {
        expect(["warning", "watch", "advisory", "statement"]).toContain(word);
        for (const estimate of [under.deaths, under.injuries]) {
          expect(estimate.low).toBeGreaterThanOrEqual(0);
          expect(estimate.low).toBeLessThanOrEqual(estimate.value);
          expect(estimate.value).toBeLessThanOrEqual(estimate.high);
        }
        measures++;
      }
    }
    expect(measures).toBeGreaterThan(10);
  });

  it("is absent for a kind with no NCEI kind, because 0 is not a measure", () => {
    const rates = copy();
    const kind = rates.under.kinds["met.tornado"];
    if (kind === undefined) throw new Error("The rates have no tornado alerts.");
    kind.nceiKind = null;
    const prior = priorsOf(rates).kinds["met.tornado"];
    expect(prior?.under).toBeUndefined();
    expect(prior?.deaths).toEqual(PRIORS.kinds["met.tornado"]?.deaths);
  });

  it("is absent for a significance with no area in the years", () => {
    const rates = copy();
    const rate = rates.under.kinds["met.tornado"]?.significances.W;
    if (rate === undefined) throw new Error("The rates have no tornado warnings.");
    for (const type of ["counties", "zones"] as const) rate.byArea[type] = { areas: {}, harm: {} };
    expect(priorsOf(rates).kinds["met.tornado"]?.under?.warning).toBeUndefined();
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
    rates.under.kinds = Object.fromEntries(Object.entries(rates.under.kinds).reverse());
    expect(text(priorsOf(rates))).toBe(text(PRIORS));
  });

  it("of the kinds of the priors is the order of the codes", () => {
    const keys = Object.keys(PRIORS.kinds);
    expect(keys).toEqual([...keys].sort());
  });
});

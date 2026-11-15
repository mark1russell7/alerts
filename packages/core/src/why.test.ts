import { random, seedsFrom, type Random } from "@mark1russell7/rigor-generators";
import { describe, expect, it } from "vitest";
import { SUBJECT_SYSTEMS, type EdgeOrigin, type NodeKey, type PlaceId, type WhyRecord } from "./contracts.ts";
import { whyRecordSchema } from "./schemas.ts";
import { fitsWhy, kindOfNode, NO_LABELS, placeWhy, plainLabel, WHY_FULL_COVERAGE, WHY_LIMITS, whyLine, type WhyLabels } from "./why.ts";

const SEEDS = seedsFrom(process.env["SEED"], [1, 2, 3, 4, 5, 6, 7, 8]);

// The characters of a why line: letters, spaces and , ' & . : -. Each one is in the GSM-7 base set, and none is a digit.
const WHY_TEXT = /^[A-Za-z ,'&.:-]+$/;

const SYSTEMS = Object.keys(SUBJECT_SYSTEMS);
const ORIGINS: readonly EdgeOrigin[] = ["base", "places", "services", "work", "data", "measured", "person"];
const IDS = ["home", "KSZ083", "020173", "infra.power.outage", "example.com", "us-east-1", "pkg:npm/example", "Q42", "31.97,-99.90"];

// Labels that a channel text can show.
const PLAIN = ["Home", "Office", "Mom's house", "Lake cabin", "Smith & Sons", "Fort St. John", "the shop", "Grandma's farm, south field", "A very long label of many plain words that does not fit a text message at all"];
// Labels that a channel text must not show: an address, a point, a region code, a code in capitals, other characters.
const UNSAFE = ["12 Main St", "Apt 4B", "KSZ083", "020173", "KSC173", "31.97, -99.90", "31.9N 99.9W", "DFW", "TX", "home: 5th floor", "Café", "", "   ", "\u{1F600} home", "Route 66", "Home\nKSZ083"];

function randomKey(r: Random): NodeKey {
  return `${r.pick(SYSTEMS)}:${r.pick(IDS)}`;
}

function randomRecord(r: Random): WhyRecord {
  const subject = randomKey(r);
  const direct = r.chance(0.5);
  const anchor = direct ? subject : randomKey(r);
  const via = !direct && r.chance(0.5) ? randomKey(r) : undefined;
  const kind = kindOfNode(subject) ?? "place";
  const coverage = r.chance(0.3) ? r.range(0, WHY_FULL_COVERAGE) : r.range(WHY_FULL_COVERAGE, 1);
  const origin = r.pick(ORIGINS);
  return { rule: `reach.${kind}.${origin}`, subject, kind, ...(via === undefined ? {} : { via }), anchor, origin, coverage };
}

// Each node gets one label, or none: a plain label or an unsafe one.
function randomLabels(r: Random): WhyLabels {
  const chosen = new Map<NodeKey, string | undefined>();
  return (node) => {
    if (!chosen.has(node)) chosen.set(node, r.chance(0.2) ? undefined : r.pick(r.chance(0.5) ? PLAIN : UNSAFE));
    return chosen.get(node);
  };
}

const labelsOf =
  (entries: Readonly<Record<NodeKey, string>>): WhyLabels =>
  (node) =>
    entries[node];

const ids = (...names: string[]): PlaceId[] => names.map((name) => name as PlaceId);

const HOME = placeWhy(ids("home"))!;

describe("the why line", () => {
  // The gate of AL-35: each why text keeps the limits of its channel and holds no address, point or code.
  it("The why fits each channel", () => {
    for (const seed of SEEDS) {
      const r = random(seed);
      for (let round = 0; round < 300; round += 1) {
        const record = randomRecord(r);
        expect(whyRecordSchema.safeParse(record).success).toBe(true);
        const labels = randomLabels(r);
        for (const [channel, limit] of Object.entries(WHY_LIMITS)) {
          const line = whyLine(record, labels, limit);
          const where = `seed ${seed}, round ${round}, ${channel}: ${line}`;
          // A line fits each limit of WHY_LIMITS, thus each message has its why.
          expect(line, where).toBeDefined();
          const text = line ?? "";
          expect(fitsWhy(text, limit), where).toBe(true);
          expect(text, where).toMatch(WHY_TEXT);
          expect(text, where).not.toMatch(/[A-Z]{2}/);
          // The only colon is the colon of the prefix, thus the line holds no node key.
          const prefix = record.coverage < WHY_FULL_COVERAGE ? "Why, in part: " : "Why: ";
          expect(text.startsWith(prefix), where).toBe(true);
          expect(text.slice(prefix.length), where).not.toContain(":");
        }
      }
    }
  });

  it("names a watched place by its label", () => {
    const labels = labelsOf({ "place:home": "Lake cabin" });
    expect(whyLine(HOME, labels, WHY_LIMITS.push)).toBe("Why: Lake cabin is in the area");
    expect(whyLine(HOME, labels, WHY_LIMITS.text)).toBe("Why: Lake cabin is in the area");
    expect(whyLine(HOME, labels, WHY_LIMITS.call)).toBe("Why: Lake cabin is in the area");
  });

  it("uses plain nouns when a label is absent, unsafe or too long", () => {
    expect(whyLine(HOME, NO_LABELS, WHY_LIMITS.push)).toBe("Why: your place is in the area");
    for (const label of UNSAFE) expect(whyLine(HOME, labelsOf({ "place:home": label }), WHY_LIMITS.push), label).toBe("Why: your place is in the area");
    // The line with this label has 47 characters: it fits a push and not a text.
    const long = labelsOf({ "place:home": "Grandma's farm, south field" });
    expect(whyLine(HOME, long, WHY_LIMITS.push)).toBe("Why: Grandma's farm, south field is in the area");
    expect(whyLine(HOME, long, WHY_LIMITS.text)).toBe("Why: your place is in the area");
    expect(whyLine(HOME, labelsOf({ "place:home": PLAIN.at(-1)! }), WHY_LIMITS.push)).toBe("Why: your place is in the area");
  });

  it("tells a part of the reason when the coverage is below the full coverage", () => {
    expect(whyLine({ ...HOME, coverage: 0.5 }, NO_LABELS, WHY_LIMITS.text)).toBe("Why, in part: your place is in the area");
    expect(whyLine({ ...HOME, coverage: WHY_FULL_COVERAGE }, NO_LABELS, WHY_LIMITS.text)).toBe("Why: your place is in the area");
  });

  it("names a topic and a service that the person has", () => {
    const topic: WhyRecord = { rule: "reach.topic.base", subject: "topic:infra.power", kind: "topic", anchor: "topic:infra.power", origin: "base", coverage: 1 };
    const service: WhyRecord = { rule: "reach.entity.services", subject: "domain:example.com", kind: "entity", anchor: "domain:example.com", origin: "services", coverage: 1 };
    expect(whyLine(topic, labelsOf({ "topic:infra.power": "Power cuts" }), WHY_LIMITS.push)).toBe("Why: you follow Power cuts");
    expect(whyLine(topic, NO_LABELS, WHY_LIMITS.push)).toBe("Why: you follow this topic");
    expect(whyLine(service, labelsOf({ "domain:example.com": "Mail" }), WHY_LIMITS.push)).toBe("Why: you use Mail");
    expect(whyLine(service, NO_LABELS, WHY_LIMITS.push)).toBe("Why: you use this service");
  });

  it("names the subject, the via node and the anchor of a longer path, and drops the via node first", () => {
    const record: WhyRecord = {
      rule: "reach.entity.services",
      subject: "provider-region:us-east-1",
      kind: "entity",
      via: "domain:example.com",
      anchor: "domain:shop.example",
      origin: "services",
      coverage: 1,
    };
    const labels = labelsOf({ "provider-region:us-east-1": "Cloud east", "domain:example.com": "Example mail", "domain:shop.example": "Your shop" });
    expect(whyLine(record, labels, WHY_LIMITS.push)).toBe("Why: Cloud east can affect Your shop via Example mail");
    expect(whyLine(record, labels, WHY_LIMITS.text)).toBe("Why: Cloud east can affect Your shop");
    expect(whyLine(record, NO_LABELS, WHY_LIMITS.push)).toBe("Why: this event can affect your service");
    expect(whyLine({ ...record, coverage: 0.4 }, NO_LABELS, WHY_LIMITS.text)).toBe("Why, in part: it can affect your service");
  });

  it("gives no line when no line fits the limit", () => {
    expect(whyLine(HOME, NO_LABELS, { chars: 10 })).toBeUndefined();
    expect(whyLine(HOME, NO_LABELS, { words: 3 })).toBeUndefined();
  });

  it("counts code points and words", () => {
    expect(fitsWhy("Why: a b", { chars: 8, words: 3 })).toBe(true);
    expect(fitsWhy("Why: a b", { chars: 7 })).toBe(false);
    expect(fitsWhy("Why:  a   b ", { words: 3 })).toBe(true);
    expect(fitsWhy("Why: a b c", { words: 3 })).toBe(false);
    expect(fitsWhy("\u{1F600}", { chars: 1 })).toBe(true);
  });

  it("keeps only labels of plain words", () => {
    expect(plainLabel(labelsOf({ "place:a": "  Lake   cabin " }), "place:a")).toBe("Lake cabin");
    expect(plainLabel(labelsOf({ "place:a": "DFW office" }), "place:a")).toBeUndefined();
    expect(plainLabel(labelsOf({ "place:a": "ALLCAPS" }), "place:a")).toBeUndefined();
    expect(plainLabel(NO_LABELS, "place:a")).toBeUndefined();
  });

  it("gives the kind of a node key from its system", () => {
    expect(kindOfNode("ugc:KSC173")).toBe("place");
    expect(kindOfNode("topic:met.flood")).toBe("topic");
    expect(kindOfNode("purl:pkg:npm/example")).toBe("entity");
    expect(kindOfNode("person")).toBeUndefined();
    expect(kindOfNode("unknown:x")).toBeUndefined();
    expect(kindOfNode(":x")).toBeUndefined();
    expect(kindOfNode("constructor:x")).toBeUndefined();
  });
});

describe("placeWhy", () => {
  it("gives the place with the first id, whatever the order of the places", () => {
    const why = placeWhy(ids("work", "home", "lake"));
    expect(why).toEqual({ rule: "reach.place.places", subject: "place:home", kind: "place", anchor: "place:home", origin: "places", coverage: 1 });
    expect(placeWhy(ids("lake", "work", "home"))).toEqual(why);
    expect(whyRecordSchema.safeParse(why).success).toBe(true);
  });

  it("gives no why when no place matches", () => {
    expect(placeWhy([])).toBeUndefined();
  });
});

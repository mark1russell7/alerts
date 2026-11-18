import { knownKind } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";

import { detailsFiles, NCEI_KINDS, nceiKind, RecordFramer, sumDetails } from "./ncei.ts";

/** The header of the files of details of NCEI, version 1.0. */
const HEADER =
  "BEGIN_YEARMONTH,BEGIN_DAY,BEGIN_TIME,END_YEARMONTH,END_DAY,END_TIME,EPISODE_ID,EVENT_ID,STATE,STATE_FIPS,YEAR,MONTH_NAME,EVENT_TYPE,CZ_TYPE,CZ_FIPS,CZ_NAME,WFO,BEGIN_DATE_TIME,CZ_TIMEZONE,END_DATE_TIME,INJURIES_DIRECT,INJURIES_INDIRECT,DEATHS_DIRECT,DEATHS_INDIRECT,DAMAGE_PROPERTY,DAMAGE_CROPS,SOURCE,MAGNITUDE,MAGNITUDE_TYPE,FLOOD_CAUSE,CATEGORY,TOR_F_SCALE,TOR_LENGTH,TOR_WIDTH,TOR_OTHER_WFO,TOR_OTHER_CZ_STATE,TOR_OTHER_CZ_FIPS,TOR_OTHER_CZ_NAME,BEGIN_RANGE,BEGIN_AZIMUTH,BEGIN_LOCATION,END_RANGE,END_AZIMUTH,END_LOCATION,BEGIN_LAT,BEGIN_LON,END_LAT,END_LON,EPISODE_NARRATIVE,EVENT_NARRATIVE,DATA_SOURCE";

interface Row {
  readonly yearMonth: string;
  readonly id: string;
  readonly type: string;
  readonly injuries?: readonly [direct: string, indirect: string];
  readonly deaths?: readonly [direct: string, indirect: string];
  readonly narrative?: string;
}

/** A synthetic row of a file of details, in Kansas, with the 51 fields of the header. */
const row = ({ yearMonth, id, type, injuries = ["0", "0"], deaths = ["0", "0"], narrative = "A synthetic event." }: Row): string => {
  const fields = [
    yearMonth, "1", "1200", yearMonth, "1", "1210", "1", id, '"KANSAS"', "20", yearMonth.slice(0, 4), '"May"', `"${type}"`, '"C"', "1", '"SYNTHETIC"', '"DDC"',
    '"01-MAY-25 12:00:00"', '"CST-6"', '"01-MAY-25 12:10:00"', `"${injuries[0]}"`, `"${injuries[1]}"`, `"${deaths[0]}"`, `"${deaths[1]}"`, '"0.00K"', '"0.00K"', '"Public"',
    "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", "", '"An episode, with a comma."', `"${narrative}"`, '"CSV"',
  ];
  expect(fields).toHaveLength(51);
  return fields.join(",");
};

const months = (year: number): string[] => Array.from({ length: 12 }, (_, index) => `${String(year)}${String(index + 1).padStart(2, "0")}`);

/** A file of one year: one hail row in each month, and some rows with deaths and injuries. */
const file = (year: number, extra: readonly Row[] = []): string =>
  [HEADER, ...months(year).map((yearMonth, index) => row({ yearMonth, id: `${String(year)}${String(index)}`, type: "Hail" })), ...extra.map(row)].join("\n") + "\n";

/** This function cuts a text in pieces of `size` characters, as a stream gives it. */
const pieces = (text: string, size: number): string[] => Array.from({ length: Math.ceil(text.length / size) }, (_, index) => text.slice(index * size, (index + 1) * size));

describe("the files of details in the folder", () => {
  it("keeps the latest version of each year, in the order of the years", () => {
    const page = [
      '<a href="StormEvents_details-ftp_v1.0_d2025_c20260301.csv.gz">',
      '<a href="StormEvents_details-ftp_v1.0_d2024_c20260728.csv.gz">',
      '<a href="StormEvents_details-ftp_v1.0_d2025_c20260819.csv.gz">',
      '<a href="StormEvents_fatalities-ftp_v1.0_d2025_c20260819.csv.gz">',
      '<a href="StormEvents_locations-ftp_v1.0_d2025_c20260819.csv.gz">',
    ].join("\n");
    expect(detailsFiles(page)).toEqual([
      { year: 2024, created: "20260728", name: "StormEvents_details-ftp_v1.0_d2024_c20260728.csv.gz" },
      { year: 2025, created: "20260819", name: "StormEvents_details-ftp_v1.0_d2025_c20260819.csv.gz" },
    ]);
    expect(detailsFiles("no files")).toEqual([]);
  });
});

describe("the framer of CSV records", () => {
  it("cuts only at a line break out of quotes, for each size of piece", () => {
    const text = 'a,"b\nc",d\n"e ""f""\n",g\nh,i\n';
    for (const size of [1, 2, 3, 5, 8, 100]) {
      const framer = new RecordFramer();
      const parts = [...pieces(text, size).map((piece) => framer.push(piece)), framer.end()];
      expect(parts.join(""), String(size)).toBe(text);
      for (const part of parts.filter((part) => part !== "")) expect(part.endsWith("\n") || part === "", String(size)).toBe(true);
    }
  });

  it("gives the last record with no line break at the end", () => {
    const framer = new RecordFramer();
    expect(framer.push("a,b\nc,d")).toBe("a,b\n");
    expect(framer.end()).toBe("c,d");
  });

  it("throws an error for a quote that does not close", () => {
    const framer = new RecordFramer();
    framer.push('a,"b\n');
    expect(() => framer.end()).toThrow(/in quotes/);
  });
});

describe("the sums of a file of details", () => {
  it("sums the deaths and injuries of each type, for each size of piece", async () => {
    const text = file(2025, [
      { yearMonth: "202505", id: "9001", type: "Tornado", injuries: ["3", "1"], deaths: ["2", "0"], narrative: 'A line,\nwith a break and a ""quote"".' },
      { yearMonth: "202506", id: "9002", type: "Tornado", deaths: ["0", "1"] },
      { yearMonth: "202507", id: "9003", type: "Flash Flood", deaths: ["1", "0"] },
    ]);
    for (const size of [7, 64, 1000, text.length]) {
      const harm = await sumDetails(pieces(text, size), 2025);
      expect(harm, String(size)).toEqual({
        year: 2025,
        rows: 15,
        months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        types: {
          "Flash Flood": { events: 1, deathsDirect: 1, deathsIndirect: 0, injuriesDirect: 0, injuriesIndirect: 0 },
          Hail: { events: 12, deathsDirect: 0, deathsIndirect: 0, injuriesDirect: 0, injuriesIndirect: 0 },
          Tornado: { events: 2, deathsDirect: 2, deathsIndirect: 1, injuriesDirect: 3, injuriesIndirect: 1 },
        },
        harmed: [
          { id: "9001", type: "Tornado", stateFips: "20", czType: "C", czFips: "1", timeZone: "CST-6", begin: { yearMonth: "202505", day: "1", time: "1200" }, end: { yearMonth: "202505", day: "1", time: "1210" }, deaths: 2, injuries: 4 },
          { id: "9002", type: "Tornado", stateFips: "20", czType: "C", czFips: "1", timeZone: "CST-6", begin: { yearMonth: "202506", day: "1", time: "1200" }, end: { yearMonth: "202506", day: "1", time: "1210" }, deaths: 1, injuries: 0 },
          { id: "9003", type: "Flash Flood", stateFips: "20", czType: "C", czFips: "1", timeZone: "CST-6", begin: { yearMonth: "202507", day: "1", time: "1200" }, end: { yearMonth: "202507", day: "1", time: "1210" }, deaths: 1, injuries: 0 },
        ],
      });
      expect(JSON.stringify(harm)).not.toMatch(/KANSAS|SYNTHETIC/);
    }
  });

  it("reads a stream of texts", async () => {
    async function* stream(): AsyncGenerator<string> {
      yield* pieces(file(2024), 50);
    }
    expect((await sumDetails(stream(), 2024)).rows).toBe(12);
  });

  it("throws an error for a row of a different year, a bad count, a bad row or an event two times", async () => {
    await expect(sumDetails([file(2025)], 2024)).rejects.toThrow(/not in 2024/);
    await expect(sumDetails([file(2025, [{ yearMonth: "202501", id: "9", type: "Hail", deaths: ["1.5", "0"] }])], 2025)).rejects.toThrow(/bad DEATHS_DIRECT/);
    await expect(sumDetails([file(2025, [{ yearMonth: "202501", id: "9", type: "" }])], 2025)).rejects.toThrow(/no type/);
    await expect(sumDetails([file(2025, [{ yearMonth: "202501", id: "20250", type: "Hail" }])], 2025)).rejects.toThrow(/two times/);
    await expect(sumDetails([`${file(2025)}1,2,3\n`], 2025)).rejects.toThrow(/has 3 fields/);
    await expect(sumDetails(["EVENT_ID,EVENT_TYPE\n"], 2025)).rejects.toThrow(/no column BEGIN_YEARMONTH/);
    await expect(sumDetails([""], 2025)).rejects.toThrow(/is empty/);
  });
});

describe("the map of the event types", () => {
  it("gives a kind of the taxonomy, or null, for each type", () => {
    for (const [type, kind] of Object.entries(NCEI_KINDS)) if (kind !== null) expect(knownKind(kind), type).toBe(true);
    expect(nceiKind("Tornado")).toBe("met.tornado");
    expect(nceiKind("Drought")).toBeNull();
    expect(nceiKind("A new type")).toBeUndefined();
    expect(nceiKind("toString")).toBeUndefined();
  });
});

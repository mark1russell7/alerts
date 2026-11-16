import { readFileSync } from "node:fs";
import { distanceKm } from "@mark1russell7/geo";
import { describe, expect, it } from "vitest";
import type { AssessedLevel, PersonId, PersonWatch, PlaceId, Position, Report, WatchedPlace } from "./contracts.ts";
import { DEFAULT_ASSESS_POLICY, EARTHQUAKE_PAST_WITHIN, assess } from "./assess.ts";
import { EMPTY_STATE, add, incidents } from "./merge.ts";
import { assessmentSchema, incidentSchema, reportSchema } from "./schemas.ts";

// The four band reports of the USGS event us6000jllz (M 7.8, 2023-02-06). The file fixtures/README.md tells their source.
const reports = JSON.parse(readFileSync(new URL("../fixtures/usgs-us6000jllz-bands.json", import.meta.url), "utf8")) as Report[];
const epicenter: Position = [37.0143, 37.2256];
// A point on the meridian of the epicenter, at a distance to the north. No position is a watched place of a real person.
const north = (km: number): Position => [epicenter[0], epicenter[1] + km / ((6371.0088 * Math.PI) / 180)];
const place = "place-1" as PlaceId;
const watch: PersonWatch = { person: "person-1" as PersonId, places: [place], rules: [] };
const placeAt = (km: number): WatchedPlace => ({ id: place, codes: [], at: north(km), bufferKm: 0 });
const minute = 60_000;

describe("a real earthquake: the bands of us6000jllz (AL-31, AL-14)", () => {
  const origin = reports[0]?.onset ?? 0;
  const found = incidents(add(EMPTY_STATE, { reports }), origin + 10 * minute);
  const [quake] = found;
  const levelAt = (km: number, minutes = 10): AssessedLevel =>
    quake === undefined ? "none" : assess(quake, watch, [placeAt(km)], DEFAULT_ASSESS_POLICY, origin + minutes * minute).level;

  it("has four valid reports, and they merge into one incident with one line for each band", () => {
    expect(reports).toHaveLength(4);
    expect(reports.map((report) => reportSchema.safeParse(report).success)).toEqual([true, true, true, true]);
    expect(reports.map((report) => report.onset)).toEqual([origin, origin, origin, origin]);
    expect(found).toHaveLength(1);
    expect(incidentSchema.safeParse(quake).success).toBe(true);
    expect(quake?.lines?.map((line) => line.severity).sort()).toEqual(["extreme", "minor", "moderate", "severe"]);
    const latLon = (at: Position) => ({ lat: at[1], lon: at[0] });
    expect(distanceKm(latLon(north(100)), latLon(epicenter))).toBeCloseTo(100, 6);
  });

  it("wakes a place in the band extreme, and gives each band farther out a lower level", () => {
    expect(levelAt(20)).toBe("life-safety");
    expect(levelAt(60)).toBe("urgent");
    expect(levelAt(100)).toBe("notice");
    expect(levelAt(300)).toBe("digest");
    expect(levelAt(600)).toBe("none");
    expect(quake === undefined ? false : assessmentSchema.safeParse(assess(quake, watch, [placeAt(20)], DEFAULT_ASSESS_POLICY, origin + 10 * minute)).success).toBe(true);
  });

  it("gives a digest after the window of one hour", () => {
    expect(levelAt(20, EARTHQUAKE_PAST_WITHIN / minute)).toBe("life-safety");
    expect(levelAt(20, 120)).toBe("digest");
    expect(levelAt(60, 120)).toBe("digest");
  });
});

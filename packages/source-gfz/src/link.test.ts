/**
 * The gate of the link window of the geomagnetic storms, on the real index Kp of GFZ and the real messages of the SWPC.
 * The merge rule 3 (`linkRule` of the core) joins each run of GFZ with the storm reports of the SWPC near it.
 * The script `scripts/measure-link.ts` measures the window over the years 2015 to 2025. These storms are cases that the
 * window decides.
 */

import { readFileSync } from "node:fs";
import { DEFAULT_LINK_POLICY, hasKind, incidents, linkRule, normalize, observationId, type Instant, type LinkPolicy, type Report } from "@mark1russell7/alerts";
import { entryBody, mapObservation as mapSwpc, messageTime, SOURCE_ID as SWPC_SOURCE } from "@mark1russell7/alerts-source-swpc";
import { GEOMAGNETIC_STORM_KIND } from "@mark1russell7/alerts-space-weather";
import { describe, expect, it } from "vitest";
import { readAnswer } from "./fetch.ts";
import { mapObservation, SOURCE_ID } from "./map.ts";

const HOUR = 3_600_000;
const MINUTE = 60_000;
const problems: unknown[] = [];
const reply = (body: string) => ({ status: 200, statusText: "OK", headers: { "content-type": "application/json" }, body });

/**
 * This function gives the reports of one real answer of GFZ (`fixtures/README.md`). It reads the answer at the start of
 * its first interval, so each interval of G1 or more gives a report. The link rule uses the onsets, not the fetch times.
 */
function gfzReports(name: string): Report[] {
  const body = readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
  const first = Date.parse((JSON.parse(body) as { readonly datetime: readonly string[] }).datetime[0] ?? "");
  const read = readAnswer(reply(body), "https://gfz.test/app/json/", "https://gfz.test/app/json/", first, 0);
  return (read?.observations ?? []).flatMap((observation) => {
    const result = mapObservation(observation);
    problems.push(...result.problems);
    return result.reports;
  });
}

/**
 * This function gives the storm reports of real archive messages of the SWPC (`fixtures/README.md` of the SWPC source).
 * The archive has no list, so the issue time of the list is the issue time of the text.
 */
function swpcReports(name: string): Report[] {
  const samples = JSON.parse(readFileSync(new URL(`../../source-swpc/fixtures/${name}`, import.meta.url), "utf8")) as { readonly message: string }[];
  return samples.flatMap(({ message }) => {
    const issued = messageTime(/Issue Time: ([^\n]+)\n/.exec(message)?.[1] ?? "") ?? Number.NaN;
    const body = entryBody({ product_id: "", issue_datetime: new Date(issued).toISOString().replace("T", " ").replace("Z", ""), message });
    const url = "https://swpc.test/products/alerts.json";
    const result = mapSwpc({ id: observationId({ source: SWPC_SOURCE, contentType: "application/json", url, body }), source: SWPC_SOURCE, fetched: issued, contentType: "application/json", body, transport: { url, latency: 0 } });
    problems.push(...result.problems);
    return result.reports.filter((report) => hasKind([GEOMAGNETIC_STORM_KIND], report.kind.code));
  });
}

/** The link policy of the core with a different window for the geomagnetic storms. */
const withWindow = (hours: number): LinkPolicy => ({
  families: DEFAULT_LINK_POLICY.families.map((family) => (family.family === GEOMAGNETIC_STORM_KIND ? { ...family, windowMs: hours * HOUR } : family)),
});

/** The incident of each run of GFZ, by the start of the run: the runs and the sources in the incident. */
function runIncidents(reports: readonly Report[], at: Instant, policy: LinkPolicy): Record<string, { runs: string[]; sources: string[] }> {
  const byId = new Map(reports.map((report) => [report.id, report]));
  const found: Record<string, { runs: string[]; sources: string[] }> = {};
  for (const incident of incidents(normalize({ reports }), at, { link: linkRule(policy) })) {
    const members = incident.reports.flatMap((id) => byId.get(id) ?? []);
    const runs = [...new Set(members.filter((report) => report.source === SOURCE_ID).map((report) => report.correlation[0]?.id ?? ""))].sort();
    const sources = [...new Set<string>(members.map((report) => report.source))].sort();
    for (const run of runs) found[run] = { runs, sources };
  }
  return found;
}

/** The least onset difference of each run of GFZ to a storm report of the SWPC, in minutes. */
function gaps(gfz: readonly Report[], swpc: readonly Report[]): Record<string, number> {
  const found: Record<string, number> = {};
  for (const report of gfz) {
    const run = report.correlation[0]?.id ?? "";
    for (const other of swpc) {
      if (report.onset === undefined || other.onset === undefined) continue;
      found[run] = Math.min(found[run] ?? Infinity, Math.abs(other.onset - report.onset) / MINUTE);
    }
  }
  return found;
}

const AUGUST_GFZ = gfzReports("kp-20240829-20240831.json");
const AUGUST_SWPC = swpcReports("archive-20240827-20240831.json");
const AUGUST_END = Date.parse("2024-09-01T00:00:00Z");
const MAY_GFZ = gfzReports("kp-20250529-20250531.json");
const MAY_SWPC = swpcReports("archive-20250526-20250531.json");
const MAY_END = Date.parse("2025-06-01T00:00:00Z");

describe("the link window of the geomagnetic storms on real data", () => {
  it("maps each answer and each message with no problem", () => {
    expect(problems).toEqual([]);
    expect([AUGUST_GFZ.length, AUGUST_SWPC.length, MAY_GFZ.length, MAY_SWPC.length]).toEqual([4, 13, 9, 33]);
  });

  it("gives the least onset difference of each run of GFZ to a storm report of the SWPC", () => {
    expect(gaps(AUGUST_GFZ, AUGUST_SWPC)).toEqual({ "2024-08-30T12:00:00Z": 335, "2024-08-31T15:00:00Z": 72 });
    expect(gaps(MAY_GFZ, MAY_SWPC)).toEqual({ "2025-05-29T00:00:00Z": 1, "2025-05-30T15:00:00Z": 540 });
  });

  it("joins a run 5 hours 35 minutes from the SWPC with the window of the core, and not with a window of 3 hours", () => {
    const reports = [...AUGUST_GFZ, ...AUGUST_SWPC];
    expect(runIncidents(reports, AUGUST_END, DEFAULT_LINK_POLICY)).toEqual({
      "2024-08-30T12:00:00Z": { runs: ["2024-08-30T12:00:00Z"], sources: ["gfz", "swpc"] },
      "2024-08-31T15:00:00Z": { runs: ["2024-08-31T15:00:00Z"], sources: ["gfz", "swpc"] },
    });
    expect(runIncidents(reports, AUGUST_END, withWindow(3))).toEqual({
      "2024-08-30T12:00:00Z": { runs: ["2024-08-30T12:00:00Z"], sources: ["gfz"] },
      "2024-08-31T15:00:00Z": { runs: ["2024-08-31T15:00:00Z"], sources: ["gfz", "swpc"] },
    });
  });

  it("keeps apart a run of one interval 9 hours from the SWPC, which a window of 9 hours joins with the storm of the day before", () => {
    const reports = [...MAY_GFZ, ...MAY_SWPC];
    expect(runIncidents(reports, MAY_END, DEFAULT_LINK_POLICY)).toEqual({
      "2025-05-29T00:00:00Z": { runs: ["2025-05-29T00:00:00Z"], sources: ["gfz", "swpc"] },
      "2025-05-30T15:00:00Z": { runs: ["2025-05-30T15:00:00Z"], sources: ["gfz"] },
    });
    // A window of 9 hours joins the run with the storm of the day before, through the reports of the SWPC.
    const joined = { runs: ["2025-05-29T00:00:00Z", "2025-05-30T15:00:00Z"], sources: ["gfz", "swpc"] };
    expect(runIncidents(reports, MAY_END, withWindow(9))).toEqual({ "2025-05-29T00:00:00Z": joined, "2025-05-30T15:00:00Z": joined });
  });
});

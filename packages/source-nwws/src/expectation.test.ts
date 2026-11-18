import { readFileSync } from "node:fs";
import { copyMeasure, type Observation, type ObservationId, type Report, type SourceId } from "@mark1russell7/alerts";
import { nwsEvent } from "@mark1russell7/alerts-format-nws";
import { mapObservation as mapApi, SOURCE_ID as API } from "@mark1russell7/alerts-source-nws-api";
import { describe, expect, it } from "vitest";
import { COPY_EXPECTATION } from "./expectation.ts";
import { mapObservation, SOURCE_ID } from "./map.ts";

/**
 * The real messages of one event of the office KEWX, the flash flood warning 0108. The test uses the NWS API copy and
 * the IPAWS copy of the first message and of its extension. Their one home is the package `format-cap`. The NWWS-OI copy of a
 * message is the CAP text of the NWS with the id of the message. The test makes it from the IPAWS copy: it removes the
 * end `.IPAWS` of each id.
 */
const PAIRS = new URL("../../format-cap/fixtures/pairs/", import.meta.url);
const pair = (name: string): string => readFileSync(new URL(name, PAIRS), "utf8");
const MINUTE = 60_000;

const observe = (source: SourceId, body: string, fetched: number, contentType: string): Observation => ({
  id: `observation-${source}-${String(fetched)}` as ObservationId,
  source,
  fetched,
  contentType,
  body,
  transport: { latency: 0 },
});

/** This function gives the reports of the NWS API copy and of the NWWS-OI copy of one message. */
function message(name: string, apiAt: number, streamAt: number): { readonly api: Report[]; readonly stream: Report[] } {
  const stream = pair(`${name}.ipaws.xml`).replaceAll(".IPAWS", "");
  return {
    api: [...mapApi(observe(API, pair(`${name}.nws-api.json`), apiAt, "application/geo+json")).reports],
    stream: [...mapObservation(observe(SOURCE_ID, stream, streamAt, "application/xml")).reports],
  };
}

const NEW = message("kewx-ff-w-0108-new", 10 * MINUTE, 9 * MINUTE);
const EXT = message("kewx-ff-w-0108-ext", 40 * MINUTE, 39 * MINUTE);

describe("COPY_EXPECTATION: NWWS-OI carries the messages of the NWS API", () => {
  it("goes from the NWS API source to this source, for each actual report", () => {
    expect(COPY_EXPECTATION).toEqual({ id: "nws-api.nwws", from: API, to: SOURCE_ID, when: { statuses: ["actual"] } });
  });

  it("finds the copy of each message at its sent time, and a copy that came first gives a delay below 0", () => {
    const result = copyMeasure([...NEW.api, ...NEW.stream, ...EXT.api, ...EXT.stream], COPY_EXPECTATION, { eventOf: nwsEvent });
    expect(result.counts).toEqual({ messages: 2, same: 2, shifted: 0, lost: 0, apart: 0, none: 0, censored: 0 });
    expect(result.checks.map((check) => [check.event, check.class, check.delay])).toEqual([
      ["FFW", "same", -MINUTE],
      ["FFW", "same", -MINUTE],
    ]);
  });

  it("counts the extension as lost when the stream lost its copy", () => {
    const result = copyMeasure([...NEW.api, ...NEW.stream, ...EXT.api], COPY_EXPECTATION, { eventOf: nwsEvent });
    expect(result.counts).toEqual({ messages: 2, same: 1, shifted: 0, lost: 1, apart: 0, none: 0, censored: 0 });
  });
});

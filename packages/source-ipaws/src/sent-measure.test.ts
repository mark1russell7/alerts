import { readFileSync } from "node:fs";
import { sentFails, type Instant, type Observation, type ObservationId, type Report, type SentCounts, type SourceId } from "@mark1russell7/alerts";
import { mapObservation as mapApi, SOURCE_ID as API } from "@mark1russell7/alerts-source-nws-api";
import { describe, expect, it } from "vitest";
import { mapObservation as mapIpaws, SOURCE_ID as IPAWS } from "./map.ts";
import { COPY_SUFFIX, sentMeasure } from "./sent-measure.ts";

/**
 * The real messages of one event of a Texas office (KEWX, flash flood warning 0108): the NWS API copy and
 * the IPAWS copy of the first message and of its extension. Their one home is the package `format-cap`.
 */
const PAIRS = new URL("../../format-cap/fixtures/pairs/", import.meta.url);
const pair = (name: string): string => readFileSync(new URL(name, PAIRS), "utf8");

interface Message {
  readonly api: string;
  readonly ipaws: string;
  readonly key: string;
  readonly sent: Instant;
  /** The sent time as the two copies write it. */
  readonly sentText: string;
}

const message = (name: string): Message => {
  const api = pair(`${name}.nws-api.json`);
  const properties = (JSON.parse(api) as { properties: { id: string; sent: string } }).properties;
  return { api, ipaws: pair(`${name}.ipaws.xml`), key: properties.id, sent: Date.parse(properties.sent), sentText: properties.sent };
};
const NEW = message("kewx-ff-w-0108-new");
const EXT = message("kewx-ff-w-0108-ext");
const SECOND = 1000;

const observe = (source: SourceId, body: string, fetched: Instant, contentType: string): Observation => ({
  id: `observation-${source}-${String(fetched)}` as ObservationId,
  source,
  fetched,
  contentType,
  body,
  transport: { latency: 0 },
});

/** This function maps one NWS API copy with the map of its source. */
const apiReport = (text: string, fetched: Instant): Report[] => [...mapApi(observe(API, text, fetched, "application/geo+json")).reports];
/** This function maps one IPAWS copy with the map of this source. */
const ipawsReport = (xml: string, fetched: Instant): Report[] => [...mapIpaws(observe(IPAWS, xml, fetched, "application/xml")).reports];

/** This function gives the IPAWS copy with a different sent time: the sent time of the message plus `shift`. */
function shifted(one: Message, shift: number): string {
  const offset = one.sentText.slice(19);
  const local = new Date(one.sent + shift + offsetMs(offset)).toISOString().slice(0, 19);
  const text = one.ipaws.replace(`<sent>${one.sentText}</sent>`, `<sent>${local}${offset}</sent>`);
  expect(text).not.toBe(one.ipaws);
  return text;
}

/** This function gives the time of an offset `-06:00` in milliseconds. */
function offsetMs(offset: string): number {
  const sign = offset.startsWith("-") ? -1 : 1;
  const [hours, minutes] = offset.slice(1).split(":").map(Number);
  return sign * ((hours ?? 0) * 60 + (minutes ?? 0)) * 60_000;
}

/** The two messages and their two real copies: the NWS API copy 20 seconds after the sent time, IPAWS 40 seconds after. */
const api = (): Report[] => [...apiReport(NEW.api, NEW.sent + 20 * SECOND), ...apiReport(EXT.api, EXT.sent + 20 * SECOND)];
const zero: SentCounts = { messages: 0, same: 0, shifted: 0, lost: 0, apart: 0, none: 0, censored: 0 };

describe("sentMeasure: the sent times of the WEA copies, over the real KEWX pairs", () => {
  it("finds the copy of each message at its sent time", () => {
    const reports = [...api(), ...ipawsReport(NEW.ipaws, NEW.sent + 40 * SECOND), ...ipawsReport(EXT.ipaws, EXT.sent + 40 * SECOND)];
    const result = sentMeasure(reports);
    expect(result.counts).toEqual({ ...zero, messages: 2, same: 2 });
    expect(sentFails(result.counts)).toBe(false);
    expect(result.gaps).toEqual([]);
    expect(result.checks.map((check) => [check.key, check.event, check.sent, check.class])).toEqual([
      [NEW.key, "FFW", NEW.sent, "same"],
      [EXT.key, "FFW", EXT.sent, "same"],
    ]);
    expect(result.checks[1]?.copies).toEqual([
      { key: `${NEW.key}${COPY_SUFFIX}`, sent: NEW.sent },
      { key: `${EXT.key}${COPY_SUFFIX}`, sent: EXT.sent },
    ]);
  });

  it("counts a copy one second after the sent time as shifted, with the pair of the two times", () => {
    const later = ipawsReport(shifted(EXT, SECOND), EXT.sent + 40 * SECOND);
    expect(later.map((report) => report.sent)).toEqual([EXT.sent + SECOND]);
    const result = sentMeasure([...api(), ...ipawsReport(NEW.ipaws, NEW.sent + 40 * SECOND), ...later]);
    expect(result.counts).toEqual({ ...zero, messages: 2, same: 1, shifted: 1 });
    expect(sentFails(result.counts)).toBe(true);
    expect(result.gaps).toEqual([
      {
        report: result.checks[1]?.report,
        key: EXT.key,
        event: "FFW",
        sent: EXT.sent,
        class: "shifted",
        copy: { key: `${EXT.key}${COPY_SUFFIX}`, sent: EXT.sent + SECOND },
        match: "id",
        difference: SECOND,
      },
    ]);
  });

  it("counts a copy one second before the sent time as shifted", () => {
    const result = sentMeasure([...api(), ...ipawsReport(shifted(NEW, -SECOND), NEW.sent + 40 * SECOND), ...ipawsReport(EXT.ipaws, EXT.sent + 40 * SECOND)]);
    expect(result.counts).toEqual({ ...zero, messages: 2, same: 1, shifted: 1 });
    expect(result.gaps.map((gap) => [gap.key, gap.match, gap.difference])).toEqual([[NEW.key, "id", -SECOND]]);
  });

  it("counts a copy with a different id and a different sent time as lost, and pairs it by the nearest sent time", () => {
    const other = shifted(EXT, SECOND).replace(`<identifier>${EXT.key}${COPY_SUFFIX}</identifier>`, "<identifier>urn:oid:2.49.0.1.840.0.other</identifier>");
    const result = sentMeasure([...api(), ...ipawsReport(NEW.ipaws, NEW.sent + 40 * SECOND), ...ipawsReport(other, EXT.sent + 40 * SECOND)]);
    expect(result.counts).toEqual({ ...zero, messages: 2, same: 1, lost: 1 });
    expect(result.gaps.map((gap) => [gap.key, gap.class, gap.copy.key, gap.match, gap.difference])).toEqual([[EXT.key, "lost", "urn:oid:2.49.0.1.840.0.other", "nearest", SECOND]]);
  });

  it("counts a lost copy of the extension as lost, because the incident has only the copy of the first message", () => {
    const result = sentMeasure([...api(), ...ipawsReport(NEW.ipaws, NEW.sent + 40 * SECOND)]);
    expect(result.counts).toEqual({ ...zero, messages: 2, same: 1, lost: 1 });
    expect(sentFails(result.counts)).toBe(true);
    expect(result.checks.map((check) => [check.key, check.class])).toEqual([
      [NEW.key, "same"],
      [EXT.key, "lost"],
    ]);
    expect(result.gaps.map((gap) => [gap.key, gap.class, gap.copy.key, gap.match, gap.difference])).toEqual([[EXT.key, "lost", `${NEW.key}${COPY_SUFFIX}`, "nearest", NEW.sent - EXT.sent]]);
  });

  it("keeps a copy with the id at a different sent time as shifted next to a lost copy, and the exit rule uses the sum", () => {
    const result = sentMeasure([...api(), ...ipawsReport(shifted(NEW, -SECOND), NEW.sent + 40 * SECOND)]);
    expect(result.counts).toEqual({ ...zero, messages: 2, shifted: 1, lost: 1 });
    expect(result.gaps.map((gap) => [gap.key, gap.class, gap.copy.key, gap.match, gap.difference])).toEqual([
      [NEW.key, "shifted", `${NEW.key}${COPY_SUFFIX}`, "id", -SECOND],
      [EXT.key, "lost", `${NEW.key}${COPY_SUFFIX}`, "nearest", NEW.sent - SECOND - EXT.sent],
    ]);
    expect(sentFails(result.counts)).toBe(true);
    expect(sentFails({ ...result.counts, lost: 0 })).toBe(true);
    expect(sentFails({ ...result.counts, shifted: 0 })).toBe(true);
    expect(sentFails({ ...result.counts, shifted: 0, lost: 0 })).toBe(false);
  });

  it("counts a message with no copy as none", () => {
    const result = sentMeasure(api());
    expect(result.counts).toEqual({ ...zero, messages: 2, none: 2 });
    expect(sentFails(result.counts)).toBe(false);
    expect(result.gaps).toEqual([]);
  });

  it("counts a copy with the id of the message in a different incident as apart", () => {
    const noVtec = NEW.ipaws.replaceAll(/<parameter><valueName>VTEC<\/valueName><value>[^<]*<\/value><\/parameter>/g, "");
    expect(noVtec).not.toBe(NEW.ipaws);
    const result = sentMeasure([...apiReport(NEW.api, NEW.sent + 20 * SECOND), ...ipawsReport(noVtec, NEW.sent + 40 * SECOND)]);
    expect(result.counts).toEqual({ ...zero, messages: 1, apart: 1 });
    expect(sentFails(result.counts)).toBe(false);
    expect(result.gaps.map((gap) => [gap.key, gap.class, gap.match, gap.difference])).toEqual([[NEW.key, "apart", "id", 0]]);
  });

  it("censors a message after the censor time with no copy at its sent time", () => {
    const result = sentMeasure([...api(), ...ipawsReport(NEW.ipaws, NEW.sent + 40 * SECOND)], { censorAfter: EXT.sent - SECOND });
    expect(result.counts).toEqual({ ...zero, messages: 2, same: 1, censored: 1 });
    expect(sentFails(result.counts)).toBe(false);
    expect(result.gaps).toEqual([]);
  });

  it("counts a message after the censor time with its copy as same", () => {
    const reports = [...api(), ...ipawsReport(NEW.ipaws, NEW.sent + 40 * SECOND), ...ipawsReport(EXT.ipaws, EXT.sent + 40 * SECOND)];
    expect(sentMeasure(reports, { censorAfter: NEW.sent - SECOND }).counts).toEqual({ ...zero, messages: 2, same: 2 });
  });

  it("gives the same result for each order of the reports", () => {
    const reports = [...api(), ...ipawsReport(shifted(EXT, SECOND), EXT.sent + 40 * SECOND), ...ipawsReport(NEW.ipaws, NEW.sent + 40 * SECOND)];
    expect(sentMeasure([...reports].reverse())).toEqual(sentMeasure(reports));
  });
});

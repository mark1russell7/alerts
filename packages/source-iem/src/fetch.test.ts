import { readFileSync } from "node:fs";
import type { FetchOutcome, PlaceId, Watch, WatchedPlace } from "@mark1russell7/alerts";
import fc from "fast-check";
import type { Exchange, Reply, Transport } from "polite-crawler/api";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import { createIemFetch, isListRow, keepsRow, LIST_PATH, listTime, readAnswer, rowBody } from "./fetch.ts";
import { ROW_FIELDS } from "./map.ts";

const fixture = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");
/** The real lists of IEM, cut to the rows of TX and KS. */
const LIST = fixture("../fixtures/county-zone-20261115T1320Z.json");
const LIST_0108 = fixture("../fixtures/county-zone-20261108T1930Z.json");
const rowsOf = (list: string): Record<string, unknown>[] => (JSON.parse(list) as { data: Record<string, unknown>[] }).data;
/** This function gives a list with the rows, in the envelope of the real list. */
const listOf = (rows: readonly unknown[]): string => JSON.stringify({ ...(JSON.parse(LIST) as object), data: rows });

/** A place of the tests. The codes are public regions, not the places of an owner. */
const place = (id: string, codes: WatchedPlace["codes"]): WatchedPlace => ({ id: id as PlaceId, codes, bufferKm: 0 });
const KANSAS: Watch = { places: [place("a", [{ system: "ugc", code: "KSZ083" }])] };

const BASE = "https://iem.test/api/1";
const URL_OF_LIST = `${BASE}${LIST_PATH}`;
const START = Date.parse("2026-11-15T13:20:00.400Z");
const json = (body: string, status = 200): Reply => ({ status, statusText: status === 200 ? "OK" : "Error", headers: { "content-type": "application/json" }, body });

/** This function makes a fetch whose transport gives the replies in turn, and then the last reply again. */
const fetchWith = (replies: readonly Reply[]) => {
  const sent: Exchange[] = [];
  let index = 0;
  const transport: Transport = async (exchange) => {
    sent.push(exchange);
    const reply = replies[Math.min(index++, replies.length - 1)];
    if (reply === undefined) throw new Error("no reply");
    return reply;
  };
  let time = START;
  const clock = { now: () => time, sleep: async (ms: number) => void (time += ms) };
  const fetch = createIemFetch({ pace: { scheduler: new HostScheduler(clock, 1), now: clock.now }, transport, userAgent: "alerts-tests", baseUrl: `${BASE}/`, minIntervalMs: 0, timeoutMs: 1000 });
  return { fetch, sent };
};
const failureOf = (outcome: FetchOutcome): unknown => (outcome.ok ? undefined : outcome.failure);

describe("rowBody and isListRow", () => {
  it("keeps the fields of ROW_FIELDS in their order, and no other field", () => {
    const [row] = rowsOf(LIST);
    expect(Object.keys(JSON.parse(rowBody(row)) as object)).toEqual([...ROW_FIELDS]);
    expect(rowBody({ ...row, index: 1, nws_color: "#000000" })).toBe(rowBody({ ...row, index: 2 }));
    expect(rowBody({ ugc: "TXC019", wfo: "EWX" })).toBe(JSON.stringify({ wfo: "EWX", ugc: "TXC019" }));
    expect(rowBody([1])).toBe("[1]");
  });

  it("accepts each real row, and refuses a row with a field that is absent or of a different type", () => {
    for (const row of [...rowsOf(LIST), ...rowsOf(LIST_0108)]) expect(isListRow(row)).toBe(true);
    const [row] = rowsOf(LIST);
    expect(isListRow({ ...row, utc_expire: null })).toBe(true);
    for (const field of ROW_FIELDS) {
      const { [field]: _removed, ...rest } = row ?? {};
      expect(isListRow(rest)).toBe(false);
      expect(isListRow({ ...row, [field]: field === "eventid" ? "108" : 108 })).toBe(false);
    }
    expect(isListRow(null)).toBe(false);
    expect(isListRow([row])).toBe(false);
  });
});

describe("listTime", () => {
  it("gives the newest product time, and skips a row with no time that parses", () => {
    const rows = [{ utc_product_issue: "2026-11-15T13:00:00Z" }, { utc_product_issue: "2026-11-15T13:05:00Z" }, { utc_product_issue: "later" }, null, 7];
    expect(listTime(rows)).toBe(Date.parse("2026-11-15T13:05:00Z"));
    expect(listTime([{ utc_product_issue: "later" }])).toBeUndefined();
    expect(listTime([])).toBeUndefined();
  });
});

describe("keepsRow", () => {
  it("keeps a row of a watched state, a row with no state, and a row with no UGC text", () => {
    const states = new Set(["KS"]);
    expect(keepsRow({ ugc: "KSZ083" }, states)).toBe(true);
    expect(keepsRow({ ugc: "TXC019" }, states)).toBe(false);
    expect(keepsRow({ ugc: "GMZ250" }, states)).toBe(true);
    expect(keepsRow({ ugc: 7 }, states)).toBe(true);
    expect(keepsRow("text", states)).toBe(true);
    expect(keepsRow({ ugc: "TXC019" }, undefined)).toBe(true);
  });
});

describe("readAnswer", () => {
  it("gives one observation for each row that the states keep, and a complete list", () => {
    const all = readAnswer(json(LIST), URL_OF_LIST, START, 40, undefined);
    expect(all?.complete).toBe(true);
    expect(all?.observations).toHaveLength(rowsOf(LIST).length);
    const kansas = readAnswer(json(LIST), URL_OF_LIST, START, 40, new Set(["KS"]));
    expect(kansas?.complete).toBe(true);
    expect(kansas?.observations.length).toBe(rowsOf(LIST).filter((row) => String(row["ugc"]).startsWith("KS")).length);
    expect(kansas?.observations.length).toBeGreaterThan(0);
  });

  it("gives the same observation for the same row in two answers, at two times", () => {
    const one = readAnswer(json(LIST), URL_OF_LIST, START, 40, undefined)?.observations ?? [];
    const shifted = rowsOf(LIST).map((row, index) => ({ ...row, index: index + 500 }));
    const two = readAnswer(json(listOf(shifted)), URL_OF_LIST, START + 120_000, 55, undefined)?.observations ?? [];
    expect(two.map((observation) => observation.id)).toEqual(one.map((observation) => observation.id));
  });

  it("gives the time of the newest product of each row of the list, also when the states keep no row", () => {
    const newest = Math.max(...rowsOf(LIST).map((row) => Date.parse(String(row["utc_product_issue"]))));
    expect(newest).toBeLessThanOrEqual(START);
    expect(readAnswer(json(LIST), URL_OF_LIST, START, 40, undefined)?.asOf).toBe(newest);
    const none = readAnswer(json(LIST), URL_OF_LIST, START, 40, new Set(["WY"]));
    expect(none).toMatchObject({ observations: [], complete: true, asOf: newest });
  });

  it("gives no time for a list that is not complete", () => {
    const renamed = rowsOf(LIST).map(({ ugc, ...row }) => ({ ...row, ugc_code: ugc }));
    expect(readAnswer(json(listOf(renamed)), URL_OF_LIST, START, 40, undefined)?.asOf).toBeUndefined();
  });

  it("gives no complete list for a list with no row, or with a row of a different structure", () => {
    expect(readAnswer(json(listOf([])), URL_OF_LIST, START, 40, undefined)).toMatchObject({ observations: [], complete: false });
    const renamed = rowsOf(LIST).map(({ ugc, ...row }) => ({ ...row, ugc_code: ugc }));
    expect(readAnswer(json(listOf(renamed)), URL_OF_LIST, START, 40, undefined)?.complete).toBe(false);
    const one = rowsOf(LIST).map((row, index) => (index === 3 ? { ...row, eventid: String(row["eventid"]) } : row));
    expect(readAnswer(json(listOf(one)), URL_OF_LIST, START, 40, undefined)?.complete).toBe(false);
  });

  it("gives one observation of the whole body, and no complete list, for JSON that is not the list", () => {
    const body = JSON.stringify({ detail: "Internal error" });
    const read = readAnswer(json(body), URL_OF_LIST, START, 40, undefined);
    expect(read?.complete).toBe(false);
    expect(read?.observations.map((observation) => observation.body)).toEqual([body]);
  });

  it("gives no read for each cut of the body", () => {
    const body = LIST.trimEnd();
    fc.assert(
      fc.property(fc.integer({ min: 0, max: body.length - 1 }), (end) => {
        expect(readAnswer(json(body.slice(0, end)), URL_OF_LIST, START, 40, undefined)).toBeUndefined();
      }),
    );
  });
});

describe("createIemFetch", () => {
  it("asks for the national list with no filter, and keeps the rows of the watched states", async () => {
    const { fetch, sent } = fetchWith([json(LIST)]);
    const outcome = await fetch({ watch: KANSAS });
    expect(sent.map((exchange) => exchange.url)).toEqual([URL_OF_LIST]);
    expect(sent[0]?.headers).toMatchObject({ accept: "application/json", "user-agent": "alerts-tests" });
    expect(outcome.ok && outcome.complete).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.cursor).toBeUndefined();
    expect(outcome.observations.length).toBeGreaterThan(0);
    for (const observation of outcome.observations) expect(observation.body).toContain('"ugc":"KS');
  });

  it("fails for a cut body and for an answer that is not 2xx", async () => {
    const cut = await fetchWith([json(LIST.slice(0, 500))]).fetch({ watch: KANSAS });
    expect(failureOf(cut)).toMatchObject({ kind: "network", message: expect.stringContaining("truncated") as string });
    const down = await fetchWith([json("{}", 503)]).fetch({ watch: KANSAS });
    expect(down.ok).toBe(false);
  });
});

import { addHistory, HISTORY_FORMAT, NO_HISTORIES, type HistoryPayload } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { HISTORY_PATH, historyPath, OTHER_FORMAT_TEXT, readHistories, readHistory, WHOLE_READ_EVERY_MS } from "./history-read.ts";
import { ANCHORS, HISTORY_FIXTURE } from "./map-view.fixture.ts";

const answer = (body: string, status = 200) => async (): Promise<Response> => new Response(body, { status, headers: { "content-type": "application/json" } });
const EMPTY: HistoryPayload = { format: HISTORY_FORMAT, at: null, since: null, next: null, incidents: [], regions: [] };
const SOURCE = "The time scrubber reads the history from the alert runtime on this computer.";

describe("the read of the history", () => {
  it("reads only the path /history, with no host, and gives the time of the last read as the query since", async () => {
    const asked: string[] = [];
    const get = async (path: string): Promise<Response> => {
      asked.push(path);
      return answer(JSON.stringify(EMPTY))();
    };
    expect(await readHistory(get, null)).toEqual({ ok: true, payload: EMPTY });
    expect(await readHistory(get, 1_763_157_600_000)).toEqual({ ok: true, payload: EMPTY });
    expect(HISTORY_PATH).toBe("/history");
    expect(asked).toEqual(["/history", "/history?since=1763157600000"]);
    expect(historyPath(0)).toBe("/history?since=0");
  });

  it("tells that a runtime of an older version has no history route, with no words of a failure", async () => {
    expect(await readHistory(answer("", 404), null)).toEqual({ ok: false, absent: true });
  });

  it("says in plain words that the runtime does not answer, or answers with a status", async () => {
    const down = await readHistory(async () => {
      throw new TypeError("Failed to fetch");
    }, null);
    expect(down).toEqual({ ok: false, absent: false, text: `${SOURCE} The runtime does not answer.` });
    expect(await readHistory(answer("", 503), null)).toEqual({ ok: false, absent: false, text: `${SOURCE} The runtime answers with the status 503.` });
    // The runtime refuses a bad query with the status 400.
    expect(await readHistory(answer('{"problem":"The query since is one time."}', 400), null)).toMatchObject({ ok: false, absent: false, text: `${SOURCE} The runtime answers with the status 400.` });
  });

  it("tells a history of a different format to start the runtime of the version of the page", async () => {
    const result = await readHistory(answer(JSON.stringify({ ...EMPTY, format: "alerts-history/2" })), null);
    expect(result).toEqual({ ok: false, absent: false, text: OTHER_FORMAT_TEXT });
    expect(OTHER_FORMAT_TEXT).toBe(`${SOURCE} The runtime has a different version of the history. Start the runtime of the version of this page.`);
  });

  it("tells a text that is not JSON, and JSON that is not a history", async () => {
    expect(await readHistory(answer("<html>"), null)).toEqual({ ok: false, absent: false, text: `${SOURCE} The answer of the runtime is not JSON.` });
    const change = '{"at":1,"codes":[],"shapes":[],"places":[]}';
    const incident = (fields: string): string => `{"format":"${HISTORY_FORMAT}","at":null,"since":null,"next":null,"regions":[],"incidents":[${fields}]}`;
    const bodies = [
      "null",
      "[]",
      `{"format":"${HISTORY_FORMAT}"}`,
      `{"format":"${HISTORY_FORMAT}","at":null,"since":null,"next":"1","incidents":[],"regions":[]}`,
      `{"format":"${HISTORY_FORMAT}","at":null,"since":null,"next":null,"incidents":[]}`,
      `{"format":"${HISTORY_FORMAT}","at":null,"since":null,"next":null,"incidents":[],"regions":[{"code":"KSZ083","shapes":[]}]}`,
      incident('{"anchor":1,"reports":[],"changes":[]}'),
      incident('{"anchor":"a","reports":[]}'),
      incident('{"anchor":"a","reports":[],"changes":[{"codes":[],"shapes":[]}]}'),
      incident('{"anchor":"a","reports":[],"changes":[{"at":1,"codes":[]}]}'),
      // A runtime before the places of a change gives a change with no list of places.
      incident('{"anchor":"a","reports":[],"changes":[{"at":1,"codes":[],"shapes":[]}]}'),
    ];
    for (const body of bodies) {
      expect(await readHistory(answer(body), null), body).toEqual({ ok: false, absent: false, text: `${SOURCE} The answer of the runtime is not a history.` });
    }
    // The flip: an incident with each field of the outside is a history.
    expect(await readHistory(answer(incident(`{"anchor":"a","reports":["a"],"changes":[${change}]}`)), null)).toMatchObject({ ok: true });
  });
});

describe("the reads of one refresh", () => {
  const NEXT = HISTORY_FIXTURE.next ?? 0;
  const KEPT = addHistory(NO_HISTORIES, HISTORY_FIXTURE);
  /** A fake runtime: it gives the answers in their order, and it keeps each path of a request. */
  const runtime = (...answers: readonly (HistoryPayload | number)[]) => {
    const asked: string[] = [];
    let index = 0;
    const get = async (path: string): Promise<Response> => {
      asked.push(path);
      const next = answers[index++];
      return typeof next === "number" || next === undefined ? new Response("", { status: next ?? 500 }) : new Response(JSON.stringify(next));
    };
    return { asked, get };
  };
  /** An answer to a read with `since`: the tornado warning has one change more, at 20:10 UTC. */
  const newer = (since: number, next: number): HistoryPayload => {
    const tornado = HISTORY_FIXTURE.incidents.filter((incident) => incident.anchor === ANCHORS.tornado);
    return { ...HISTORY_FIXTURE, since, next, incidents: tornado.map((incident) => ({ ...incident, changes: [...incident.changes, ...incident.changes.slice(-1).map((change) => ({ ...change, at: next }))] })), regions: [] };
  };

  it("reads the whole history first, and then only the changes since the newest change", async () => {
    const { asked, get } = runtime(HISTORY_FIXTURE, newer(NEXT, NEXT + 1_500_000));
    const first = await readHistories(get, NO_HISTORIES);
    expect(first).toEqual({ kept: KEPT, absent: false });
    expect(first.kept.since).toBe(NEXT);
    const second = await readHistories(get, first.kept);
    expect(asked).toEqual(["/history", `/history?since=${String(NEXT)}`]);
    // The answer has one incident. The histories keep the six other incidents, and the tornado warning has three changes.
    expect(second.kept.incidents).toHaveLength(7);
    expect(second.kept.incidents.find((incident) => incident.anchor === ANCHORS.tornado)?.changes).toHaveLength(3);
    expect(second.kept.since).toBe(NEXT + 1_500_000);
    expect(second.kept.regions).toEqual(KEPT.regions);
  });

  it("reads the whole history again when the page asks for it", async () => {
    const { asked, get } = runtime(HISTORY_FIXTURE);
    expect(await readHistories(get, KEPT, true)).toEqual({ kept: KEPT, absent: false });
    expect(asked).toEqual(["/history"]);
    expect(WHOLE_READ_EVERY_MS).toBe(600_000);
  });

  it("reads the whole history one time more after a step of the clock of the runtime", async () => {
    // The newest change of the answer is before the query. So the times of the kept histories are not correct.
    const { asked, get } = runtime(newer(NEXT, NEXT - 60_000), HISTORY_FIXTURE);
    expect(await readHistories(get, KEPT)).toEqual({ kept: KEPT, absent: false });
    expect(asked).toEqual([`/history?since=${String(NEXT)}`, "/history"]);
  });

  it("drops the histories when the runtime has no history route", async () => {
    expect(await readHistories(runtime(404).get, KEPT)).toEqual({ kept: NO_HISTORIES, absent: true });
  });

  it("keeps the histories after a failed read, and gives the words of the failure", async () => {
    const failed = await readHistories(runtime(503).get, KEPT);
    expect(failed.kept).toBe(KEPT);
    expect(failed).toMatchObject({ absent: false, text: "The time scrubber reads the history from the alert runtime on this computer. The runtime answers with the status 503." });
    // The second read of a refresh can also fail. The histories of the first read stay.
    const half = await readHistories(runtime(newer(NEXT, NEXT - 60_000), 503).get, KEPT);
    expect(half.kept.since).toBeNull();
    expect(half.kept.incidents).toHaveLength(7);
    expect(half.text).toContain("status 503");
  });
});

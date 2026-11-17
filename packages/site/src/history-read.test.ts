import { HISTORY_FORMAT, type HistoryPayload } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { HISTORY_PATH, historyPath, OTHER_FORMAT_TEXT, readHistory } from "./history-read.ts";

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
    const change = '{"at":1,"codes":[],"shapes":[]}';
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
    ];
    for (const body of bodies) {
      expect(await readHistory(answer(body), null), body).toEqual({ ok: false, absent: false, text: `${SOURCE} The answer of the runtime is not a history.` });
    }
    // The flip: an incident with each field of the outside is a history.
    expect(await readHistory(answer(incident(`{"anchor":"a","reports":["a"],"changes":[${change}]}`)), null)).toMatchObject({ ok: true });
  });
});

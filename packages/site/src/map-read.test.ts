import { describe, expect, it } from "vitest";
import { MAP_PATH, NO_ANSWER_TEXT, readLine, readMap } from "./map-read.ts";
import { MAP_FIXTURE } from "./map-view.fixture.ts";

const answer = (body: string, status = 200) => async (): Promise<Response> => new Response(body, { status, headers: { "content-type": "application/json" } });

describe("the read of the map", () => {
  it("reads only the path /map, with no host", async () => {
    const asked: string[] = [];
    const result = await readMap(async (path) => {
      asked.push(path);
      return answer(JSON.stringify(MAP_FIXTURE))();
    });
    expect(MAP_PATH).toBe("/map");
    expect(asked).toEqual(["/map"]);
    expect(result).toEqual({ ok: true, payload: MAP_FIXTURE });
  });

  it("says in plain words that the runtime on this computer does not answer", async () => {
    const result = await readMap(async () => {
      throw new TypeError("Failed to fetch");
    });
    expect(result).toEqual({ ok: false, text: NO_ANSWER_TEXT });
    expect(NO_ANSWER_TEXT).toBe(
      "This page reads the alert runtime on this computer. The runtime does not answer. Start the runtime. The page reads it again every 30 seconds.",
    );
  });

  it("tells the status, a text that is not JSON and JSON that is not a map or has a bad region", async () => {
    expect(await readMap(answer("", 503))).toEqual({ ok: false, text: "This page reads the alert runtime on this computer. The runtime answers with the status 503." });
    expect(await readMap(answer("<html>"))).toEqual({ ok: false, text: "This page reads the alert runtime on this computer. The answer of the runtime is not JSON." });
    const view = '"view":{"incidents":[],"places":[],"unshaped":[]}';
    const regions = [
      '{"code":"KSZ083","name":"A","shapes":[]}',
      '{"code":{"code":"KSZ083"},"name":"A","shapes":[]}',
      '{"code":{"system":"ugc","code":83},"name":"A","shapes":[]}',
      '{"code":{"system":"ugc","code":"KSZ083"},"shapes":[]}',
      '{"code":{"system":"ugc","code":"KSZ083"},"name":"A","shapes":{}}',
    ];
    const bodies = ["null", "[]", '{"view":{}}', `{${view}}`, ...regions.map((region) => `{${view},"basemap":[${region}]}`)];
    for (const body of bodies) {
      expect(await readMap(answer(body))).toEqual({ ok: false, text: "This page reads the alert runtime on this computer. The answer of the runtime is not a map." });
    }
  });

  it("tells the time of the last good read, and keeps it after a failure", () => {
    const time = (at: number): string => new Date(at).toISOString().slice(11, 16);
    const at = Date.parse("2026-11-15T18:05:00Z");
    expect(readLine(undefined, false, time)).toBe("Reading the runtime.");
    expect(readLine(undefined, true, time)).toBe("No map yet.");
    expect(readLine(at, false, time)).toBe("Read at 18:05. The page reads again every 30 seconds.");
    expect(readLine(at, true, time)).toBe("The map shows the read of 18:05.");
  });
});

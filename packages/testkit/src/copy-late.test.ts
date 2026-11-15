import { carriages, incidents, normalize, type Observation, type ObservationId, type Report } from "@mark1russell7/alerts";
import { COPY_SUFFIX, FEED_PATH, mapObservation as mapIpaws, readAnswer as readFeed, SOURCE_ID as IPAWS_ID, WEA_EXPECTATION } from "@mark1russell7/alerts-source-ipaws";
import { mapObservation as mapNws, NWS_DESCRIPTOR, SOURCE_ID as NWS_ID, WEA_PATH } from "@mark1russell7/alerts-source-nws-api";
import { checkFaultPlan, faultPlanOf } from "@mark1russell7/rigor-chaos";
import type { Exchange, Reply, Transport } from "polite-crawler/api";
import { describe, expect, it } from "vitest";
import {
  answersOf,
  ARM_GATES,
  CASE_8_IPAWS,
  CASE_8_NWS,
  CASE_8_SETTINGS,
  COPY_ARMS,
  COPY_ROUTES,
  copyBodiesOf,
  copyFaultsOf,
  copyGatesOf,
  copyOf,
  type CopyPass,
  type CopyRecord,
  type CopyRoute,
  copySettingsProblems,
  copyTransport,
  copyVerdictOf,
  cstTime,
  EXT_FROM,
  extFetchOf,
  featureOf,
  LAG,
  latePeriodsOf,
  LIST_SPAN,
  messagesOf,
  PER_FETCH,
  readPair,
  routeOf,
  type RouteCounts,
  TELL_WITHIN,
  vtecOf,
  vtecTime,
  WINDOW,
  ZONE_PATH,
} from "./copy-late.ts";

const PAIR = readPair();
const SMALL = { ...CASE_8_SETTINGS, fetches: 4 };
const INTERVAL = NWS_DESCRIPTOR.interval;

const observe = (source: Observation["source"], body: string, contentType: string, fetched: number): Observation => ({
  id: `observation-${source}-${String(body.length)}` as ObservationId,
  source,
  fetched,
  contentType,
  body,
  transport: { latency: 0 },
});

const one = (result: { readonly reports: readonly Report[]; readonly problems: readonly { readonly fatal?: boolean }[] }): Report => {
  expect(result.problems.filter((problem) => problem.fatal === true)).toEqual([]);
  expect(result.reports).toHaveLength(1);
  return result.reports[0] as Report;
};

describe("the synthetic messages", () => {
  const messages = messagesOf(CASE_8_SETTINGS);

  it("gives PER_FETCH new messages in each fetch, each sent one interval before its fetch", () => {
    expect(messages).toHaveLength(CASE_8_SETTINGS.fetches * PER_FETCH);
    expect(new Set(messages.map((message) => message.id)).size).toBe(messages.length);
    expect(new Set(messages.map((message) => message.etn)).size).toBe(messages.length);
    for (const message of messages) {
      expect(message.fetch).toBe(Math.floor(message.index / PER_FETCH));
      expect(message.sent).toBe(CASE_8_SETTINGS.start + (message.fetch - 1) * INTERVAL);
      expect(message.expires - message.sent).toBe(10 * INTERVAL);
    }
  });

  it("draws the delay of each copy from the seed of the case, with each delay in both halves", () => {
    expect(messagesOf(CASE_8_SETTINGS).map((message) => message.delay)).toEqual(messages.map((message) => message.delay));
    const late = messages.filter((message) => message.delay === 1).length;
    expect(late).toBeGreaterThan(messages.length * 0.4);
    expect(late).toBeLessThan(messages.length * 0.6);
  });

  it("writes the times in the forms of the NWS and of VTEC", () => {
    const time = Date.parse("2026-11-09T00:19:00Z");
    expect(cstTime(time)).toBe("2026-11-08T18:19:00-06:00");
    expect(Date.parse(cstTime(time))).toBe(time);
    expect(vtecTime(time)).toBe("261109T0019Z");
    expect(vtecOf({ etn: 2001, sent: time, expires: time + 10 * INTERVAL })).toBe("/O.NEW.KEWX.FF.W.2001.261109T0019Z-261109T0029Z/");
  });

  it("maps the NWS message and its IPAWS copy to one incident, and the copy meets its check", () => {
    const message = messages[7];
    if (message === undefined) throw new Error("no message 7");
    const started = message.sent + 30_000;
    const api = one(mapNws(observe(NWS_ID, JSON.stringify(featureOf(message, PAIR.newFeature)), "application/geo+json", started)));
    const copy = one(mapIpaws(observe(IPAWS_ID, copyOf(message, PAIR.newCopy), "application/xml", started + 60_000)));
    expect(api.sent).toBe(message.sent);
    expect(copy.sent).toBe(message.sent);
    expect(copy.key).toBe(`${message.id}${COPY_SUFFIX}`);
    expect(api.parameters["WEAHandling"]).toEqual(["Imminent Threat"]);
    for (const report of [api, copy]) expect(report.areas.flatMap((area) => (area.type === "code" ? [area.code] : []))).toContain("TXC001");
    const state = normalize({ reports: [api, copy] });
    const found = incidents(state, started + 2 * INTERVAL);
    expect(found).toHaveLength(1);
    expect(carriages(state, found, [WEA_EXPECTATION])).toEqual([{ expectation: WEA_EXPECTATION.id, report: api.id, started, arrived: started + 60_000 }]);
  });

  it("gives each copy a different incident from the copy of another message", () => {
    const [a, b] = messages;
    if (a === undefined || b === undefined) throw new Error("no messages");
    const reports = [a, b].map((message) => one(mapIpaws(observe(IPAWS_ID, copyOf(message, PAIR.newCopy), "application/xml", message.sent + 1000))));
    expect(incidents(normalize({ reports }), b.sent + 2000)).toHaveLength(2);
  });
});

describe("the bodies of the case", () => {
  const bodies = copyBodiesOf(CASE_8_SETTINGS, PAIR);
  const messages = messagesOf(CASE_8_SETTINGS);
  const idsOf = (body: string): string[] => (JSON.parse(body) as { features: { properties: { id: string } }[] }).features.map((feature) => feature.properties.id);

  it("gives the NEW message in the zone list before EXT_FROM, and the EXT message from it", () => {
    const newId = (PAIR.newFeature["properties"] as { id: string }).id;
    const extId = (PAIR.extFeature["properties"] as { id: string }).id;
    expect(idsOf(bodies.zone[EXT_FROM - 1] ?? "")).toEqual([newId]);
    expect(idsOf(bodies.zone[EXT_FROM] ?? "")).toEqual([extId]);
  });

  it("gives the messages of LIST_SPAN fetches in the WEA list", () => {
    const fetch = 40;
    const expected = messages.filter((message) => message.fetch > fetch - LIST_SPAN && message.fetch <= fetch).map((message) => message.id);
    expect(idsOf(bodies.wea[fetch] ?? "")).toEqual(expected);
    expect(idsOf(bodies.wea[0] ?? "")).toHaveLength(PER_FETCH);
  });

  it("gives each copy in the feed of its first fetch and of the next fetch, and the feed reads as complete", () => {
    const fetch = 30;
    const feedUrl = `${CASE_8_IPAWS}${FEED_PATH}`;
    const reply = { status: 200, headers: { "content-type": "application/xml" }, body: bodies.feed[fetch] ?? "" } as unknown as Reply;
    const answer = readFeed(reply, `${feedUrl}/2026-11-09T00:00:00Z`, feedUrl, 0, 0, undefined);
    const expected = messages.filter((message) => [fetch - 1, fetch].includes(message.fetch + message.delay)).length;
    expect(answer?.complete).toBe(true);
    expect(answer?.observations).toHaveLength(expected);
  });

  it("gives the IPAWS copy of the EXT message in the feeds of EXT_FROM and the fetch after it", () => {
    const hasExt = (fetch: number): boolean => (bodies.feed[fetch] ?? "").includes(PAIR.extCopy);
    expect([EXT_FROM - 1, EXT_FROM, EXT_FROM + 1, EXT_FROM + 2].map(hasExt)).toEqual([false, true, true, false]);
  });

  it("gives a fresh keepalive in each canary body", () => {
    const sent = (body: Uint8Array | undefined): number =>
      Date.parse((JSON.parse(new TextDecoder().decode(body)) as { features: { properties: { sent: string } }[] }).features[0]?.properties.sent ?? "");
    expect(sent(bodies.canary[0])).toBe(CASE_8_SETTINGS.start);
    expect(sent(bodies.canary[50])).toBe(CASE_8_SETTINGS.start + 50 * INTERVAL);
  });
});

describe("the faults of each arm", () => {
  const bodies = copyBodiesOf(CASE_8_SETTINGS, PAIR);

  it("puts the faults of each arm in the window, on the routes of the arm", () => {
    for (const arm of COPY_ARMS) {
      const faults = copyFaultsOf(arm);
      const routes = COPY_ROUTES.filter((route) => faults[route].size > 0);
      expect(routes).toEqual({ control: [], "copy-stopped": ["feed"], "ipaws-lag": ["feed"], "nws-lag": ["zone", "wea"] }[arm]);
      for (const route of routes) expect([...faults[route].keys()]).toEqual(Array.from({ length: WINDOW.to - WINDOW.from }, (_, at) => WINDOW.from + at));
    }
    expect([...copyFaultsOf("ipaws-lag").feed.values()][0]).toBe(WINDOW.from - LAG);
    expect([...copyFaultsOf("copy-stopped").feed.values()][0]).toBe("empty");
  });

  it("gives a valid plan of answers for each route with faults", () => {
    for (const arm of COPY_ARMS) {
      const faults = copyFaultsOf(arm);
      for (const route of COPY_ROUTES) {
        const answers = answersOf(bodies, route, faults[route]);
        expect(answers).toHaveLength(faults[route].size);
        if (answers.length > 0) expect(checkFaultPlan(faultPlanOf(answers))).toEqual([]);
      }
    }
    expect(answersOf(bodies, "feed", copyFaultsOf("copy-stopped").feed)[0]?.body).toBe(PAIR.emptyFeed);
    expect(answersOf(bodies, "zone", copyFaultsOf("nws-lag").zone)[0]?.body).toBe(bodies.zone[WINDOW.from - LAG]);
  });

  it("gives the EXT message to the NWS list at EXT_FROM, and LAG fetches later in the arm nws-lag", () => {
    for (const arm of COPY_ARMS) expect(extFetchOf(arm, CASE_8_SETTINGS.fetches)).toBe(arm === "nws-lag" ? EXT_FROM + LAG : EXT_FROM);
  });

  it("has valid settings", () => {
    expect(copySettingsProblems(CASE_8_SETTINGS, PAIR)).toEqual([]);
    expect(copySettingsProblems({ ...CASE_8_SETTINGS, fetches: WINDOW.to }, PAIR)).toHaveLength(1);
    expect(copySettingsProblems({ ...CASE_8_SETTINGS, start: CASE_8_SETTINGS.start + INTERVAL }, PAIR).join("\n")).toContain("The EXT message is not sent");
  });
});

describe("the transport of the case", () => {
  const recorder = (): { readonly inner: Transport; readonly urls: string[] } => {
    const urls: string[] = [];
    const inner: Transport = (exchange: Exchange) => {
      urls.push(exchange.url);
      return Promise.resolve({ status: 200, headers: {}, body: "" } as unknown as Reply);
    };
    return { inner, urls };
  };
  const zero = (): Record<CopyRoute, RouteCounts> => ({ zone: { direct: 0, proxied: 0 }, wea: { direct: 0, proxied: 0 }, canary: { direct: 0, proxied: 0 }, feed: { direct: 0, proxied: 0 } });
  const none = new Set<number>();

  it("knows each route of the sources, and no other address", () => {
    expect(routeOf(new URL(`${CASE_8_NWS}${ZONE_PATH}`))).toBe("zone");
    expect(routeOf(new URL(`${CASE_8_NWS}${WEA_PATH}`))).toBe("wea");
    expect(routeOf(new URL(`${CASE_8_IPAWS}${FEED_PATH}/2026-11-09T00:00:00Z`))).toBe("feed");
    expect(routeOf(new URL(`${CASE_8_NWS}/alerts/active?area=KS`))).toBeUndefined();
    expect(routeOf(new URL(`https://api.weather.gov${ZONE_PATH}`))).toBeUndefined();
  });

  it("sends each request with a fault to the proxy of its route, and the feed with no time", async () => {
    const { inner, urls } = recorder();
    const counts = zero();
    const transport = copyTransport({ inner, direct: "http://server", proxies: { feed: "http://proxy" }, faulted: { zone: none, wea: none, canary: none, feed: new Set([1]) }, counts });
    for (let at = 0; at < 3; at += 1) await transport({ method: "GET", url: `${CASE_8_IPAWS}${FEED_PATH}/2026-11-09T00:0${String(at)}:00Z`, headers: {} } as unknown as Exchange);
    await transport({ method: "GET", url: `${CASE_8_NWS}${ZONE_PATH}`, headers: {} } as unknown as Exchange);
    expect(urls).toEqual([`http://server${FEED_PATH}`, `http://proxy${FEED_PATH}`, `http://server${FEED_PATH}`, `http://server${ZONE_PATH}`]);
    expect(counts.feed).toEqual({ direct: 2, proxied: 1 });
    expect(counts.zone).toEqual({ direct: 1, proxied: 0 });
    await expect(transport({ method: "GET", url: "http://other.test/", headers: {} } as unknown as Exchange)).rejects.toThrow(TypeError);
  });
});

/** This function gives a pass with a threat at each place, and a lateness state. */
const passAt = (minute: number, nws: number, state: CopyPass["state"], dropped = 1): CopyPass => ({
  at: minute * INTERVAL,
  nws,
  ipaws: nws,
  threats: { kept: 1, dropped },
  state,
  limit: 61_000,
  misses: 1,
  missed: state === "late" ? 1 : 0,
});

/** This function gives the passes of an arm: one pass at each fetch, `met` but in the late fetches, and the EXT message at its fetch. */
const passesOf = (arm: (typeof COPY_ARMS)[number], late: (fetch: number) => boolean): CopyPass[] => {
  const ext = extFetchOf(arm, CASE_8_SETTINGS.fetches);
  return Array.from({ length: CASE_8_SETTINGS.fetches }, (_, fetch) => passAt(fetch, fetch + 1, late(fetch) ? "late" : "met", fetch < ext ? 1 : 0));
};

describe("the gates", () => {
  it("passes the control with no late state, and with a short late period", () => {
    expect(copyGatesOf({ arm: "control", passes: passesOf("control", () => false) }).gates).toEqual({ noFalseClear: true, oneIncident: true, settles: true, clears: true, noLongLate: true });
    const short = [passAt(10, 11, "met"), { ...passAt(10, 11, "late"), at: 10 * INTERVAL + 1000 }, { ...passAt(10, 11, "met"), at: 10 * INTERVAL + 3000 }];
    expect(latePeriodsOf(short)).toEqual([{ from: 10 * INTERVAL + 1000, to: 10 * INTERVAL + 3000, nws: 11 }]);
    expect(copyGatesOf({ arm: "control", passes: [...short, ...passesOf("control", () => false).slice(11)] }).gates.noLongLate).toBe(true);
  });

  it("fails noLongLate for a late period of two fetches, and for a late period at the end", () => {
    expect(copyGatesOf({ arm: "nws-lag", passes: passesOf("nws-lag", (fetch) => fetch === 50 || fetch === 51) }).gates.noLongLate).toBe(false);
    expect(copyGatesOf({ arm: "control", passes: passesOf("control", (fetch) => fetch === CASE_8_SETTINGS.fetches - 1) }).gates).toMatchObject({ noLongLate: false, clears: false });
  });

  it("passes tellsStop for a late state in TELL_WITHIN fetches of the window, and fails it after", () => {
    const told = copyGatesOf({ arm: "copy-stopped", passes: passesOf("copy-stopped", (fetch) => fetch >= WINDOW.from + 1 && fetch < WINDOW.to + 1) });
    expect(told.gates).toEqual({ noFalseClear: true, oneIncident: true, settles: true, clears: true, tellsStop: true });
    expect(told.toldAt).toBe(WINDOW.from + 2);
    const slow = copyGatesOf({ arm: "ipaws-lag", passes: passesOf("ipaws-lag", (fetch) => fetch >= WINDOW.from + TELL_WITHIN && fetch < WINDOW.to) });
    expect(slow.gates.tellsStop).toBe(false);
    expect(copyGatesOf({ arm: "ipaws-lag", passes: passesOf("ipaws-lag", () => false) }).gates.tellsStop).toBe(false);
  });

  it("fails noFalseClear when a place loses its threat too early, and oneIncident for two threats at one place", () => {
    const passes = passesOf("nws-lag", () => false);
    const early = passes.map((pass, fetch) => (fetch === EXT_FROM ? { ...pass, threats: { kept: 1, dropped: 0 } } : pass));
    expect(copyGatesOf({ arm: "nws-lag", passes: early }).falseClears).toEqual([EXT_FROM * INTERVAL]);
    const double = passes.map((pass, fetch) => (fetch === 3 ? { ...pass, threats: { kept: 2, dropped: 1 } } : pass));
    expect(copyGatesOf({ arm: "nws-lag", passes: double }).gates.oneIncident).toBe(false);
  });

  it("gives the gates of each arm", () => {
    expect(ARM_GATES["copy-stopped"]).toContain("tellsStop");
    expect(ARM_GATES.control).toContain("noLongLate");
  });
});

describe("the verdict", () => {
  const record = (arm: (typeof COPY_ARMS)[number]): CopyRecord => {
    const faults = copyFaultsOf(arm);
    const fetches = Array.from({ length: CASE_8_SETTINGS.fetches }, (_, fetch) => ({ at: fetch * INTERVAL, ok: true, complete: true, observations: 1 }));
    const requests = Object.fromEntries(
      COPY_ROUTES.map((route) => [route, { direct: CASE_8_SETTINGS.fetches - faults[route].size, proxied: faults[route].size }]),
    ) as Record<CopyRoute, RouteCounts>;
    const recorded = Object.fromEntries(COPY_ROUTES.map((route) => [route, faults[route].size])) as Record<CopyRoute, number>;
    const served = COPY_ROUTES.reduce((sum, route) => sum + requests[route].direct, 0);
    const late = arm === "copy-stopped" || arm === "ipaws-lag" ? (fetch: number) => fetch > WINDOW.from && fetch < WINDOW.to : () => false;
    return { arm, passes: passesOf(arm, late), fetches: { nws: fetches, ipaws: fetches }, requests, faults: recorded, served, leaked: 0 };
  };

  it("reads and passes a run whose records meet the plan", () => {
    const verdict = copyVerdictOf(COPY_ARMS.map(record), CASE_8_SETTINGS, PAIR);
    expect(verdict.problems).toEqual([]);
    expect(verdict.read).toBe(true);
    expect(verdict.pass).toBe(true);
  });

  it("does not read a run with a missing arm, a leak or no limit before the window", () => {
    const records = COPY_ARMS.map(record);
    expect(copyVerdictOf(records.slice(1), CASE_8_SETTINGS, PAIR).problems.join("\n")).toContain("control: 0 records, not 1.");
    const leaked = records.map((one) => (one.arm === "copy-stopped" ? { ...one, leaked: 1 } : one));
    expect(copyVerdictOf(leaked, CASE_8_SETTINGS, PAIR).read).toBe(false);
    const bare = (pass: CopyPass): CopyPass => ({ at: pass.at, nws: pass.nws, ipaws: pass.ipaws, threats: pass.threats, state: pass.state, missed: pass.missed });
    const noLimit = records.map((one) => (one.arm === "control" ? { ...one, passes: one.passes.map(bare) } : one));
    const verdict = copyVerdictOf(noLimit, CASE_8_SETTINGS, PAIR);
    expect(verdict.read).toBe(false);
    expect(verdict.pass).toBe(false);
    expect(verdict.problems.join("\n")).toContain("control: the lateness has no limit of the delay before the window.");
  });

  it("does not read a run of too few fetches", () => {
    expect(copySettingsProblems(SMALL, PAIR).length).toBeGreaterThan(0);
  });
});

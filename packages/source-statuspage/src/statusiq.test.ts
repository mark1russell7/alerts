import { readFileSync } from "node:fs";
import type { FetchOutcome, Observation, ObservationId, PlaceId, Watch } from "@mark1russell7/alerts";
import type { Exchange, Reply, Transport } from "polite-crawler/api";
import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import { createStatusPageFetch, pagePath, SUMMARY_PATH } from "./fetch.ts";
import { mapObservation } from "./map.ts";
import { PUSHOVER_KEYS, registeredPage } from "./register.ts";
import { COMPONENT_ITEM_FIELDS, componentOf, readComponents, SEVERITY_OF_STATUSIQ, STATUSIQ_PATH } from "./statusiq.ts";

/** The real feed of the status page of Pushover, with each component `Operational` (`fixtures/README.md`). */
const FEED = readFileSync(new URL("../fixtures/pushover-20261118.xml", import.meta.url), "utf8");
const PAGE = registeredPage("statuspage-pushover")!;
const FETCHED = Date.parse("2026-11-18T13:40:00Z");
const PREFIX = "Xt5Xa7RUGZkb8L55acKKAdKJSFNX3IWXJvaVT3vKiI";
const QUEUE = `${PREFIX}eFeuT8A-avC5Z0nJZirwB6`;
const DASHBOARD = `${PREFIX}eHAsAEG5-V_cYfxEZMDpXV`;
const LINK = "https://status.pushover.net#/components/";

/** A place of the tests. The request holds no place, so the fetch reads no code and no position of a place. */
const WATCH: Watch = { places: [{ id: "a" as PlaceId, codes: [{ system: "iso3166", code: "NO" }], at: [18.96, 69.65], bufferKm: 0 }] };

/**
 * This function makes a variant of the real feed for a test: the item of the component `name` gets the status `status`
 * and the time `time`. The real feed of 2026-11-18 had no outage.
 */
function withStatus(feed: string, name: string, status: string, time: string): string {
  const title = `<title>${name} - Operational</title>`;
  const items = feed.split("<item>");
  const at = items.findIndex((item) => item.startsWith(title));
  if (at < 1) throw new Error(`the feed has no item of ${name}`);
  items[at] = items[at]!.replace(title, () => `<title>${name} - ${status}</title>`).replace(/<pubDate>[^<]*<\/pubDate>/, () => `<pubDate>${time}</pubDate>`);
  return items.join("<item>");
}

const MAJOR = withStatus(FEED, "Outbound Message Queue", "Major Outage", "Wed, 18 Nov 2026 07:30:00 -0600");
const observationOf = (body: string): Observation => ({ id: `o-${body.length}` as ObservationId, source: PAGE.id, fetched: FETCHED, contentType: "application/json", body, transport: { latency: 0 } });
const componentBody = (feed: string, index = 0): string => readComponents(feed)!.incidents[index]!;

describe("readComponents", () => {
  it("lists no component of the real feed, where each component is operational, with the newest change as the time of the data", () => {
    const read = readComponents(FEED)!;
    expect(read.head).toBe(JSON.stringify({ feed: { title: "Pushover Status - Status" } }));
    expect(read.incidents).toEqual([]);
    expect(read.complete).toBe(true);
    expect(read.asOf).toBe(Date.parse("2026-11-01T14:36:00Z"));
  });

  it("lists each component with an outage, with its fields in one order, and leaves out a maintenance", () => {
    const read = readComponents(withStatus(MAJOR, "Dashboard", "Under Maintenance", "Wed, 18 Nov 2026 07:00:00 -0600"))!;
    expect(read.incidents).toHaveLength(1);
    const component = JSON.parse(read.incidents[0]!) as Record<string, unknown>;
    expect(Object.keys(component)).toEqual([...COMPONENT_ITEM_FIELDS]);
    expect(component).toEqual({ id: QUEUE, name: "Outbound Message Queue", status: "Major Outage", since: "Wed, 18 Nov 2026 07:30:00 -0600", link: `${LINK}${QUEUE}` });
    expect(read.complete).toBe(true);
    expect(read.asOf).toBe(Date.parse("2026-11-18T13:30:00Z"));
  });

  it("is not complete when an item has no id of a component, and keeps that item in the list", () => {
    const read = readComponents(MAJOR.replace(`<link>${LINK}${QUEUE}</link>`, () => "<link>https://status.pushover.net</link>"))!;
    expect(read.complete).toBe(false);
    expect(read.incidents.map((body) => JSON.parse(body) as Record<string, unknown>)).toEqual([{ name: "Outbound Message Queue", status: "Major Outage", since: "Wed, 18 Nov 2026 07:30:00 -0600", link: "https://status.pushover.net" }]);
  });

  it("gives a head with the whole document for a document that is not a feed, and undefined for a cut feed", () => {
    const page = "<html><body>moved</body></html>";
    expect(readComponents(page)).toEqual({ head: JSON.stringify({ document: page }), incidents: [], complete: false });
    expect(readComponents(FEED.slice(0, 1000))).toBeUndefined();
  });
});

describe("componentOf", () => {
  it("divides the title at its last hyphen, so a name with a hyphen stays whole", () => {
    expect(componentOf({ title: "API - EU - Partial Outage", link: `${LINK}abc_1-2`, updated: "Wed, 18 Nov 2026 07:30:00 -0600" })).toEqual({ id: "abc_1-2", name: "API - EU", status: "Partial Outage", since: "Wed, 18 Nov 2026 07:30:00 -0600", link: `${LINK}abc_1-2` });
  });

  it("gives no name and no status for a title with no hyphen, and no id for a link with no component", () => {
    expect(componentOf({ title: "Dashboard", link: "https://status.pushover.net" })).toEqual({ link: "https://status.pushover.net" });
  });
});

describe("the map of a page of StatusIQ", () => {
  it("maps a component with an outage to one report, with the endpoint of its key as a subject", () => {
    const { reports, problems } = mapObservation(observationOf(componentBody(MAJOR)), PAGE);
    expect(problems).toEqual([]);
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({
      source: "statuspage-pushover",
      origin: "pushover",
      key: QUEUE,
      op: "alert",
      status: "actual",
      kind: { code: "infra.saas.outage" },
      severity: "severe",
      urgency: "immediate",
      certainty: "observed",
      sent: Date.parse("2026-11-18T13:30:00Z"),
      effective: Date.parse("2026-11-18T13:30:00Z"),
      received: FETCHED,
      areas: [],
      sender: "The status page of Pushover",
      headline: "Pushover: Outbound Message Queue: Major Outage",
      web: `${LINK}${QUEUE}`,
      parameters: { status: ["Major Outage"], component: ["Outbound Message Queue"], page: ["https://status.pushover.net"] },
    });
    expect(reports[0]!.about.map((subject) => subject.id)).toEqual(["pushover.net", "api.pushover.net"]);
    expect(reports[0]!.about[1]!.label).toBe("Pushover: Outbound Message Queue");
  });

  it("names only the domain of the service for a component with no key", () => {
    const dashboard = withStatus(FEED, "Dashboard", "Degraded Performance", "Wed, 18 Nov 2026 07:30:00 -0600");
    const report = mapObservation(observationOf(componentBody(dashboard)), PAGE).reports[0]!;
    expect(report.key).toBe(DASHBOARD);
    expect(report.severity).toBe("minor");
    expect(report.about.map((subject) => subject.id)).toEqual(["pushover.net"]);
  });

  it("gives each status of an outage its severity, and a status that it does not know the severity unknown with a problem", () => {
    for (const [status, severity] of Object.entries(SEVERITY_OF_STATUSIQ)) {
      const feed = withStatus(FEED, "US West (A)", status, "Wed, 18 Nov 2026 07:30:00 -0600");
      expect(mapObservation(observationOf(componentBody(feed)), PAGE).reports[0]!.severity).toBe(severity);
    }
    const unknown = mapObservation(observationOf(componentBody(withStatus(FEED, "US West (A)", "Brownout", "Wed, 18 Nov 2026 07:30:00 -0600"))), PAGE);
    expect(unknown.reports[0]!.severity).toBe("unknown");
    expect(unknown.problems).toEqual([{ path: "status", message: 'the status "Brownout" is not a status of StatusIQ: the severity is unknown', fatal: false, lossy: true }]);
  });

  it("keeps the key of a component when its status changes, and gives a new report id", () => {
    const partial = mapObservation(observationOf(componentBody(withStatus(FEED, "Outbound Message Queue", "Partial Outage", "Wed, 18 Nov 2026 07:00:00 -0600"))), PAGE).reports[0]!;
    const major = mapObservation(observationOf(componentBody(MAJOR)), PAGE).reports[0]!;
    expect(major.key).toBe(partial.key);
    expect(major.id).not.toBe(partial.id);
    expect(mapObservation(observationOf(componentBody(MAJOR)), PAGE).reports[0]!.id).toBe(major.id);
  });

  it("makes no report of the head of the feed", () => {
    expect(mapObservation(observationOf(readComponents(FEED)!.head), PAGE)).toEqual({ reports: [], problems: [] });
  });

  it("gives a fatal problem for an item with no id, and for a body that is not one component", () => {
    const noId = mapObservation(observationOf(JSON.stringify({ name: "Outbound Message Queue", status: "Major Outage", since: "Wed, 18 Nov 2026 07:30:00 -0600" })), PAGE);
    expect(noId.reports).toEqual([]);
    expect(noId.problems).toEqual([{ path: "id", message: "the item has no id of a component in its link: the map makes no report", fatal: true }]);
    const changed = { path: "", message: "the observation is not one component of a feed of StatusIQ: the format changed", fatal: true };
    expect(mapObservation(observationOf(readComponents("<html><body>moved</body></html>")!.head), PAGE).problems).toEqual([changed]);
    expect(mapObservation(observationOf("[1, 2]"), PAGE).problems).toEqual([changed]);
    expect(mapObservation(observationOf("not json"), PAGE).problems).toEqual([{ path: "", message: "the body is not JSON", fatal: true }]);
  });
});

describe("the fetch of a page of StatusIQ", () => {
  const rss = (body: string): Reply => ({ status: 200, statusText: "OK", headers: { "content-type": "application/rss+xml;charset=utf-8", "cache-control": "no-store" }, body });
  const fetchWith = (replies: readonly Reply[]) => {
    const sent: Exchange[] = [];
    let index = 0;
    const transport: Transport = async (exchange) => {
      sent.push(exchange);
      const reply = replies[Math.min(index++, replies.length - 1)];
      if (reply === undefined) throw new Error("no reply");
      return reply;
    };
    let time = FETCHED;
    const clock = { now: () => time, sleep: async (ms: number) => void (time += ms) };
    const fetch = createStatusPageFetch({ page: PAGE, pace: { scheduler: new HostScheduler(clock, 1), now: clock.now }, transport, userAgent: "alerts-tests", minIntervalMs: 0, timeoutMs: 1000 });
    return { fetch, sent };
  };
  const observationsOf = (outcome: FetchOutcome) => (outcome.ok ? outcome.observations : []);

  it("asks for the feed of the page, and for the summary of a page of the default format", () => {
    expect(STATUSIQ_PATH).toBe("/rss");
    expect(pagePath(PAGE)).toBe(STATUSIQ_PATH);
    expect(pagePath({})).toBe(SUMMARY_PATH);
  });

  it("gives the head and each component with an outage as JSON observations, with the newest change as the time of the data", async () => {
    const { fetch, sent } = fetchWith([rss(MAJOR)]);
    const outcome = await fetch({ watch: WATCH });
    expect(outcome).toMatchObject({ ok: true, complete: true, asOf: Date.parse("2026-11-18T13:30:00Z") });
    expect(observationsOf(outcome)).toHaveLength(2);
    expect(observationsOf(outcome).every((observation) => observation.contentType === "application/json" && observation.source === PAGE.id)).toBe(true);
    expect(sent.map((exchange) => exchange.url)).toEqual(["https://status.pushover.net/rss"]);
    expect(sent[0]?.headers["accept"]).toBe("application/rss+xml, application/xml;q=0.9");
    expect(sent[0]?.headers["user-agent"]).toBe("alerts-tests");
  });

  it("reads the feed on each fetch, because the page gives no ETag", async () => {
    const { fetch, sent } = fetchWith([rss(FEED)]);
    expect(observationsOf(await fetch({ watch: WATCH }))).toHaveLength(1);
    expect(observationsOf(await fetch({ watch: WATCH }))).toHaveLength(1);
    expect(sent.map((exchange) => exchange.headers["if-none-match"])).toEqual([undefined, undefined]);
  });

  it("fails a cut feed", async () => {
    const { fetch } = fetchWith([rss(FEED.slice(0, 500))]);
    const outcome = await fetch({ watch: WATCH });
    expect(outcome.ok ? undefined : outcome.failure).toEqual({ kind: "network", message: "truncated or malformed body: https://status.pushover.net/rss" });
  });
});

describe("PUSHOVER_KEYS", () => {
  it("holds the id of a component of the real feed for each key, and no key for the dashboard", () => {
    const ids = readComponents(PUSHOVER_KEYS.reduce((feed, key) => withStatus(feed, key.name, "Major Outage", "Wed, 18 Nov 2026 07:30:00 -0600"), FEED))!.incidents.map((body) => (JSON.parse(body) as { id: string }).id);
    expect(ids).toEqual(PUSHOVER_KEYS.map((key) => key.id));
    expect(PUSHOVER_KEYS.map((key) => key.id)).not.toContain(DASHBOARD);
    expect(PAGE.components).toBe(PUSHOVER_KEYS);
  });
});

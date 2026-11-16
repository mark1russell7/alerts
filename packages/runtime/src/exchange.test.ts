import { fakeWallClock, type WallClock } from "@mark1russell7/algebra/clock";
import { join, reportId, SYSTEM_SOURCE, type ChannelId, type Delivery, type Observation, type ObservationId, type PersonId, type PlaceId, type Report, type ReportId, type SourceId, type SourceProcedures, type WatchedPlace } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { envelope, type RuntimeEvent } from "./events.ts";
import { EXCHANGE_CHECKPOINT, EXCHANGE_FORMAT, importOf, importPage, itemProblem, parsePage, sharedItem, sharePage, type ExchangePage, type ImportInput, type ReceivedPage, type SharedItem } from "./exchange.ts";
import { openRuntimeLog, type RuntimeLog } from "./log.ts";
import { openRuntime, type Runtime, type RuntimeOptions } from "./runtime.ts";
import { EMPTY_RUNTIME, fold, rebuild, type FoldContext, type RuntimeState } from "./state.ts";

const T0 = Date.UTC(2026, 3, 1, 18, 0, 0);
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const API = "api" as SourceId;
const PUSHOVER = "pushover" as ChannelId;
const PERSON = "person-1" as PersonId;
const CONTEXT: FoldContext = { sources: [] };

// A public place in Kansas: Sedgwick County KS.
const KANSAS: WatchedPlace = { id: "place:a" as PlaceId, codes: [{ system: "ugc", code: "KSZ083" }], bufferKm: 0 };
const VIEW: RuntimeOptions["view"] = { places: [KANSAS], kinds: ["met"], expectations: [], delay: { quantile: 0.9, level: 0.9 } };

// A value that a problem never shows. A problem of a page holds no value of an event.
const HIDDEN = "hidden-value-7";

/** One tornado warning for Sedgwick County, issued at T0, that a copy received at `received`. */
function report(key: string, received: number): Report {
  return {
    id: reportId({ source: API, key, sent: T0 }),
    source: API,
    origin: "nws",
    key,
    references: [],
    correlation: [],
    status: "actual",
    op: "alert",
    kind: { code: "met.tornado", label: "Tornado Warning" },
    categories: ["met"],
    severity: "extreme",
    urgency: "immediate",
    certainty: "observed",
    response: ["shelter"],
    sent: T0,
    received,
    expires: T0 + 10 * 60 * MINUTE,
    areas: [{ type: "code", system: "ugc", code: "KSZ083" }],
    about: [],
    sender: "w-nws.webmaster@noaa.gov",
    headline: "Tornado Warning",
    observation: `api:${key}` as ObservationId,
    parameters: {},
  };
}

const W1 = report("w1", T0).id;

function delivery(key: string, at: number): Delivery {
  return { key, incident: W1, level: "life-safety", person: PERSON, channel: PUSHOVER, step: 0, at };
}

const started = (run: string, time: number): RuntimeEvent => ({ ...envelope("started", `started:${run}`, time), run });
const fetched = (id: string, time: number, reports: readonly Report[]): RuntimeEvent => ({
  ...envelope("fetch", id, time),
  record: { source: API, at: time, took: 100, fresh: reports.length, fatal: 0 },
  reports,
  problems: [],
});
const delivered = (key: string, time: number, copy?: string): RuntimeEvent => ({ ...envelope("delivery", `delivery:${key}`, time), delivery: delivery(key, time), ...(copy === undefined ? {} : { copy }) });
const acknowledged = (time: number): RuntimeEvent => ({ ...envelope("acknowledgment", "ack:k1", time), acknowledgment: { incident: W1, level: "life-safety", person: PERSON, at: time, via: PUSHOVER } });
const ended = (time: number, reports: readonly ReportId[]): RuntimeEvent => ({ ...envelope("ended", `ended:${API}:${time}`, time), source: API, reports });
const back = (time: number, reports: readonly ReportId[]): RuntimeEvent => ({ ...envelope("back", `back:${API}:${time}`, time), source: API, reports });
const cancelled = (key: string, time: number): RuntimeEvent => ({ ...envelope("cancelled", `cancelled:${key}`, time), delivery: key });
const endOf = (incident: ReportId, time: number): RuntimeEvent => ({ ...envelope("escalation-end", `escalation-end:${incident}:${PERSON}:0`, time), end: { incident, person: PERSON, at: time } });
const stepped = (n: number, time: number, size: number): RuntimeEvent => ({ ...envelope("clock", `clock:${n}`, time), size });
const refused = (key: string, time: number): RuntimeEvent => ({ ...envelope("refused", `refused:${key}@${time}`, time), key, channel: PUSHOVER, kind: "refused", retryAt: time + MINUTE });

/** The shared item of an event of a copy. */
function itemOf(event: RuntimeEvent, copy: string): SharedItem {
  const item = sharedItem(event, copy);
  if (item === undefined) throw new Error(`The event ${event.id} is not a shared event.`);
  return item;
}

/** The import of an event of another copy. */
const imported = (event: RuntimeEvent, copy: string): RuntimeEvent => importOf(itemOf(event, copy));

/** A page of the copy `b`, with the fields of `fields`. */
function page(items: readonly unknown[], fields: Partial<Omit<ReceivedPage, "items">> = {}): ReceivedPage {
  return { format: EXCHANGE_FORMAT, copy: "b", log: "started:run-b", after: 0, next: 10, head: 10, ...fields, items };
}

const input = (fields: Partial<ImportInput> = {}): ImportInput => ({ self: "a", position: undefined, logged: undefined, now: T0 + MINUTE, ...fields });

const foldAll = (events: readonly RuntimeEvent[]): RuntimeState => events.reduce((state, event) => fold(state, event, CONTEXT), EMPTY_RUNTIME);

describe("sharedItem", () => {
  it("gives the reports of a fetch with no record, no cursor and no problems", () => {
    const r = report("w1", T0);
    expect(sharedItem(fetched("fetch:1", T0, [r]), "a")).toEqual({ from: "a", event: { ...envelope("fetch", "fetch:1", T0), reports: [r] } });
  });

  it("gives nothing for a fetch with no report and for each event that stays in its copy", () => {
    expect(sharedItem(fetched("fetch:1", T0, []), "a")).toBeUndefined();
    expect(sharedItem(started("run-a", T0), "a")).toBeUndefined();
    expect(sharedItem(stepped(1, T0, MINUTE), "a")).toBeUndefined();
    expect(sharedItem(refused("k1", T0), "a")).toBeUndefined();
  });

  it("gives a delivery with no copy id, because the copy id is an id of the channel steps of one copy", () => {
    const item = itemOf(delivered("k1", T0, "copy-1"), "a");
    expect(item.event).toEqual({ ...envelope("delivery", "delivery:k1", T0), delivery: delivery("k1", T0) });
    expect(Object.keys(item.event)).not.toContain("copy");
  });

  it("gives each event of the ledger and each end mark as it is", () => {
    for (const event of [acknowledged(T0), ended(T0, [W1]), back(T0, [W1]), cancelled("k1", T0), endOf(W1, T0)]) expect(itemOf(event, "a")).toEqual({ from: "a", event });
  });

  it("gives an import again with the copy that wrote its event", () => {
    const item = itemOf(fetched("fetch:1", T0, [report("w1", T0)]), "c");
    expect(sharedItem(importOf(item), "b")).toEqual(item);
  });
});

describe("itemProblem", () => {
  const good = itemOf(delivered("k1", T0), "b");

  it("gives no problem for each shared item", () => {
    const events = [fetched("fetch:1", T0, [report("w1", T0)]), delivered("k1", T0, "copy-1"), acknowledged(T0), ended(T0, [W1]), back(T0, [W1]), cancelled("k1", T0), endOf(W1, T0)];
    for (const event of events) expect(itemProblem(JSON.parse(JSON.stringify(itemOf(event, "b"))))).toBeUndefined();
    expect(itemProblem({ from: "b", event: { ...envelope("ended", "ended:1", T0), source: API, reports: [W1], asOf: T0 } })).toBeUndefined();
  });

  it.each<[string, unknown, string]>([
    ["a list", [HIDDEN], "the item is not an object."],
    ["no copy", { from: `${HIDDEN} B`, event: good.event }, "the item does not have the id of a copy."],
    ["no event", { from: "b" }, "the item does not have an event."],
    ["no time", { from: "b", event: { ...good.event, time: HIDDEN } }, "the envelope of the event is not complete."],
    ["a type of one copy", { from: "b", event: refused(HIDDEN, T0) }, "the event does not have the type of a shared event."],
    ["an unknown field", { from: "b", event: { ...good.event, copy: HIDDEN } }, "the event delivery has the unknown field copy."],
    ["a missing field", { from: "b", event: envelope("delivery", "delivery:k1", T0) }, "the event delivery does not have the field delivery."],
    ["a bad field", { from: "b", event: { ...good.event, delivery: { ...delivery("k1", T0), step: -1, key: HIDDEN } } }, "the field delivery of the event delivery is not valid."],
    ["a bad report", { from: "b", event: { ...envelope("fetch", "fetch:1", T0), reports: [{ ...report("w1", T0), areas: [], headline: HIDDEN }] } }, "the field reports of the event fetch is not valid."],
    ["an extra field", { from: "b", event: good.event, note: HIDDEN }, "the item has a field other than from and event."],
  ])("gives a problem with no value for %s", (_name, value, problem) => {
    expect(itemProblem(value)).toBe(problem);
  });
});

describe("sharePage", () => {
  const self = { copy: "a", log: "started:run-a" };

  // A log of copy a: one event of each kind of the exchange, and events that stay in the copy.
  function logOf(): RuntimeLog {
    const log = openRuntimeLog(":memory:");
    const events = [
      started("run-a", T0),
      fetched("fetch:1", T0 + SECOND, [report("w1", T0 + SECOND)]),
      fetched("fetch:2", T0 + 2 * SECOND, []),
      stepped(1, T0 + 3 * SECOND, MINUTE),
      delivered("k1", T0 + 4 * SECOND),
      refused("k2", T0 + 5 * SECOND),
      imported(fetched("fetch:1", T0 + 6 * SECOND, [report("w2", T0 + 6 * SECOND)]), "c"),
      endOf(W1, T0 + 7 * SECOND),
    ];
    log.appendAll(events, () => undefined);
    return log;
  }

  it("gives the shared events after a position, and a next position at the head", () => {
    const log = logOf();
    const shared = sharePage(log, self, 0);
    expect(shared).toMatchObject({ format: EXCHANGE_FORMAT, copy: "a", log: "started:run-a", after: 0, next: log.head(), head: log.head() });
    expect(shared.items.map((item) => [item.from, item.event.type])).toEqual([
      ["a", "fetch"],
      ["a", "delivery"],
      ["c", "fetch"],
      ["a", "escalation-end"],
    ]);
  });

  it("gives the same items in pages of each size, and each page starts after the last entry of the page before", () => {
    const log = logOf();
    const whole = sharePage(log, self, 0).items;
    for (const limit of [1, 2, 3, 5]) {
      const items: SharedItem[] = [];
      let after = 0;
      for (let pages = 0; pages < 20; pages += 1) {
        const next = sharePage(log, self, after, limit);
        expect(next.after).toBe(after);
        expect(next.next).toBeGreaterThanOrEqual(after);
        items.push(...next.items);
        if (next.next === after) break;
        after = next.next;
      }
      expect(after).toBe(log.head());
      expect(items).toEqual(whole);
    }
  });

  it("gives an empty page at the position of a read after the head", () => {
    const log = logOf();
    expect(sharePage(log, self, log.head())).toMatchObject({ next: log.head(), items: [] });
    expect(sharePage(log, self, log.head() + 5)).toMatchObject({ next: log.head() + 5, head: log.head(), items: [] });
  });

  it("refuses a position or a limit that is not valid", () => {
    const log = logOf();
    expect(() => sharePage(log, self, -1)).toThrow(RangeError);
    expect(() => sharePage(log, self, 1.5)).toThrow(RangeError);
    expect(() => sharePage(log, self, 0, 0)).toThrow(RangeError);
  });
});

describe("parsePage", () => {
  it("gives a page after a trip through JSON", () => {
    const log = openRuntimeLog(":memory:");
    log.appendAll([started("run-a", T0), delivered("k1", T0)], () => undefined);
    const shared: ExchangePage = sharePage(log, { copy: "a", log: "started:run-a" }, 0);
    const parsed = parsePage(JSON.parse(JSON.stringify(shared)));
    expect(parsed.tag).toBe("ok");
    if (parsed.tag === "ok") expect(parsed.value).toEqual(shared);
  });

  it("gives each problem of the form, with no value", () => {
    expect(parsePage([HIDDEN])).toEqual({ tag: "err", error: ["The page is not an object."] });
    const parsed = parsePage({ format: HIDDEN, copy: `${HIDDEN} B`, log: "", after: -1, next: 1.5, head: HIDDEN, items: HIDDEN });
    expect(parsed.tag).toBe("err");
    if (parsed.tag !== "err") return;
    expect(parsed.error).toEqual([
      `The page does not have the format ${EXCHANGE_FORMAT}.`,
      "The page does not have the id of a copy.",
      "The page does not have the id of a log.",
      "The field after of the page is not an integer of 0 or more.",
      "The field next of the page is not an integer of 0 or more.",
      "The field head of the page is not an integer of 0 or more.",
      "The page does not have a list of items.",
    ]);
    expect(parsed.error.join(" ")).not.toContain(HIDDEN);
  });

  it("refuses a page with a next position below its start", () => {
    const parsed = parsePage(page([], { after: 8, next: 4 }));
    expect(parsed.tag === "err" ? parsed.error : []).toEqual(["The field next of the page is below its field after."]);
  });
});

describe("importOf", () => {
  it("gives the id of the copy before the id of an event of a source, because each copy gives its own ids to them", () => {
    for (const event of [fetched("fetch:1", T0, [report("w1", T0)]), ended(T0, [W1]), back(T0, [W1])]) expect(importOf(itemOf(event, "b")).id).toBe(`b/${event.id}`);
  });

  it("keeps the id of a step of the ledger, because two copies that do one step write one event", () => {
    for (const event of [delivered("k1", T0), acknowledged(T0), cancelled("k1", T0), endOf(W1, T0)]) expect(importOf(itemOf(event, "b")).id).toBe(event.id);
  });

  it("keeps the envelope of the event of the other copy", () => {
    const event = delivered("k1", T0 + 3 * SECOND);
    expect(importOf(itemOf(event, "b"))).toEqual({ id: event.id, at: event.at, type: "import", time: event.time, from: "b", event: itemOf(event, "b").event });
  });
});

describe("importPage", () => {
  const items = [itemOf(fetched("fetch:1", T0, [report("w1", T0)]), "b"), itemOf(delivered("k1", T0), "b")];
  const position = (next: number, log = "started:run-b") => ({ log, next });

  it("imports the items of another copy, and writes the position with them", () => {
    const result = importPage(page(items), input());
    expect(result.imports).toBe(2);
    expect(result.problems).toEqual([]);
    expect(result.position).toEqual(position(10));
    expect(result.events).toEqual([
      ...items.map((item) => importOf(item)),
      { ...envelope("exchange", "exchange:b:started:run-b:10", T0 + MINUTE), peer: "b", log: "started:run-b", next: 10 },
    ]);
  });

  it("skips each item that this copy wrote, because it came back from the other copy", () => {
    const result = importPage(page([itemOf(delivered("k1", T0), "a"), items[1]]), input());
    expect(result.imports).toBe(1);
    expect(result.events.flatMap((event) => (event.type === "import" ? [event.from] : []))).toEqual(["b"]);
  });

  it("refuses a page of its own copy with a problem", () => {
    const result = importPage(page(items, { copy: "a" }), input());
    expect(result.events).toEqual([]);
    expect(result.problems).toEqual(["The copy a reads its own log. Give the URL of another copy."]);
  });

  it("refuses a page that starts after the position, because it skips entries", () => {
    const result = importPage(page(items, { after: 7, next: 12 }), input({ position: position(5), logged: position(5) }));
    expect(result).toEqual({ events: [], imports: 0, position: position(5), problems: [] });
  });

  it("starts the read of a new log of the copy at 0", () => {
    const old = position(50, "started:run-old");
    expect(importPage(page(items, { after: 20, next: 30 }), input({ position: old, logged: old }))).toEqual({ events: [], imports: 0, position: position(0), problems: [] });
    const result = importPage(page(items, { after: 0, next: 30 }), input({ position: position(0), logged: old }));
    expect(result.imports).toBe(2);
    expect(result.events.at(-1)).toMatchObject({ type: "exchange", log: "started:run-b", next: 30 });
  });

  it("reads a page again with no new position, and never moves the position back", () => {
    const result = importPage(page(items, { after: 0, next: 8 }), input({ position: position(10), logged: position(10) }));
    expect(result.position).toEqual(position(10));
    expect(result.events.map((event) => event.type)).toEqual(["import", "import"]);
  });

  it("writes a position with no import only after a checkpoint of entries", () => {
    const logged = position(10);
    const near = importPage(page([], { after: 10, next: 10 + EXCHANGE_CHECKPOINT - 1 }), input({ position: logged, logged }));
    expect(near.events).toEqual([]);
    expect(near.position).toEqual(position(10 + EXCHANGE_CHECKPOINT - 1));
    const far = importPage(page([], { after: near.position.next, next: 10 + EXCHANGE_CHECKPOINT }), input({ position: near.position, logged }));
    expect(far.events).toEqual([{ ...envelope("exchange", `exchange:b:started:run-b:${10 + EXCHANGE_CHECKPOINT}`, T0 + MINUTE), peer: "b", log: "started:run-b", next: 10 + EXCHANGE_CHECKPOINT }]);
  });

  it("writes the first position in a log of the copy with no import", () => {
    expect(importPage(page([], { next: 4 }), input()).events).toMatchObject([{ type: "exchange", next: 4 }]);
  });

  it("gives a problem for each bad item, and imports the other items", () => {
    const result = importPage(page([items[0], { from: "b", event: { ...items[1]!.event, copy: HIDDEN } }, items[1]]), input());
    expect(result.imports).toBe(2);
    expect(result.problems).toEqual(["The item 1 of the page of b after 0: the event delivery has the unknown field copy."]);
  });
});

describe("the fold of the imports", () => {
  const own = report("w1", T0 + SECOND);
  // The other copy received the same report later, and a second report that only it sees.
  const theirs = [report("w1", T0 + 2 * SECOND), report("w2", T0 + 2 * SECOND)];
  const W2 = theirs[1]!.id;
  const events: RuntimeEvent[] = [
    started("run-a", T0),
    fetched("fetch:1", T0 + SECOND, [own]),
    imported(fetched("fetch:1", T0 + 2 * SECOND, theirs), "b"),
    delivered("k1", T0 + 3 * SECOND),
    refused("k2", T0 + 4 * SECOND),
    stepped(1, T0 + 5 * SECOND + 5 * MINUTE, 5 * MINUTE),
    imported(delivered("k2", T0 + 6 * SECOND), "b"),
    imported(acknowledged(T0 + 7 * SECOND), "b"),
    imported(ended(T0 + 8 * SECOND, [W2]), "b"),
    imported(endOf(W2, T0 + 9 * SECOND), "b"),
    endOf(W1, T0 + 10 * SECOND + 5 * MINUTE),
    imported(cancelled("k2", T0 + 11 * SECOND), "b"),
    { ...envelope("exchange", "exchange:b:started:run-b:12", T0 + 12 * SECOND + 5 * MINUTE), peer: "b", log: "started:run-b", next: 12 },
  ];

  it("gives the state of the rebuild after each event", () => {
    for (let count = 1; count <= events.length; count += 1) expect(foldAll(events.slice(0, count))).toEqual(rebuild(events.slice(0, count), CONTEXT));
  });

  it("joins the merge of the two sides", () => {
    const state = foldAll(events);
    expect(state.merge).toEqual(join(state.own.merge, state.imported.merge));
    expect(state.merge.reports.map((report) => report.id).sort()).toEqual([W1, W2].sort());
    expect(state.merge.deliveries.map((one) => one.key).sort()).toEqual(["k1", "k2"]);
    expect(state.own.merge.deliveries.map((one) => one.key)).toEqual(["k1"]);
  });

  it("moves the own parts at a step of the clock, and never the imported parts", () => {
    const state = foldAll(events);
    expect(state.own.merge.reports.map((report) => report.received)).toEqual([T0 + SECOND + 5 * MINUTE]);
    expect(state.own.merge.deliveries.map((one) => one.at)).toEqual([T0 + 3 * SECOND + 5 * MINUTE]);
    expect(state.imported.merge.reports.map((report) => report.received)).toEqual([T0 + 2 * SECOND, T0 + 2 * SECOND]);
    expect(state.imported.merge.deliveries.map((one) => one.at)).toEqual([T0 + 6 * SECOND]);
    expect(state.escalationEnds).toEqual([
      { incident: W1, person: PERSON, at: T0 + 10 * SECOND + 5 * MINUTE },
      { incident: W2, person: PERSON, at: T0 + 9 * SECOND },
    ]);
  });

  it("keeps the time of the state, because an import has the time of another clock", () => {
    const late = imported(delivered("k9", T0 + 60 * MINUTE), "b");
    expect(foldAll([...events, late]).time).toBe(foldAll(events).time);
  });

  it("ends the refusal of a key that the other copy delivered, and adds its cancel", () => {
    const before = foldAll(events.slice(0, 6));
    expect(Object.keys(before.refusals)).toEqual(["k2"]);
    const state = foldAll(events);
    expect(state.refusals).toEqual({});
    expect(state.cancelled).toEqual(["k2"]);
    expect(state.exchanges).toEqual({ b: { log: "started:run-b", next: 12 } });
  });

  it("keeps one end of an episode when the two copies end it, because the log keeps the first event of an id", () => {
    const log = openRuntimeLog(":memory:");
    let state = EMPTY_RUNTIME;
    const append = (list: readonly RuntimeEvent[]) => log.appendAll(list, (event) => (state = fold(state, event, CONTEXT)));
    append([started("run-a", T0), imported(endOf(W1, T0 + SECOND), "b")]);
    expect(append([endOf(W1, T0 + 2 * SECOND)])).toEqual([`escalation-end:${W1}:${PERSON}:0`]);
    expect(state.escalationEnds).toEqual([{ incident: W1, person: PERSON, at: T0 + SECOND }]);
    expect(rebuild(log.read(), CONTEXT)).toEqual(state);
  });
});

describe("two runtimes", () => {
  const observation = (key: string, fetchedAt: number): Observation => ({
    id: `api:${key}` as ObservationId,
    source: API,
    fetched: fetchedAt,
    contentType: "application/json",
    body: JSON.stringify({ key }),
    transport: { latency: 0 },
  });

  // A source that gives the same warnings at each fetch.
  function source(keys: readonly string[], clock: WallClock): SourceProcedures {
    return {
      describe: () => ({
        id: API,
        title: "The source api",
        origins: ["nws"],
        dependsOn: ["provider:api"],
        uses: ["internet", "power"],
        kinds: ["met"],
        coverage: [{ type: "code", system: "ugc", code: "KSZ083" }],
        transport: "poll",
        interval: MINUTE,
        slowAfter: 10_000,
        auth: "none",
      }),
      fetch: async () => ({ ok: true, observations: keys.map((key) => observation(key, clock.now())), complete: true }),
      map: ({ observation: seen }) => ({ reports: [report((JSON.parse(seen.body) as { readonly key: string }).key, seen.fetched)], problems: [] }),
    };
  }

  function open(copy: string, keys: readonly string[], clock: WallClock, log: RuntimeLog = openRuntimeLog(":memory:"), run = `run-${copy}`): { readonly runtime: Runtime; readonly log: RuntimeLog } {
    const runtime = openRuntime({ log, clock, sources: [source(keys, clock)], watch: () => ({ places: [KANSAS], kinds: ["met"] }), view: VIEW, run, copy });
    return { runtime, log };
  }

  // The shared part of the merge state. The system reports of a copy tell its own health, thus they stay in the copy.
  const shared = (state: RuntimeState): RuntimeState["merge"] => ({ ...state.merge, reports: state.merge.reports.filter((one) => one.source !== SYSTEM_SOURCE) });

  // The read of one page of a copy by another copy, through JSON as on the wire.
  function read(reader: Runtime, writer: Runtime, copy: string) {
    const parsed = parsePage(JSON.parse(JSON.stringify(writer.share(reader.position(copy)))));
    if (parsed.tag !== "ok") throw new Error(parsed.error.join(" "));
    return { page: parsed.value, take: reader.take(parsed.value) };
  }

  it("reach the same merge state after each copy reads the other", async () => {
    const clock = fakeWallClock(T0);
    const a = open("a", ["w1"], clock);
    const b = open("b", ["w1", "w2"], clock);
    await a.runtime.pass();
    await b.runtime.pass();
    expect(shared(a.runtime.state())).not.toEqual(shared(b.runtime.state()));

    const first = read(a.runtime, b.runtime, "b");
    expect(first.take.imports).toBeGreaterThan(0);
    expect(first.take.problems).toEqual([]);
    // A second take of one page adds no event and changes nothing.
    const state = a.runtime.state();
    const head = a.log.head();
    expect(a.runtime.take(first.page)).toEqual({ ...first.take, conflicts: [] });
    expect(a.log.head()).toBe(head);
    expect(a.runtime.state()).toEqual(state);

    read(b.runtime, a.runtime, "a");
    // The page of b now holds the imports of a. The read skips them, because a wrote them.
    expect(read(a.runtime, b.runtime, "b").take.imports).toBe(0);

    expect(shared(a.runtime.state())).toEqual(shared(b.runtime.state()));
    expect(shared(a.runtime.state()).reports.map((one) => one.key).sort()).toEqual(["w1", "w2"]);
    expect(rebuild(a.log.read(), a.runtime.config)).toEqual(a.runtime.state());
    expect(rebuild(b.log.read(), b.runtime.config)).toEqual(b.runtime.state());
  });

  it("reads on after a restart from the position in the log", async () => {
    const clock = fakeWallClock(T0);
    const a = open("a", ["w1"], clock);
    const b = open("b", ["w2"], clock);
    await b.runtime.pass();
    const { take } = read(a.runtime, b.runtime, "b");
    expect(take.next).toBe(b.log.head());

    const restarted = open("a", ["w1"], clock, a.log, "run-a2");
    expect(restarted.runtime.position("b")).toBe(take.next);
    expect(read(restarted.runtime, b.runtime, "b").take).toEqual({ imports: 0, next: take.next, problems: [], conflicts: [] });
    expect(restarted.runtime.state().imported.merge.reports.map((one) => one.key)).toEqual(["w2"]);
  });

  // The salvage of a broken file: a new file gets the events of the old file, with new positions, and then one recovery.
  function salvage(old: RuntimeLog, quarantine: string): RuntimeLog {
    const recovered: RuntimeEvent = { ...envelope("recovered", `recovered:${quarantine}`, T0), quarantine, fault: "corrupt", read: 0, added: 0, lost: 0, whole: true, problems: [] };
    const salvaged = openRuntimeLog(":memory:");
    salvaged.appendAll([...old.read(), recovered], () => undefined);
    return salvaged;
  }

  it("reads a recovered log of another copy again from the start, because the salvage gives new positions", async () => {
    const clock = fakeWallClock(T0);
    const a = open("a", ["w1"], clock);
    const b = open("b", ["w2"], clock);
    await b.runtime.pass();
    const before = read(a.runtime, b.runtime, "b");
    const merged = shared(a.runtime.state());

    const recovered = open("b", ["w2"], clock, salvage(b.log, "events.db.broken-1"), "run-b2");
    const refused = read(a.runtime, recovered.runtime, "b");
    expect(refused.page.log).toBe("recovered:events.db.broken-1");
    expect(refused.page.log).not.toBe(before.page.log);
    expect(refused.take).toEqual({ imports: 0, next: 0, problems: [], conflicts: [] });

    const again = read(a.runtime, recovered.runtime, "b");
    expect(again.page.after).toBe(0);
    expect(again.take).toEqual({ imports: before.take.imports, next: recovered.log.head(), problems: [], conflicts: [] });
    expect(shared(a.runtime.state())).toEqual(merged);
    expect(rebuild(a.log.read(), a.runtime.config)).toEqual(a.runtime.state());
  });

  it("reads each other copy again from the start after a recovery of its own log, because the salvage can lose an import", async () => {
    const clock = fakeWallClock(T0);
    const a = open("a", ["w1"], clock);
    const b = open("b", ["w2"], clock);
    await b.runtime.pass();
    const { take } = read(a.runtime, b.runtime, "b");
    expect(take.next).toBeGreaterThan(0);

    const recovered = open("a", ["w1"], clock, salvage(a.log, "events.db.broken-2"), "run-a2");
    expect(recovered.runtime.position("b")).toBe(0);
    expect(read(recovered.runtime, b.runtime, "b").take).toEqual({ imports: take.imports, next: take.next, problems: [], conflicts: [] });
    expect(recovered.runtime.state().imported.merge.reports.map((one) => one.key)).toEqual(["w2"]);
  });
});

import { knownKind, sourceDescriptorSchema } from "@mark1russell7/alerts";
import { fakeWallClock } from "@mark1russell7/algebra/clock";
import { describe, expect, it } from "vitest";
import { fakeSessions } from "./fake.ts";
import { createNwwsSource, NWWS_DESCRIPTOR, NWWS_DOMAIN, NWWS_ROOM, NWWS_SERVICE, STALL_AFTER_MS } from "./index.ts";

describe("createNwwsSource", () => {
  it("gives the procedures of the source contract, with a check and no locate", () => {
    const source = createNwwsSource({ account: { username: "operator", password: "a-password" }, clock: fakeWallClock(0), open: fakeSessions().open });
    expect(source.describe()).toBe(NWWS_DESCRIPTOR);
    expect(source.check).toBeTypeOf("function");
    expect(source.locate).toBeUndefined();
    expect(source.state()).toEqual({ status: "idle", failures: 0 });
  });

  it("opens no session before the first fetch, and connects to the room of NWWS-OI by default", async () => {
    const fake = fakeSessions((session) => session.join());
    const clock = fakeWallClock(0);
    const source = createNwwsSource({ account: { username: "operator", password: "a-password" }, clock, open: fake.open });
    expect(fake.sessions).toHaveLength(0);
    await source.fetch({ watch: { places: [] } });
    expect(fake.last().options).toMatchObject({ service: NWWS_SERVICE, domain: NWWS_DOMAIN, room: NWWS_ROOM, keepalive: 60_000, timeout: 30_000, history: { maxStanzas: 1000 } });
    expect(fake.last().options.nickname).toMatch(/^alerts-[0-9a-f]{8}$/);
    expect(source.state().status).toBe("joined");
    // The default stall time ends a session with no product for 5 minutes.
    await clock.advance(STALL_AFTER_MS);
    expect(fake.sessions[0]!.closed).toBe(true);
    await source.close();
    expect(clock.pending).toBe(0);
  });
});

describe("NWWS_DESCRIPTOR", () => {
  it("is a valid descriptor of a stream with a key, and each of its kinds is known", () => {
    expect(sourceDescriptorSchema.parse(NWWS_DESCRIPTOR)).toEqual(NWWS_DESCRIPTOR);
    expect(NWWS_DESCRIPTOR).toMatchObject({ id: "nwws", origins: ["nws"], dependsOn: ["provider:nwws-oi"], transport: "stream", auth: "key", uses: ["internet", "power"] });
    for (const kind of NWWS_DESCRIPTOR.kinds) expect(knownKind(kind)).toBe(true);
    expect(NWWS_DESCRIPTOR.coverage).toContainEqual({ type: "code", system: "iso3166", code: "US" });
  });
});

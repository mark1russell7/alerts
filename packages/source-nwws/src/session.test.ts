import { xml } from "@xmpp/client";
import { describe, expect, it } from "vitest";
import { roomProduct, sessionNickname } from "./session.ts";

const ROOM = "room@conference.example.org";
const ATTRIBUTES = { xmlns: "nwws-oi", cccc: "KWBC", ttaaii: "XOUS55", issue: "2026-11-16T20:04:00Z", awipsid: "CAPWBC", id: "nwws_processor.3243" };

function message(attributes: Record<string, string>, ...children: ReturnType<typeof xml>[]) {
  return xml("message", { to: "alerts@example.org/alerts", type: "groupchat", from: `${ROOM}/nwws-oi`, ...attributes }, xml("body", {}, "KWBC issues CAPWBC"), ...children);
}

describe("roomProduct", () => {
  it("reads the attributes and the text of the element x of a message of the room", () => {
    expect(roomProduct(message({}, xml("x", ATTRIBUTES, "\n\nXOUS55 KWBC 162004\n\nCAPWBC\n\n<?xml?>")), ROOM)).toEqual({
      attributes: ATTRIBUTES,
      text: "\n\nXOUS55 KWBC 162004\n\nCAPWBC\n\n<?xml?>",
      delayed: false,
    });
  });

  it("tells a product of the history from its element delay", () => {
    const delay = xml("delay", { xmlns: "urn:xmpp:delay", from: ROOM, stamp: "2026-11-16T20:00:12Z" });
    expect(roomProduct(message({}, xml("x", ATTRIBUTES, "text"), delay), ROOM)?.delayed).toBe(true);
  });

  it("gives undefined for a stanza that is not a product of the room", () => {
    const x = xml("x", ATTRIBUTES, "text");
    expect(roomProduct(message({ type: "chat" }, x), ROOM)).toBeUndefined();
    expect(roomProduct(message({ from: "other@conference.example.org/nwws-oi" }, x), ROOM)).toBeUndefined();
    expect(roomProduct(message({}, xml("x", { ...ATTRIBUTES, xmlns: "jabber:x:oob" }, "text")), ROOM)).toBeUndefined();
    expect(roomProduct(message({}), ROOM)).toBeUndefined();
    expect(roomProduct(xml("presence", { from: `${ROOM}/nwws-oi` }, x), ROOM)).toBeUndefined();
  });
});

describe("sessionNickname", () => {
  it("gives a random name with no personal data", () => {
    const names = new Set(Array.from({ length: 20 }, sessionNickname));
    expect(names.size).toBe(20);
    for (const name of names) expect(name).toMatch(/^alerts-[0-9a-f]{8}$/);
  });
});

import { checkWith, reportSchema, type ObservationId, type PersonId, type Recipient, type Report, type SubjectWatch, type TellSite } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import {
  siteLink,
  TELL_LIFE,
  TELL_SUBJECT,
  tellEventSchema,
  tellLineName,
  tellLines,
  tellPersons,
  tellStep,
  type TellDraft,
  type TellLine,
  type TellReport,
} from "./tell-message.ts";

const T0 = Date.UTC(2026, 10, 19, 18, 0);
// A made-up site: a local origin and a phone origin under a name for examples.
const SITE: TellSite = { local: "http://127.0.0.1:4000", phone: "https://site.example.net:10000" };
const PHONE = "https://site.example.net:10000";

const recipient = (person: string, subjects?: readonly SubjectWatch[]): Recipient => ({
  watch: { person: person as PersonId, places: [], rules: [], ...(subjects === undefined ? {} : { subjects }) },
  policies: [],
  addresses: {},
});

const draft = (more: Partial<TellDraft> = {}): TellDraft => ({
  class: "needs-you",
  urgent: false,
  item: "AL-92",
  text: "The deploy waits for your restart.",
  persons: ["operator" as PersonId],
  received: T0,
  ...more,
});

// The report of the log: the map of the source adds the id of the observation.
const logged = (report: TellReport): Report => ({ ...report, observation: "observation-1" as ObservationId });

describe("the event of a message of the operator (AL-92)", () => {
  it("takes a message with a class, an item and a text, and trims the text", () => {
    expect(tellEventSchema.parse({ class: "live", item: "AL-89", text: "  The swap is live.  " })).toEqual({ class: "live", item: "AL-89", text: "The swap is live." });
  });

  it("refuses an urgent message of a class other than needs-you, an empty text and a wrong item", () => {
    expect(tellEventSchema.safeParse({ class: "done-you-asked", urgent: true, item: "AL-1", text: "x" }).success).toBe(false);
    expect(tellEventSchema.safeParse({ class: "needs-you", item: "AL-1", text: "   " }).success).toBe(false);
    expect(tellEventSchema.safeParse({ class: "needs-you", item: "AL 1", text: "x" }).success).toBe(false);
    expect(tellEventSchema.safeParse({ class: "needs-you", item: "AL-1", text: "x", extra: 1 }).success).toBe(false);
    expect(tellEventSchema.safeParse({ class: "needs-you", urgent: true, item: "AL-1", text: "x" }).success).toBe(true);
  });
});

describe("the persons of a message (AL-92)", () => {
  const people = [recipient("operator", [{ system: "alerts.source" }, { system: "alerts.channel" }]), recipient("places-only"), recipient("one-source", [{ system: "alerts.source", id: "nws" }])];

  it("gives the operator, the one person who watches each source, when the message has no field to", () => {
    expect(tellPersons(undefined, people)).toEqual({ tag: "ok", value: ["operator"] });
  });

  it("refuses a message with no field to when no person or two people watch each source", () => {
    const none = tellPersons(undefined, [recipient("places-only")]);
    const two = tellPersons(undefined, [...people, recipient("second", [{ system: "alerts.source" }])]);
    expect(none.tag).toBe("err");
    expect(two.tag).toBe("err");
  });

  it("gives the persons of the field to in one order, and refuses a person that the configuration does not have", () => {
    expect(tellPersons(["places-only", "operator", "operator"], people)).toEqual({ tag: "ok", value: ["operator", "places-only"] });
    const unknown = tellPersons(["operator", "a-stranger"], people);
    expect(unknown.tag).toBe("err");
    // The problem gives a count, not the key.
    if (unknown.tag === "err") expect(unknown.error).not.toContain("a-stranger");
  });

  it("has a subject that only a watch of each source matches", () => {
    expect(TELL_SUBJECT).toEqual({ system: "alerts.source", id: "tell" });
  });
});

describe("the link of a message (AL-92)", () => {
  it("changes a path and a link of the local site to the phone form, with the query and the fragment", () => {
    expect(siteLink("/a/graph/", SITE)).toEqual({ url: `${PHONE}/a/graph/` });
    expect(siteLink("/canvas/x?view=1", SITE)).toEqual({ url: `${PHONE}/canvas/x?view=1` });
    expect(siteLink("http://127.0.0.1:4000/a/graph/?tab=2#items", SITE)).toEqual({ url: `${PHONE}/a/graph/?tab=2#items` });
    expect(siteLink("http://localhost:4000/a/graph/", SITE)).toEqual({ url: `${PHONE}/a/graph/` });
  });

  it("keeps a public link as it is, and gives no link for no link", () => {
    expect(siteLink("https://example.com/a?b=1", SITE)).toEqual({ url: "https://example.com/a?b=1" });
    expect(siteLink(undefined, SITE)).toEqual({ url: undefined });
  });

  it("refuses a loopback link of another port, a path or a loopback link with no site, and a link that is not http", () => {
    for (const url of ["http://127.0.0.1:9999/a/", "javascript:void(0)", "//other.example/a", "not a link", "file:///etc/hosts"]) {
      expect(siteLink(url, SITE)).toHaveProperty("refused");
    }
    expect(siteLink("/a/graph/", undefined)).toHaveProperty("refused");
    expect(siteLink("http://127.0.0.1:4000/a/graph/", undefined)).toHaveProperty("refused");
  });

  it("never gives a link on the loopback address, in each form of the address", () => {
    const forms = [
      "http://127.0.0.1:4000/a/",
      "http://127.1:4000/a/",
      "http://2130706433:4000/a/",
      "http://0x7f.0.0.1:4000/a/",
      "http://127.8.9.10:4000/a/",
      "http://LOCALHOST:4000/a/",
      "http://graph.localhost:4000/a/",
      "http://[::1]:4000/a/",
      "http://[0:0:0:0:0:0:0:1]:4000/a/",
      "http://[::ffff:127.0.0.1]:4000/a/",
      "http://0.0.0.0:4000/a/",
      "http://127.0.0.1:80/a/",
      "http://127.0.0.1/a/",
      "https://localhost/a/",
    ];
    for (const site of [SITE, undefined]) {
      for (const url of forms) {
        const link = siteLink(url, site);
        if ("url" in link) {
          expect(link.url?.startsWith(`${PHONE}/`)).toBe(true);
        } else {
          expect(link.refused.length).toBeGreaterThan(0);
        }
      }
    }
  });
});

describe("the lines of the messages (AL-92)", () => {
  it("gives an alert for a message with no open line, with the persons as its addresses", () => {
    const step = tellStep(new Map(), draft({ url: `${PHONE}/a/graph/` }));
    expect(step.reports).toHaveLength(1);
    const [report] = step.reports;
    expect(report).toMatchObject({
      op: "alert",
      references: [],
      status: "system",
      kind: { code: "system.tell.needs-you", label: "Needs you" },
      severity: "moderate",
      urgency: "expected",
      response: ["assess"],
      addresses: ["operator"],
      about: [TELL_SUBJECT],
      headline: "Needs you: AL-92",
      description: "The deploy waits for your restart.",
      web: `${PHONE}/a/graph/`,
      expires: T0 + TELL_LIFE,
      parameters: { item: ["AL-92"] },
    });
    expect(report?.key).toBe(`${tellLineName("AL-92", "needs-you", ["operator" as PersonId])}#${T0}`);
    expect(checkWith(reportSchema, logged(report as TellReport)).tag).toBe("ok");
  });

  it("gives an urgent message a severe and immediate report", () => {
    expect(tellStep(new Map(), draft({ urgent: true, title: "Restart the cloud" })).reports[0]).toMatchObject({ severity: "severe", urgency: "immediate", headline: "Needs you: Restart the cloud" });
  });

  it("gives no report for the same facts, and an update of the line for new facts", () => {
    const first = tellStep(new Map(), draft());
    const same = tellStep(first.lines, draft({ received: T0 + 1 }));
    expect(same.reports).toEqual([]);
    const changed = tellStep(first.lines, draft({ received: T0 + 2, text: "The deploy still waits." }));
    expect(changed.reports).toHaveLength(1);
    expect(changed.reports[0]).toMatchObject({ op: "update", references: [first.reports[0]?.key] });
  });

  it("cancels the open line needs-you of the same item and persons at a message done-you-asked", () => {
    const asked = tellStep(new Map(), draft());
    const done = tellStep(asked.lines, draft({ class: "done-you-asked", received: T0 + 5, text: "The restart is done." }));
    expect(done.reports.map((report) => [report.kind.code, report.op])).toEqual([
      ["system.tell.done-you-asked", "alert"],
      ["system.tell.needs-you", "cancel"],
    ]);
    const cancel = done.reports[1];
    expect(cancel).toMatchObject({ references: [asked.reports[0]?.key], severity: "minor", urgency: "past", response: ["allclear"], headline: "Needs you: AL-92. Done." });
    expect(cancel).not.toHaveProperty("expires");
    expect(checkWith(reportSchema, logged(cancel as TellReport)).tag).toBe("ok");
    expect([...done.lines.keys()]).toEqual([tellLineName("AL-92", "done-you-asked", ["operator" as PersonId])]);
  });

  it("does not cancel the line of another item or of other persons", () => {
    const asked = tellStep(new Map(), draft());
    expect(tellStep(asked.lines, draft({ class: "done-you-asked", item: "AL-93", received: T0 + 1 })).reports).toHaveLength(1);
    expect(tellStep(asked.lines, draft({ class: "done-you-asked", persons: ["other" as PersonId], received: T0 + 1 })).reports).toHaveLength(1);
  });

  it("reads the open lines from the live reports: the last report decides, and a cancel or an end closes the line", () => {
    const first = tellStep(new Map(), draft()).reports[0] as TellReport;
    const update = tellStep(new Map<string, TellLine>([[tellLineName("AL-92", "needs-you", ["operator" as PersonId]), { key: first.key, facts: "" }]]), draft({ received: T0 + 10, text: "Later text." })).reports[0] as TellReport;
    const other = { ...first, source: "nws" } as TellReport;
    const lines = tellLines([update, first, other].map(logged), T0 + 20);
    expect([...lines.values()]).toEqual([{ key: update.key, facts: expect.stringContaining("Later text.") }]);
    expect(tellLines([first].map(logged), T0 + TELL_LIFE).size).toBe(0);
    const done = tellStep(lines, draft({ class: "done-you-asked", received: T0 + 30 })).reports.map(logged);
    expect([...tellLines([first, update].map(logged).concat(done), T0 + 40).keys()]).toEqual([tellLineName("AL-92", "done-you-asked", ["operator" as PersonId])]);
  });
});

import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { readCap, type CapAlert, type CapRead } from "./read.ts";

/** Two FEMA IPAWS copies of one NWS flash flood warning in Texas: the first message and its update. */
const fixture = (name: string): string => readFileSync(new URL(`../fixtures/${name}`, import.meta.url), "utf8");
const FIRST = fixture("pairs/kewx-ff-w-0108-new.ipaws.xml");
const UPDATE = fixture("pairs/kewx-ff-w-0108-ext.ipaws.xml");

const CAP = 'xmlns="urn:oasis:names:tc:emergency:cap:1.2"';

/** This function gives the alert of a read, and fails the test for a text that the reader refused. */
function alertOf(read: CapRead): CapAlert {
  if (!read.ok) throw new Error(read.reason);
  return read.alert;
}

/** A small message with the required elements only, and the elements of the test in the info block. */
const message = (alert: string, info = ""): string =>
  `<alert ${CAP}><identifier>T-1</identifier><sender>test@example.org</sender><sent>2026-11-08T13:23:00-06:00</sent>` +
  `<status>Test</status><msgType>Alert</msgType><scope>Public</scope>${alert}` +
  `<info><category>Met</category><event>Test</event><urgency>Unknown</urgency><severity>Unknown</severity>` +
  `<certainty>Unknown</certainty>${info}</info></alert>`;

describe("readCap", () => {
  it("reads the elements of an IPAWS message, with no problem", () => {
    const read = readCap(FIRST);
    expect(read.ok && read.problems).toEqual([]);
    const alert = alertOf(read);
    expect(alert).toMatchObject({
      version: "1.2",
      identifier: "urn:oid:2.49.0.1.840.0.01008b96dac39f7a04ddcc53eb85874a9b3b68cb.001.1.IPAWS",
      sender: "w-nws.webmaster@noaa.gov",
      sent: "2026-11-08T13:23:00-06:00",
      status: "Actual",
      msgType: "Alert",
      scope: "Public",
      codes: ["IPAWSv1.0"],
      references: [],
    });
    expect(alert.infos.map((info) => info.language)).toEqual(["en-US", "es-US"]);
    const [english] = alert.infos;
    expect(english).toMatchObject({
      categories: ["Met"],
      event: "Flash Flood Warning",
      responseTypes: ["Avoid"],
      urgency: "Immediate",
      severity: "Severe",
      certainty: "Likely",
      senderName: "NWS Austin/San Antonio TX",
    });
    expect(english?.eventCodes).toContainEqual({ valueName: "SAME", value: "FFW" });
    expect(english?.parameters.find((pair) => pair.valueName === "VTEC")?.value).toBe("/O.NEW.KEWX.FF.W.0108.261108T1923Z-261109T0200Z/");
    expect(english?.areas).toHaveLength(1);
    expect(english?.areas[0]?.polygons[0]?.startsWith("30.29,-100.79 ")).toBe(true);
  });

  it("keeps each code as a text: a SAME code is not a number", () => {
    const area = alertOf(readCap(FIRST)).infos[0]?.areas[0];
    expect(area?.geocodes).toContainEqual({ valueName: "SAME", value: "048019" });
    expect(area?.geocodes).toContainEqual({ valueName: "UGC", value: "TXC019" });
  });

  it("reads the references of an update", () => {
    const alert = alertOf(readCap(UPDATE));
    expect(alert.msgType).toBe("Update");
    expect(alert.references).toEqual([
      {
        sender: "w-nws.webmaster@noaa.gov",
        identifier: "urn:oid:2.49.0.1.840.0.01008b96dac39f7a04ddcc53eb85874a9b3b68cb.001.1.IPAWS",
        sent: "2026-11-08T13:23:00-06:00",
      },
    ]);
  });

  it("refuses each cut of a message, and never gives a part as a whole message", () => {
    for (const end of [0, 1, 40, FIRST.indexOf("<info>"), FIRST.indexOf("<Signature"), FIRST.length - 1]) {
      expect(readCap(FIRST.slice(0, end)).ok, `a text of ${String(end)} characters`).toBe(false);
    }
  });

  it("refuses a text with a DOCTYPE", () => {
    const read = readCap(`<!DOCTYPE alert [<!ENTITY x "y">]>${message("")}`);
    expect(read).toEqual({ ok: false, reason: "the text has a DOCTYPE: a CAP message has no DTD" });
  });

  it("refuses a text on which the XML parser throws, and does not throw for any text", () => {
    // The validator of fast-xml-parser accepts these texts, and its parser throws on them. The second text has a CAP root.
    expect(readCap("<:/")).toEqual({ ok: false, reason: "the root element is absent, not a CAP alert" });
    expect(readCap(`<alert xmlns="urn:oasis:names:tc:emergency:cap:1.2"><:/</alert>`)).toMatchObject({ ok: false });
    fc.assert(
      fc.property(fc.string(), (text) => {
        expect(typeof readCap(text).ok).toBe("boolean");
      }),
    );
  });

  it("refuses a root element that is not an alert, and a namespace that is not CAP", () => {
    expect(readCap("<html><body>maintenance</body></html>")).toMatchObject({ ok: false });
    expect(readCap(message("").replace(CAP, 'xmlns="urn:example:other"'))).toEqual({
      ok: false,
      reason: "the namespace urn:example:other is not CAP 1.1 or CAP 1.2",
    });
  });

  it("reads CAP 1.1 and an alert with a prefix", () => {
    expect(alertOf(readCap(message("").replace(":cap:1.2", ":cap:1.1"))).version).toBe("1.1");
    const prefixed = '<cap:alert xmlns:cap="urn:oasis:names:tc:emergency:cap:1.2"><cap:identifier>P-1</cap:identifier></cap:alert>';
    const read = readCap(prefixed);
    expect(alertOf(read).identifier).toBe("P-1");
  });

  it("gives a note for an alert with no namespace, and takes CAP 1.2", () => {
    const read = readCap(message("").replace(` ${CAP}`, ""));
    expect(alertOf(read).version).toBe("1.2");
    expect(read.ok && read.problems).toContainEqual({
      path: "alert",
      message: "the alert does not declare its namespace: the reader takes CAP 1.2",
      fatal: false,
    });
  });

  it("gives a lossy problem for each absent required element, and a note for each unknown element", () => {
    const read = readCap(`<alert ${CAP}><identifier>T-2</identifier><colour>red</colour><info><event>Test</event></info></alert>`);
    const lossy = read.ok ? read.problems.filter((problem) => problem.lossy === true).map((problem) => problem.path) : [];
    const notes = read.ok ? read.problems.filter((problem) => problem.lossy !== true && !problem.fatal).map((problem) => problem.path) : [];
    expect(lossy).toEqual(expect.arrayContaining(["alert.sender", "alert.sent", "alert.scope", "alert.info[0].category", "alert.info[0].urgency"]));
    expect(notes).toEqual(["alert.colour"]);
    expect(alertOf(read).sent).toBe("");
  });

  it("gives en-US as the language of an info block with no language", () => {
    expect(alertOf(readCap(message(""))).infos[0]?.language).toBe("en-US");
  });

  it("splits the addresses and the incidents, with quotes for an item with spaces", () => {
    const alert = alertOf(readCap(message('<addresses>one "two three"</addresses><incidents>A-1 "Big Fire"</incidents>')));
    expect(alert.addresses).toEqual(["one", "two three"]);
    expect(alert.incidents).toEqual(["A-1", "Big Fire"]);
  });

  it("gives a problem for a reference that is not three parts", () => {
    const read = readCap(message("<references>test@example.org,T-0 bad</references>"));
    expect(alertOf(read).references).toEqual([]);
    expect(read.ok && read.problems.map((problem) => problem.path)).toEqual(["alert.references", "alert.references"]);
  });

  it("reads the entities of XML, and no other entity", () => {
    const info = alertOf(readCap(message("", "<headline>Rain &amp; wind &lt;now&gt; &#169;</headline>"))).infos[0];
    expect(info?.headline).toBe("Rain & wind <now> ©");
    const hex = alertOf(readCap(message("", "<headline>It&#x27;s &quot;near&quot; &apos;here&apos;</headline>"))).infos[0];
    expect(hex?.headline).toBe(`It's "near" 'here'`);
    // An HTML entity is not an entity of XML, so the reader keeps its text as written.
    const html = alertOf(readCap(message("", "<headline>a&nbsp;b &copy;</headline>"))).infos[0];
    expect(html?.headline).toBe("a&nbsp;b &copy;");
  });

  it("reads the areas, the circles and the resources", () => {
    const info = alertOf(
      readCap(
        message(
          "",
          "<resource><resourceDesc>map</resourceDesc><mimeType>image/png</mimeType><uri>https://example.org/map.png</uri><derefUri>AAAA</derefUri></resource>" +
            "<area><areaDesc>A circle</areaDesc><circle>32.9,-97.0 10</circle><altitude>100</altitude></area>",
        ),
      ),
    ).infos[0];
    expect(info?.resources).toEqual([{ resourceDesc: "map", mimeType: "image/png", uri: "https://example.org/map.png" }]);
    expect(info?.areas).toEqual([{ areaDesc: "A circle", polygons: [], circles: ["32.9,-97.0 10"], geocodes: [], altitude: "100" }]);
  });
});

import { readFileSync } from "node:fs";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { messageTime, monthOf, parseMessage, periodEnd, polewardOf, scaleLevel, statedScale, watchDays, type MessageText } from "./text.ts";

/** The real list of 16 November 2026 and the real archive samples (`fixtures/README.md`). */
const LIVE = JSON.parse(readFileSync(new URL("../fixtures/alerts-20261116T1553Z.json", import.meta.url), "utf8")) as { readonly product_id: string; readonly issue_datetime: string; readonly message: string }[];
const SAMPLES = JSON.parse(readFileSync(new URL("../fixtures/archive-samples.json", import.meta.url), "utf8")) as { readonly file: string; readonly message: string }[];
const MESSAGES = [...LIVE.map((entry) => entry.message), ...SAMPLES.map((sample) => sample.message)];

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** This function gives the parts of the real message with a code and a serial number. The test fails if the fixtures do not have it. */
const messageOf = (code: string, serial: number): MessageText => {
  const raw = MESSAGES.find((text) => text.includes(`Code: ${code}\r\nSerial Number: ${String(serial)}\r\n`) || text.includes(`Code: ${code}\nSerial Number: ${String(serial)}\n`));
  if (raw === undefined) throw new Error(`no message ${code}/${String(serial)} in the fixtures`);
  const parsed = parseMessage(raw);
  if (!parsed.ok) throw new Error(parsed.reason);
  return parsed.message;
};

describe("messageTime", () => {
  it("reads a time of a message as UTC", () => {
    expect(messageTime("2026 Nov 08 0203 UTC")).toBe(Date.UTC(2026, 10, 8, 2, 3));
    expect(messageTime(" 2024 May 11 1639 UTC ")).toBe(Date.UTC(2024, 4, 11, 16, 39));
  });

  it("gives undefined for a different format and for a time that is not in the calendar", () => {
    for (const text of ["", "2026 Nov 08", "2026 nov 08 0203 UTC", "2026 Nov 08 0203", "2026 Feb 30 0000 UTC", "2026 Nov 08 2400 UTC", "2026 Nov 08 0260 UTC", "2026 Foo 08 0203 UTC"]) {
      expect(messageTime(text)).toBeUndefined();
    }
  });

  it("reads each time that it writes", () => {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    fc.assert(
      fc.property(fc.integer({ min: Date.UTC(1990, 0, 1), max: Date.UTC(2100, 0, 1) }), (ms) => {
        const time = Math.floor(ms / 60_000) * 60_000;
        const date = new Date(time);
        const pad = (value: number) => String(value).padStart(2, "0");
        const text = `${String(date.getUTCFullYear())} ${months[date.getUTCMonth()]!} ${pad(date.getUTCDate())} ${pad(date.getUTCHours())}${pad(date.getUTCMinutes())} UTC`;
        expect(messageTime(text)).toBe(time);
      }),
    );
  });
});

describe("monthOf", () => {
  it("gives the number of each short English month name, and undefined for each other text", () => {
    expect(monthOf("Jan")).toBe(0);
    expect(monthOf("Dec")).toBe(11);
    expect(monthOf("jan")).toBeUndefined();
    expect(monthOf("January")).toBeUndefined();
  });
});

describe("periodEnd", () => {
  it("gives the end of the last period that starts at or before the time", () => {
    expect(periodEnd("1500-1800 UTC", Date.UTC(2026, 10, 8, 16, 0))).toBe(Date.UTC(2026, 10, 8, 18));
    expect(periodEnd("0000-0300", Date.UTC(2026, 10, 8, 2, 3))).toBe(Date.UTC(2026, 10, 8, 3));
    // A period of the day before: the time is after midnight.
    expect(periodEnd("2100-2400 UTC", Date.UTC(2026, 10, 9, 0, 30))).toBe(Date.UTC(2026, 10, 9));
  });

  it("gives undefined for a text that is not a period of three hours", () => {
    for (const text of ["", "1500-1900 UTC", "2400-0300 UTC", "1530-1830 UTC", "15-18"]) expect(periodEnd(text, 0)).toBeUndefined();
  });

  it("gives a period that holds the time, for each start and each time", () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 7 }), fc.integer({ min: Date.UTC(2000, 0, 1), max: Date.UTC(2100, 0, 1) }), (index, time) => {
        const start = index * 3;
        const pad = (value: number) => String(value).padStart(2, "0");
        const end = periodEnd(`${pad(start)}00-${pad(start + 3)}00 UTC`, time)!;
        expect(end - 3 * HOUR).toBeLessThanOrEqual(time);
        expect(time - (end - 3 * HOUR)).toBeLessThan(DAY);
        expect(new Date(end - 3 * HOUR).getUTCHours()).toBe(start);
      }),
    );
  });
});

describe("scaleLevel and statedScale", () => {
  it("reads a level of a NOAA scale at the start of a text", () => {
    expect(scaleLevel("G1 - Minor")).toEqual({ scale: "G", level: 1 });
    expect(scaleLevel(" S2 - Moderate")).toEqual({ scale: "S", level: 2 });
    expect(scaleLevel("R5")).toEqual({ scale: "R", level: 5 });
    for (const text of ["", "G0", "G6", "X1", "G12", "Minor G1"]) expect(scaleLevel(text)).toBeUndefined();
  });

  it("gives the scale that a real message states, from the field NOAA Scale", () => {
    expect(statedScale(messageOf("ALTK05", 2062))).toEqual({ scale: "G", level: 1 });
    expect(statedScale(messageOf("ALTPX2", 72))).toEqual({ scale: "S", level: 2 });
    expect(statedScale(messageOf("ALTXMF", 390))).toEqual({ scale: "R", level: 2 });
    // The summary of an S1 event tells the highest level that the event reached.
    expect(statedScale(messageOf("SUMPX1", 112))).toEqual({ scale: "S", level: 2 });
    expect(statedScale(messageOf("ALTK04", 2697))).toBeUndefined();
  });
});

describe("parseMessage", () => {
  it("parses each real message of the fixtures, with the code and the serial number of its text", () => {
    expect(MESSAGES).toHaveLength(LIVE.length + SAMPLES.length);
    for (const raw of MESSAGES) {
      const parsed = parseMessage(raw);
      expect(parsed.ok, raw.slice(0, 80)).toBe(true);
      if (!parsed.ok) continue;
      expect(raw).toContain(`Space Weather Message Code: ${parsed.message.code}`);
      expect(raw).toContain(`Serial Number: ${String(parsed.message.serial)}`);
      expect(parsed.message.text).not.toContain("\r");
    }
  });

  it("gives the head, the title and the fields of a K-index alert", () => {
    const message = messageOf("ALTK05", 2062);
    expect(message).toMatchObject({ code: "ALTK05", serial: 2062, issued: Date.UTC(2026, 10, 8, 2, 3), head: "ALERT", title: "Geomagnetic K-index of 5" });
    expect(message.fields.get("threshold reached")).toBe("2026 Nov 08 0203 UTC");
    expect(message.fields.get("synoptic period")).toBe("0000-0300");
    // The first line of a name gives its value.
    expect(message.fields.get("noaa scale")).toBe("G1 - Minor");
    expect(polewardOf(message)).toBe(60);
  });

  it("reads the head words with two words before the one-word heads", () => {
    expect(messageOf("WARK04", 5453)).toMatchObject({ head: "EXTENDED WARNING", title: "Geomagnetic K-index of 4 expected" });
    expect(messageOf("WARK04", 5453).fields.get("extension to serial number")).toBe("5452");
    expect(messageOf("ALTEF3", 3777).head).toBe("CONTINUED ALERT");
    expect(messageOf("ALTK05", 1653).head).toBe("CANCEL ALERT");
    expect(messageOf("WARPX1", 580).head).toBe("CANCEL WARNING");
  });

  it("gives the same parts for line breaks of CR LF and of LF", () => {
    const raw = LIVE.find((entry) => entry.message.includes("\r\n"))!.message;
    const lf = parseMessage(raw.replace(/\r\n/g, "\n"));
    const crlf = parseMessage(raw);
    expect(crlf).toEqual(lf);
  });

  it("gives the reason for a text that is not a message", () => {
    const raw = LIVE[0]!.message;
    expect(parseMessage("")).toEqual({ ok: false, reason: "the text does not start with the code, the serial number and the issue time" });
    expect(parseMessage(raw.replace("Issue Time: 2026 Nov 16 0628 UTC", "Issue Time: 2026 Feb 30 0628 UTC"))).toMatchObject({ ok: false, reason: expect.stringContaining("is not a time of the UTC calendar") });
    expect(parseMessage(raw.replace("CONTINUED ALERT:", "CONTINUED NOTE:"))).toEqual({ ok: false, reason: "the text has no head line, for example ALERT: or WARNING:" });
  });

  it("does not throw for each cut of a real message", () => {
    const raw = LIVE[0]!.message;
    fc.assert(
      fc.property(fc.integer({ min: 0, max: raw.length }), (length) => {
        const parsed = parseMessage(raw.slice(0, length));
        expect(typeof parsed.ok).toBe("boolean");
      }),
    );
  });
});

describe("polewardOf", () => {
  it("gives undefined for a latitude that is not between the equator and the pole", () => {
    const message = messageOf("ALTK05", 2062);
    expect(polewardOf({ ...message, text: message.text.replace("poleward of 60 degrees", "poleward of 90 degrees") })).toBeUndefined();
    expect(polewardOf({ ...message, text: message.text.replace("poleward of 60 degrees", "poleward of 0 degrees") })).toBeUndefined();
    expect(polewardOf(messageOf("ALTPX2", 72))).toBeUndefined();
  });
});

describe("watchDays", () => {
  it("gives each day of a real watch, with no level for a day with no storm", () => {
    expect(watchDays(messageOf("WATA20", 1138))).toEqual([
      { date: "2026-11-16", start: Date.UTC(2026, 10, 16), level: undefined },
      { date: "2026-11-17", start: Date.UTC(2026, 10, 17), level: { scale: "G", level: 1 } },
      { date: "2026-11-18", start: Date.UTC(2026, 10, 18), level: { scale: "G", level: 1 } },
    ]);
    expect(watchDays(messageOf("WATA99", 7))?.map((day) => `${day.date}:G${String(day.level?.level)}`)).toEqual(["2024-05-12:G5", "2024-05-13:G3", "2024-05-14:G1"]);
  });

  it("puts a day of January after a watch of December in the next year", () => {
    const message = messageOf("WATA20", 1138);
    const text = message.text.replace("Nov 16:", "Dec 31:").replace("Nov 17:", "Jan 01:").replace("Nov 18:", "Jan 02:");
    const days = watchDays({ ...message, issued: Date.UTC(2026, 11, 30, 13, 34), text });
    expect(days?.map((day) => day.date)).toEqual(["2026-12-31", "2027-01-01", "2027-01-02"]);
  });

  it("gives undefined for a message with no line of days, and for a day that is not in the calendar", () => {
    expect(watchDays(messageOf("ALTK05", 2062))).toBeUndefined();
    const message = messageOf("WATA20", 1138);
    expect(watchDays({ ...message, text: message.text.replace("Nov 17:", "Nov 31:") })).toBeUndefined();
  });
});

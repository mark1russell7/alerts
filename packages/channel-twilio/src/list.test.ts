import type { ChannelId, PersonId, Recipient } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { CHANNEL_ID } from "./descriptor.ts";
import { OUTAGE_CAP_OUTAGES, OUTAGE_CAP_WINDOW, OUTAGE_MESSAGE, OUTAGE_REPEATS, OUTAGE_RING_SECONDS, outageListOf } from "./list.ts";
import { outageListSchema } from "./outage.ts";

// Fake numbers only: 555-0100 to 555-0199 are numbers of fiction.
const p1 = "person-1" as PersonId;
const p2 = "person-2" as PersonId;
const pushover = "pushover" as ChannelId;

function recipient(person: PersonId, to?: string): Recipient {
  return {
    watch: { person, places: [], rules: [] },
    policies: [],
    addresses: { pushover: { user: "fake-user-value" }, ...(to === undefined ? {} : { [CHANNEL_ID]: { to } }) },
  };
}

const RECIPIENTS = [recipient(p1, "+15555550123"), recipient(p2, "+15555550124")];
const OUTAGE = {
  people: [
    { person: p1, chain: { steps: [CHANNEL_ID, CHANNEL_ID, CHANNEL_ID] } },
    { person: p2, chain: { steps: [CHANNEL_ID, CHANNEL_ID] } },
  ],
};

describe("outageListOf", () => {
  it("gives the number of each person on the channel of the calls, and the defaults", () => {
    const { list, problems } = outageListOf(OUTAGE, RECIPIENTS);
    expect(problems).toEqual([]);
    expect(list).toEqual({
      version: expect.stringMatching(/^[0-9a-f]{16}$/u),
      message: OUTAGE_MESSAGE,
      people: [
        { person: p1, to: "+15555550123", chain: { steps: [CHANNEL_ID, CHANNEL_ID, CHANNEL_ID] } },
        { person: p2, to: "+15555550124", chain: { steps: [CHANNEL_ID, CHANNEL_ID] } },
      ],
      repeats: OUTAGE_REPEATS,
      ringSeconds: OUTAGE_RING_SECONDS,
      maxCalls: OUTAGE_CAP_OUTAGES * 5,
      capWindow: OUTAGE_CAP_WINDOW,
    });
    // The Function reads the list with this schema.
    expect(outageListSchema.safeParse(JSON.parse(JSON.stringify(list))).success).toBe(true);
  });

  it("gives the same version for the same list, and a new version for each change", () => {
    const version = (options = {}, outage = OUTAGE, recipients = RECIPIENTS) => outageListOf(outage, recipients, options).list.version;
    expect(version()).toBe(version());
    // The order of the people is the order of the calls, so it is a change.
    const changes = [
      version({ message: "Another message." }),
      version({ ringSeconds: 30 }),
      version({ voice: "Polly.Joanna" }),
      version({ texts: { prompt: "Press 1." } }),
      version({}, { people: [...OUTAGE.people].reverse() }),
      version({}, OUTAGE, [recipient(p1, "+15555550125"), RECIPIENTS[1]!]),
    ];
    expect(new Set([version(), ...changes]).size).toBe(changes.length + 1);
  });

  it("keeps the options, and gives the problems of the values of the list", () => {
    const { list, problems } = outageListOf(OUTAGE, RECIPIENTS, { repeats: 9, maxCalls: 2, capWindow: 0, language: "en-US", texts: { confirmed: "" } });
    expect(list).toMatchObject({ repeats: 9, maxCalls: 2, capWindow: 0, language: "en-US", texts: { confirmed: "" } });
    expect(problems).toEqual([
      "The text confirmed is empty.",
      "The repeats are not a whole number from 1 to 5.",
      "The time of the cap is not more than 0.",
      "The cap of 2 calls is below the 5 calls of one outage, so the cap stops tries of one outage.",
    ]);
  });

  it("names a person with no recipient, no number or a step on another channel, and no problem holds a number", () => {
    const { problems } = outageListOf(
      {
        people: [
          { person: p1, chain: { steps: [CHANNEL_ID, pushover] } },
          { person: p2, chain: { steps: [CHANNEL_ID] } },
          { person: "person-9" as PersonId, chain: { steps: [CHANNEL_ID] } },
        ],
      },
      [RECIPIENTS[0]!, recipient(p2)],
    );
    expect(problems[0]).toBe("The outage call names the person person-9, and no recipient has that id.");
    expect(problems).toContain("Step 1 of the person person-1 uses the channel pushover. The outage call makes only calls on twilio-call.");
    expect(problems.filter((problem) => problem.startsWith("The person person-2: "))).toHaveLength(1);
    expect(problems.filter((problem) => problem.startsWith("The person person-9: "))).toHaveLength(1);
    expect(problems.join("\n")).not.toMatch(/555/u);
  });

  it("gives a cap of 1 call for a list with no step, and the problem of a list with no person", () => {
    const { list, problems } = outageListOf({ people: [] }, RECIPIENTS);
    expect(list.maxCalls).toBe(1);
    expect(problems).toEqual(["The list has no person, so no outage call reaches a person."]);
  });
});

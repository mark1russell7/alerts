import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { kindCodeSchema, kindSchema, nodeKeySchema, subjectWatchSchema } from "./schemas.ts";

// This file gives the taxonomy one old code, `met.twister`. The real alias map is empty at this time.
vi.mock("./taxonomy.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./taxonomy.ts")>();
  const aliases = { "met.twister": "met.tornado" };
  return { ...original, KIND_ALIASES: aliases, canonicalKind: (code: string) => original.canonicalKind(code, aliases) };
});

describe("an old code of the taxonomy", () => {
  it("parses to its new code before the check of the taxonomy", () => {
    expect(kindCodeSchema.parse("met.twister")).toBe("met.tornado");
    expect(kindCodeSchema.parse("system.coverage.met.twister")).toBe("system.coverage.met.tornado");
    expect(kindCodeSchema.parse("met.tornado")).toBe("met.tornado");
    expect(kindCodeSchema.safeParse("met.twisters").success).toBe(false);
    expect(kindSchema.parse({ code: "met.twister", label: "Tornado" })).toEqual({ code: "met.tornado", label: "Tornado" });
  });

  it("parses to its new code in the id of a topic and in the key of a topic node", () => {
    expect(subjectWatchSchema.parse({ system: "topic", id: "met.twister" })).toEqual({ system: "topic", id: "met.tornado" });
    expect(subjectWatchSchema.parse({ system: "place", id: "met.twister" })).toEqual({ system: "place", id: "met.twister" });
    expect(subjectWatchSchema.parse({ system: "topic" })).toEqual({ system: "topic" });
    expect(nodeKeySchema.parse("topic:met.twister")).toBe("topic:met.tornado");
    expect(nodeKeySchema.parse("place:met.twister")).toBe("place:met.twister");
    expect(nodeKeySchema.safeParse("topic:met.twisters").success).toBe(false);
  });

  it("keeps the JSON Schema of the kind code, because the change of the code is not a transform", () => {
    expect(z.toJSONSchema(kindCodeSchema)).toMatchObject({ type: "string" });
    expect(z.toJSONSchema(nodeKeySchema)).toMatchObject({ type: "string" });
  });
});

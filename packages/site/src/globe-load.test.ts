import type { MapPayload } from "@mark1russell7/alerts";
import { beforeEach, describe, expect, it } from "vitest";
import { GLOBE_CODE_MARK, loadGlobe, type GlobeModule } from "./globe-load.ts";
import type { GlobeElements, LiveGlobe } from "./globe-stage.ts";

/** An element of a page, with only the parts that the load uses. */
interface Part {
  hidden: boolean;
  disabled: boolean;
  readonly attributes: Map<string, string>;
  setAttribute(name: string, value: string): void;
  removeAttribute(name: string): void;
}

const part = (): Part => {
  const attributes = new Map<string, string>();
  return {
    hidden: true,
    disabled: false,
    attributes,
    setAttribute: (name, value) => void attributes.set(name, value),
    removeAttribute: (name) => void attributes.delete(name),
  };
};

/** This function makes the elements of a page as they are in the HTML: the box and the tools of the globe are hidden. */
const page = (): { readonly elements: GlobeElements; readonly box: Part; readonly tools: Part; readonly whole: Part } => {
  const [box, tools, words, whole] = [part(), part(), part(), part()];
  whole.hidden = false;
  return { elements: { box, tools, words, whole } as unknown as GlobeElements, box, tools, whole };
};

const payload = { format: "alerts-map/1", at: 0, view: { incidents: [], places: [], unshaped: [] }, basemap: [] } as unknown as MapPayload;
const select = (): void => undefined;

/** This function waits until each promise that is ready has its result. */
const settled = (): Promise<void> => new Promise((done) => setTimeout(done, 0));

describe("loadGlobe", () => {
  beforeEach(() => {
    performance.clearMarks(GLOBE_CODE_MARK);
  });

  it("loads nothing for a browser that cannot show the globe, and gives each payload to the flat map", async () => {
    const { elements, box, tools, whole } = page();
    let loads = 0;
    let changes = 0;
    const globe = loadGlobe(elements, select, {}, () => void (changes += 1), {
      supported: () => false,
      load: () => {
        loads += 1;
        return Promise.reject(new Error("the test loads nothing"));
      },
    });
    expect(globe.show(payload, undefined, false)).toBe(false);
    await settled();
    expect(globe.show(payload, "a", true)).toBe(false);
    expect(loads).toBe(0);
    expect(changes).toBe(0);
    expect(performance.getEntriesByName(GLOBE_CODE_MARK, "mark")).toHaveLength(0);
    // The page stays as its HTML has it.
    expect([box.hidden, tools.hidden, whole.disabled]).toEqual([true, true, false]);
    expect(box.attributes.size).toBe(0);
  });

  it("keeps the place of the picture while the code is on its way, then gives each payload to the globe", async () => {
    const { elements, box, tools, whole } = page();
    const shown: (string | undefined)[] = [];
    const started: unknown[][] = [];
    let changes = 0;
    let arrive: (module: GlobeModule) => void = () => undefined;
    const real: LiveGlobe = {
      show: (_payload, selected) => {
        shown.push(selected);
        return selected !== "no shape";
      },
    };
    const options = { regionNames: true };
    const globe = loadGlobe(elements, select, options, () => void (changes += 1), {
      supported: () => true,
      load: () => new Promise((done) => void (arrive = done)),
    });

    // The code is on its way: the box is in the page with no picture, and the button has no effect.
    expect(performance.getEntriesByName(GLOBE_CODE_MARK, "mark")).toHaveLength(1);
    expect(globe.show(payload, undefined, false)).toBe(true);
    expect([box.hidden, tools.hidden, whole.disabled]).toEqual([false, false, true]);
    expect(box.attributes.get("aria-busy")).toBe("true");
    expect(changes).toBe(0);
    expect(shown).toEqual([]);

    arrive({
      startGlobe: (...given) => {
        started.push(given);
        return real;
      },
    });
    await settled();
    // The page draws again one time, and the globe gets what the page gave to the load.
    expect(changes).toBe(1);
    expect(started).toEqual([[elements, select, options]]);
    expect(whole.disabled).toBe(false);
    expect(box.attributes.has("aria-busy")).toBe(false);
    expect(globe.show(payload, "a", true)).toBe(true);
    expect(globe.show(payload, "no shape", false)).toBe(false);
    expect(shown).toEqual(["a", "no shape"]);
  });

  it("moves the camera at the first picture to an incident that a person selected before the code came", async () => {
    /** This function gives the moves that the globe gets, for the pictures that a page asks for before and after the code comes. */
    const moves = async (before: readonly (readonly [string | undefined, boolean])[], after: readonly (readonly [string | undefined, boolean])[]): Promise<boolean[]> => {
      const got: boolean[] = [];
      let arrive: (module: GlobeModule) => void = () => undefined;
      const real: LiveGlobe = { show: (_payload, _selected, move) => got.push(move) > 0 };
      const globe = loadGlobe(page().elements, select, {}, () => undefined, { supported: () => true, load: () => new Promise((done) => void (arrive = done)) });
      for (const [selected, move] of before) globe.show(payload, selected, move);
      arrive({ startGlobe: () => real });
      await settled();
      for (const [selected, move] of after) globe.show(payload, selected, move);
      return got;
    };
    // The page draws again with no move when the code comes. The load gives the move one time.
    expect(await moves([["a", true]], [["a", false], ["a", false]])).toEqual([true, false]);
    // A step selected a different incident after that: no move.
    expect(await moves([["a", true], ["b", false]], [["b", false]])).toEqual([false]);
    // A second selection of the same incident removed the selection: no move.
    expect(await moves([["a", true], [undefined, true]], [[undefined, false]])).toEqual([false]);
    // A selection that a step made did not ask for a move.
    expect(await moves([["a", false]], [["a", false]])).toEqual([false]);
    // A move that the page asks for after the code came goes to the globe as it is.
    expect(await moves([], [["a", false], ["b", true]])).toEqual([false, true]);
  });

  it("gives each payload to the flat map when the code does not come", async () => {
    const { elements, box, tools, whole } = page();
    let changes = 0;
    const globe = loadGlobe(elements, select, {}, () => void (changes += 1), {
      supported: () => true,
      load: () => Promise.reject(new Error("the file did not come")),
    });
    expect(globe.show(payload, undefined, false)).toBe(true);
    await settled();
    expect(changes).toBe(1);
    expect(globe.show(payload, undefined, false)).toBe(false);
    expect([box.hidden, tools.hidden, whole.disabled]).toEqual([true, true, false]);
    expect(box.attributes.has("aria-busy")).toBe(false);
  });

  it("gives each payload to the flat map when the globe does not start", async () => {
    const { elements } = page();
    let changes = 0;
    const globe = loadGlobe(elements, select, {}, () => void (changes += 1), {
      supported: () => true,
      load: () =>
        Promise.resolve({
          startGlobe: (): LiveGlobe => {
            throw new Error("the globe does not start");
          },
        }),
    });
    await settled();
    expect(changes).toBe(1);
    expect(globe.show(payload, undefined, false)).toBe(false);
  });
});

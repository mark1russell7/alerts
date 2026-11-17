/**
 * The probe of the home page. The site check of the Pages workflow starts it in a browser at each width, before the
 * deploy. A failed check stops the deploy.
 *
 * The probe drives the replay as a reader does. It reads the levels, the incidents and the map that each step draws.
 *
 * The map is a globe in a browser with WebGL 2, and a flat map of the same data in each other browser. The probe
 * reads the picture that it finds. The flat map has an element for each part. The globe is one canvas, so the probe
 * reads the names above it. It also moves a pointer on the globe, and reads the words of the part below the pointer.
 *
 * The site check reads this TypeScript file directly. It removes the types, and it starts the result as the body of
 * an async function.
 */

// The site check gives these helpers to the probe.
declare const check: (name: string, ok: unknown, detail?: unknown) => boolean;
declare const until: <T>(fn: () => T | Promise<T>, ms?: number) => Promise<T>;
declare const $: (selector: string) => Element | null;
declare const $$: (selector: string) => Element[];
declare const click: (target: string | Element) => void;
declare const wait: (ms: number) => Promise<void>;

const count = (level: string): number => Number($(`.lane[data-level="${level}"] .count`)?.textContent ?? "-1");
const current = (): string => $(".rail .step[aria-current]")?.getAttribute("data-step") ?? "";
const goTo = async (step: number): Promise<boolean> => {
  click(`.rail .step[data-step="${String(step)}"]`);
  return until(() => current() === String(step));
};
const title = (): string => $("#step-title")?.textContent ?? "";
const state = (source: string): string => $(`#sources .source[data-source="${source}"]`)?.getAttribute("data-state") ?? "";
const fits = (): boolean => document.documentElement.scrollWidth <= window.innerWidth;
/** This function waits for `count` frames of the page. Thus a wait does not change with the speed of the browser. */
const frames = (count: number): Promise<void> =>
  new Promise((done) => {
    const next = (left: number): void => {
      if (left <= 0) done();
      else requestAnimationFrame(() => next(left - 1));
    };
    next(count);
  });

// The map. The probe finds the picture one time: a page does not change between the globe and the flat map.
const picture = (await until(() => $("#globe canvas") ?? $("#map svg.live-map"), 15000)) as Element | null;
const canvas = $("#globe canvas");
const FLOOD = "Flash Flood Warning: Life-safety";
const WIND = "High Wind Warning: Notice";
/** The words of the map for a reader of the screen. The two pictures have the same words. */
const summary = (): string => ($("#globe canvas") ?? $("#map svg.live-map"))?.getAttribute("aria-label") ?? "";
/** The count of the live incidents that the map tells. */
const live = (): number => Number(/Live incidents: (\d+)\./.exec(summary())?.[1] ?? "-1");
/** The names on the globe that are in the picture. */
const names = (): Element[] => $$("#globe .visuals-label").filter((name) => !name.classList.contains("visuals-label-off"));
const texts = (list: readonly Element[]): string[] => list.map((one) => one.textContent ?? "");
/** The names of the homes on the map. On the globe, the kind of the name of a home starts with `pin-`. */
const homes = (): string[] => texts(canvas === null ? $$("#map text.place-label") : names().filter((name) => (name.getAttribute("data-kind") ?? "").startsWith("pin-")));
/** The names of the zones on the map. */
const zones = (): string[] => texts(canvas === null ? $$("#map text.region-label") : names().filter((name) => name.getAttribute("data-kind") === "zone"));
/** The count of the homes that the map shows at a level. */
const homesAt = (level: string): number => (canvas === null ? $$(`#map g.pin.level-${level}`) : names().filter((name) => name.getAttribute("data-kind") === `pin-${level}`)).length;
/** The line of the page that tells the part of the globe below the pointer. */
const words = (): string => $("#words")?.textContent ?? "";
const send = (type: string, x: number, y: number, buttons: number): void => {
  const button = type === "pointermove" ? -1 : 0;
  canvas?.dispatchEvent(new PointerEvent(type, { pointerId: 1, pointerType: "mouse", isPrimary: true, bubbles: true, cancelable: true, clientX: x, clientY: y, button, buttons }));
};
/** This function moves the pointer to a position of the globe, as parts of its width and its height. It gives the words of the part there. */
const point = (across: number, down: number): string => {
  const box = canvas?.getBoundingClientRect();
  if (box === undefined) return "";
  send("pointermove", box.left + box.width * across, box.top + box.height * down, 0);
  return words();
};
/** This function presses and releases the pointer at a position of the globe. */
const press = (across: number, down: number): void => {
  const box = canvas?.getBoundingClientRect();
  if (box === undefined) return;
  const [x, y] = [box.left + box.width * across, box.top + box.height * down];
  send("pointermove", x, y, 0);
  send("pointerdown", x, y, 1);
  send("pointerup", x, y, 0);
};
/**
 * This function gives the position of a name of a zone across the globe: 0 at the left edge and 1 at the right edge.
 * The middle of the name of a zone is on the middle of the zone, so the name shows where the camera looks.
 */
const across = (zone: string): number => {
  const frame = canvas?.getBoundingClientRect();
  const box = names()
    .find((name) => name.textContent === zone)
    ?.getBoundingClientRect();
  return frame === undefined || box === undefined ? -1 : (box.left + box.width / 2 - frame.left) / frame.width;
};
/**
 * This function waits until the name of a zone is in the picture and does not move. It gives the position of the name.
 * The globe puts the names of a new step in the picture at its next frame, and a slow browser gives that frame late.
 */
const still = async (zone: string): Promise<number> => {
  let last = -1;
  await until(async () => {
    const before = across(zone);
    await frames(2);
    last = across(zone);
    return last >= 0 && Math.abs(last - before) < 0.001;
  }, 8000);
  return last;
};
/**
 * This function moves the pointer to the dot of a home on the globe, and gives the words of the home.
 * The name of a home is next to its dot, on one of its four sides. So the probe looks on each side of the name.
 */
const homeWords = (home: string): string => {
  const box = names()
    .find((name) => name.textContent === home)
    ?.getBoundingClientRect();
  if (box === undefined) return "";
  const [x, y] = [box.left + box.width / 2, box.top + box.height / 2];
  for (const far of [6, 10, 14, 18, 22]) {
    const sides: (readonly [number, number])[] = [
      [box.left - far, y],
      [box.right + far, y],
      [x, box.top - far],
      [x, box.bottom + far],
    ];
    for (const [px, py] of sides) {
      send("pointermove", px, py, 0);
      if (words().startsWith(`${home}:`)) return words();
    }
  }
  return "";
};
/** The count of the homes that the map marks with a gap of the coverage. The mark is a ring on the flat map, and the words of the home on the globe. */
const gaps = async (): Promise<number> => {
  if (canvas === null) return $$("#map circle.gap.short").length;
  // The globe puts the names of a new step at its next frame.
  await frames(3);
  await until(() => homes().length === 2);
  const found = ["Home of A", "Home of B"].filter((home) => homeWords(home).includes("The coverage is short for"));
  send("pointerleave", 0, 0, 0);
  return found.length;
};

// The first view: the step at index 4, with the wind incident and the flood incident.
check("the page shows the map as a globe or as a flat map", picture, "The map has no canvas and no SVG.");
check("the map has a height of 150 pixels or more", (picture?.getBoundingClientRect().height ?? 0) >= 150, picture?.getBoundingClientRect().height);
check("the rail shows the 10 steps", await until(() => $$(".rail .step").length === 10), $$(".rail .step").length);
// The rail and the label count the steps from 1. The data-step indexes count from 0.
const steps = $$(".rail .step").length;
check("the first view is the step at index 4", current() === "4", current());
check("the label of the first view is Step 5 of 10", title().startsWith("Step 5 of 10: "), title());
check("the total of the label is the count of the rail buttons", title().startsWith(`Step 5 of ${String(steps)}: `), [title(), steps]);
check(
  "the rail buttons show the numbers 1 to N",
  $$(".rail .step .number").map((one) => one.textContent).join(" ") === Array.from({ length: steps }, (_, at) => String(at + 1)).join(" "),
);
check("both sources are healthy before the outage", state("nws-api") === "healthy" && state("radio-x") === "healthy", [state("nws-api"), state("radio-x")]);
check("each coverage is met before the outage", $$("#sources .coverage li.short").length === 0 && $$("#sources .coverage li.met").length === 4);
check("no system report before the outage", $$("#sources .system-card").length === 0);
check("two people are at life-safety for the flood", count("life-safety") === 2, count("life-safety"));
check("the rule of Person B keeps the wind at notice", count("notice") === 1, count("notice"));
check("the map has the two live incidents", live() === 2, summary());
check("the map names the two homes", await until(() => homes().sort().join(", ") === "Home of A, Home of B"), homes());
check("both homes are at life-safety on the map", homesAt("life-safety") === 2, homesAt("life-safety"));
if (canvas === null) {
  check("the flat map names the four zones", zones().join(", ") === "Lake Shore, Harbor, Valley, Ridge", zones());
  check("the flat map draws the flood above the wind", $$("#map g.incident").map((one) => one.getAttribute("class")).join(", ") === "incident level-notice dim, incident level-life-safety selected");
  check("the flat map draws the polygon of the flood and the zones of its codes", $$("#map g.incident.level-life-safety path.area").length >= 5, $$("#map g.incident.level-life-safety path.area").length);
} else {
  // A name of a zone goes out of the picture when a name of a home needs its position. A wide picture has space for each name.
  check("the globe names the zones", zones().length >= 1 && zones().every((zone) => ["Lake Shore", "Harbor", "Valley", "Ridge"].includes(zone)), zones());
  const frame = canvas.getBoundingClientRect();
  const out = names()
    .map((name) => name.getBoundingClientRect())
    .filter((box) => box.left < frame.left - 1 || box.top < frame.top - 1 || box.right > frame.right + 1 || box.bottom > frame.bottom + 1);
  check("each name is in the picture of the globe", out.length === 0, out.map((box) => [box.left, box.top, box.right, box.bottom]));
  // The flood covers each zone at this step, and the highest level is on top.
  check("the pointer finds the flood at the middle of the globe", await until(() => point(0.5, 0.5) === FLOOD), words());
  send("pointerleave", 0, 0, 0);
  check("the line of the globe is empty with no pointer in the picture", words() === "", words());
}
check("the map function found no problem", $("#message [data-problems]")?.getAttribute("data-problems") === "0");
check("the flood incident shows merge rules 1 and 2", $$(".incident-card .join").length === 3, $$(".incident-card .join").length);

// The next step: the API stops, and the flood is short of independent sources at each home.
click("#next");
check("Next goes to the step at index 5", await until(() => current() === "5"), current());
check("the label of the outage is Step 6 of 10", title().startsWith("Step 6 of 10: "), title());
check("the API is failing and the radio is healthy", state("nws-api") === "failing" && state("radio-x") === "healthy", [state("nws-api"), state("radio-x")]);
check("the flood is short at the two homes", $$('#sources .coverage li.short[data-kind="met.flood.flash"]').length === 2, $$("#sources .coverage li.short").length);
check("the core shows 3 live system reports", $$("#sources .system-card:not(.ended)").length === 3, $$("#sources .system-card").length);
check("each person is urgent for the gap at the home", count("urgent") === 2, count("urgent"));
check("Person A gets the health report at notice", count("notice") === 2, count("notice"));
check("the flood stays at life-safety", count("life-safety") === 2, count("life-safety"));
check("the map has the three system reports as live incidents", live() === 5, summary());
check("the map marks a gap of the coverage at the two homes", await until(async () => (await gaps()) === 2), words());
check("the outage step fits the width of the page", fits(), [document.documentElement.scrollWidth, window.innerWidth]);

// The API is back: the core cancels each system report.
await goTo(6);
check("the API is healthy again", state("nws-api") === "healthy", state("nws-api"));
check("each coverage is met again", $$("#sources .coverage li.short").length === 0);
check("each system report ended", $$("#sources .system-card.ended").length === 3 && live() === 2, summary());
check("the map marks no gap of the coverage", (await gaps()) === 0);
check("nobody is urgent after the cancel", count("urgent") === 0, count("urgent"));

// The test message reaches nobody.
await goTo(7);
check("the test message is an incident with its status", $$(".incident-card .chip.test").length === 1);
check("the test message adds no level", count("life-safety") === 2 && count("notice") === 1);

// The all clear ends the flood.
await goTo(8);
check("the cancel ends the flood: nobody is at life-safety", count("life-safety") === 0, count("life-safety"));
check("the flood card shows that it ended", $$(".incident-card.ended").length === 2, $$(".incident-card.ended").length);

// The start: no incident.
await goTo(0);
check("the step at index 0 has no incident", $$(".incident-card").length === 0 && live() === 0, summary());
check("the map shows the homes with no level", await until(() => homesAt("none") === 2), homesAt("none"));
check("the first step reads Step 1 of N", title().startsWith(`Step 1 of ${String(steps)}: `), title());
check("Back is off at the start", ($("#back") as HTMLButtonElement | null)?.disabled === true);

// A selection. At the step at index 2 the flood is in the west and the wind is in the east. The step selects the flood: the incident of its new message.
await goTo(2);
const cards = $$(".incident-card");
const anchors = cards.map((card) => card.getAttribute("data-anchor"));
const chosen = (): (string | null)[] => $$(".incident-card.selected").map((card) => card.getAttribute("data-anchor"));
check("the step at index 2 has two incidents", cards.length === 2, cards.length);
check("the step selects the flood", chosen().join() === String(anchors[1]), chosen());
if (canvas === null) {
  // The flat map dims each other incident, and an incident of the map takes a click.
  click(cards[0]!);
  check("a selected card selects its incident on the map", await until(() => $$("#map g.incident.selected").length === 1 && $$("#map g.incident.dim").length === 1));
  check("the map selects the incident of the card", $("#map g.incident.selected")?.getAttribute("data-anchor") === anchors[0], anchors);
  // An element of an SVG has no method `click`, so the probe sends the event.
  $("#map g.incident.dim")?.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  check("an incident of the map selects its card", await until(() => chosen().join() === String(anchors[1])), chosen());
} else {
  // The globe shows each zone: the flood is in its west part, and the zone Lake Shore of the wind is in its east part.
  const west = await until(() => point(0.3, 0.5) === FLOOD);
  const before = await still("Lake Shore");
  check("the first picture of the globe shows each zone", west && before > 0.6, [words(), before]);
  // A card moves the camera to its incident. Then the middle of the wind is the middle of the picture.
  click(cards[0]!);
  const moved = await until(async () => {
    await wait(100);
    return Math.abs(across("Lake Shore") - 0.5) < 0.06 && point(0.5, 0.5) === WIND;
  }, 8000);
  check("a selected card moves the camera of the globe to its incident", moved, [across("Lake Shore"), words()]);
  // The button shows each zone again, and it keeps the selection.
  click("#whole");
  const back = await until(async () => {
    await wait(100);
    return Math.abs(across("Lake Shore") - before) < 0.02 && point(0.3, 0.5) === FLOOD;
  }, 8000);
  check("the button Show all moves the camera back", back && chosen().join() === String(anchors[0]), [across("Lake Shore"), before, words(), chosen()]);
  press(0.3, 0.5);
  check("a press on an incident of the globe selects its card", await until(() => chosen().join() === String(anchors[1])), chosen());
  // The corner of the picture is the sea, with no incident.
  press(0.01, 0.01);
  check("a press on no incident removes the selection", await until(() => chosen().length === 0), [chosen(), words()]);
  send("pointerleave", 0, 0, 0);
}

// Play starts the replay, and a second press stops it.
click("#play");
check("Play changes to Pause", await until(() => $("#play")?.textContent === "Pause"));
click("#play");
check("Pause stops the replay", await until(() => $("#play")?.textContent === "Play"));

// The probe leaves the page at its first view.
await goTo(4);
check("the probe ends at the step at index 4", current() === "4");

export {};

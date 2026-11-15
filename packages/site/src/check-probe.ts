/**
 * The probe of the home page. The site check of the Pages workflow starts it in a browser at each width, before the
 * deploy. A failed check stops the deploy.
 *
 * The probe drives the replay as a reader does. It reads the levels, the incidents and the map that each step draws.
 * The site check reads this TypeScript file directly. It removes the types, and it starts the result as the body of
 * an async function.
 */

// The site check gives these helpers to the probe.
declare const check: (name: string, ok: unknown, detail?: unknown) => boolean;
declare const until: <T>(fn: () => T | Promise<T>, ms?: number) => Promise<T>;
declare const $: (selector: string) => Element | null;
declare const $$: (selector: string) => Element[];
declare const click: (target: string | Element) => void;

const count = (level: string): number => Number($(`.lane[data-level="${level}"] .count`)?.textContent ?? "-1");
const current = (): string => $(".rail .step[aria-current]")?.getAttribute("data-step") ?? "";
const goTo = async (step: number): Promise<boolean> => {
  click(`.rail .step[data-step="${String(step)}"]`);
  return until(() => current() === String(step));
};

// The first view: step 4, with the wind incident and the flood incident.
check("the rail shows the 8 steps", await until(() => $$(".rail .step").length === 8), $$(".rail .step").length);
check("the first view is step 4", current() === "4", current());
check("two people are at life-safety for the flood", count("life-safety") === 2, count("life-safety"));
check("the rule of Person B keeps the wind at notice", count("notice") === 1, count("notice"));
check("the map draws the two live incidents", $$("#map g.incident").length === 2, $$("#map g.incident").length);
check("the map draws the shape of the flood", $$("#map g.incident path.shape").length >= 1, $$("#map g.incident path.shape").length);
check("both homes are at life-safety on the map", $$("#map g.pin.level-life-safety").length === 2, $$("#map g.pin.level-life-safety").length);
check("the map function found no problem", $("#message [data-problems]")?.getAttribute("data-problems") === "0");
check("the flood incident shows merge rules 1 and 2", $$(".incident-card .join").length === 3, $$(".incident-card .join").length);

// The next step: the test message reaches nobody.
click("#next");
check("Next goes to step 5", await until(() => current() === "5"), current());
check("the test message is an incident with its status", $$(".incident-card .chip.test").length === 1);
check("the test message adds no level", count("life-safety") === 2 && count("notice") === 1);

// The all clear ends the flood.
await goTo(6);
check("the cancel ends the flood: nobody is at life-safety", count("life-safety") === 0, count("life-safety"));
check("the flood card shows that it ended", $$(".incident-card.ended").length === 2, $$(".incident-card.ended").length);

// The start: no incident.
await goTo(0);
check("step 0 has no incident", $$(".incident-card").length === 0 && $$("#map g.incident").length === 0);
check("Back is off at the start", ($("#back") as HTMLButtonElement | null)?.disabled === true);

// A selection dims the other incidents on the map.
await goTo(2);
const cards = $$(".incident-card");
check("step 2 has two incidents", cards.length === 2, cards.length);
click(cards[0]!);
check("a selected card selects its incident on the map", await until(() => $$("#map g.incident.selected").length === 1 && $$("#map g.incident.dim").length === 1));

// Play starts the replay, and a second press stops it.
click("#play");
check("Play changes to Pause", await until(() => $("#play")?.textContent === "Pause"));
click("#play");
check("Pause stops the replay", await until(() => $("#play")?.textContent === "Play"));

// The probe leaves the page at its first view.
await goTo(4);
check("the probe ends at step 4", current() === "4");

export {};

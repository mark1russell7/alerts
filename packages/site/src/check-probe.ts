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
const title = (): string => $("#step-title")?.textContent ?? "";
const state = (source: string): string => $(`#sources .source[data-source="${source}"]`)?.getAttribute("data-state") ?? "";
const fits = (): boolean => document.documentElement.scrollWidth <= window.innerWidth;

// The first view: the step at index 4, with the wind incident and the flood incident.
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
check("the map draws the two live incidents", $$("#map g.incident").length === 2, $$("#map g.incident").length);
check("the map draws the shape of the flood", $$("#map g.incident path.shape").length >= 1, $$("#map g.incident path.shape").length);
check("both homes are at life-safety on the map", $$("#map g.pin.level-life-safety").length === 2, $$("#map g.pin.level-life-safety").length);
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
check("the map rings the two homes", $$("#map circle.gap.level-urgent").length === 2, $$("#map circle.gap").length);
check("the outage step fits the width of the page", fits(), [document.documentElement.scrollWidth, window.innerWidth]);

// The API is back: the core cancels each system report.
await goTo(6);
check("the API is healthy again", state("nws-api") === "healthy", state("nws-api"));
check("each coverage is met again", $$("#sources .coverage li.short").length === 0);
check("each system report ended", $$("#sources .system-card.ended").length === 3 && $$("#map circle.gap").length === 0);
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
check("the step at index 0 has no incident", $$(".incident-card").length === 0 && $$("#map g.incident").length === 0);
check("the first step reads Step 1 of N", title().startsWith(`Step 1 of ${String(steps)}: `), title());
check("Back is off at the start", ($("#back") as HTMLButtonElement | null)?.disabled === true);

// A selection dims the other incidents on the map.
await goTo(2);
const cards = $$(".incident-card");
check("the step at index 2 has two incidents", cards.length === 2, cards.length);
click(cards[0]!);
check("a selected card selects its incident on the map", await until(() => $$("#map g.incident.selected").length === 1 && $$("#map g.incident.dim").length === 1));

// Play starts the replay, and a second press stops it.
click("#play");
check("Play changes to Pause", await until(() => $("#play")?.textContent === "Pause"));
click("#play");
check("Pause stops the replay", await until(() => $("#play")?.textContent === "Play"));

// The probe leaves the page at its first view.
await goTo(4);
check("the probe ends at the step at index 4", current() === "4");

export {};

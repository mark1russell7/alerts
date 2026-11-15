import { byId, copyText, h, setupTheme } from "@mark1russell7/site-pages/chrome";
import { COVERAGE_KINDS, FETCHES, FIRST_FETCH, PEOPLE, PLACES, SOURCES, STEPS } from "./demo.ts";
import { clock, stepLabel } from "./explain.ts";
import { replay } from "./replay.ts";
import { counts, drawIncidents, drawLevels, drawMap, drawMessage, drawSources } from "./view.ts";

setupTheme(byId<HTMLButtonElement>("theme"), "theme");

const copy = byId<HTMLButtonElement>("copy");
copy.addEventListener("click", () => {
  void copyText(copy, byId("install").textContent ?? "");
});

// The replay runs once, at the load of the page. Each step then only draws its frame.
// The labels count the steps from 1 for the reader. The indexes and `data-step` count from 0.
const frames = replay(STEPS, PEOPLE, PLACES, { sources: SOURCES, fetches: FETCHES, start: FIRST_FETCH, kinds: COVERAGE_KINDS });
const last = frames.length - 1;
let index = 0;
let selected: string | undefined;
let timer: number | undefined;

const rail = byId<HTMLOListElement>("rail");
const back = byId<HTMLButtonElement>("back");
const next = byId<HTMLButtonElement>("next");
const play = byId<HTMLButtonElement>("play");

frames.forEach((frame, at) => {
  const button = h(
    "button",
    { type: "button", class: "step", "data-step": at, "aria-label": `${stepLabel(at, frames.length)}: ${frame.step.title}, ${clock(frame.step.at)}` },
    h("span", { class: "number" }, String(at + 1)),
    h("span", { class: "label" }, frame.step.title),
  );
  button.addEventListener("click", () => {
    stop();
    go(at);
  });
  rail.append(h("li", {}, button));
});

/** This function selects an incident and draws the page again. */
function select(anchor: string): void {
  selected = selected === anchor ? undefined : anchor;
  draw();
}

/** This function goes to a step. It selects the incident of the new message of the step. */
function go(at: number): void {
  index = Math.max(0, Math.min(last, at));
  const frame = frames[index]!;
  const fresh = frame.reports[0]?.id;
  const holder = fresh === undefined ? undefined : frame.incidents.find((incident) => incident.reports.includes(fresh));
  if (holder !== undefined) selected = holder.anchor;
  else if (!frame.incidents.some((incident) => incident.anchor === selected)) selected = undefined;
  draw();
}

function draw(): void {
  const frame = frames[index]!;
  byId("clock").textContent = clock(frame.step.at);
  byId("step-title").textContent = `${stepLabel(index, frames.length)}: ${frame.step.title}`;
  byId("story").textContent = frame.step.story;
  for (const button of rail.querySelectorAll<HTMLButtonElement>("button.step")) {
    const at = Number(button.dataset["step"]);
    button.toggleAttribute("aria-current", at === index);
    button.classList.toggle("done", at < index);
  }
  back.disabled = index === 0;
  next.disabled = index === last;
  const count = counts(frames, index);
  byId("count-messages").textContent = String(count.messages);
  byId("count-reports").textContent = String(count.reports);
  byId("count-incidents").textContent = String(count.incidents);
  byId("count-levels").textContent = String(count.levels);
  byId("map").replaceChildren(drawMap(frame, selected, select));
  byId("levels").replaceChildren(drawLevels(frame));
  byId("sources").replaceChildren(drawSources(frame));
  byId("incidents").replaceChildren(drawIncidents(frame, selected, select));
  byId("message").replaceChildren(drawMessage(frame));
}

function stop(): void {
  if (timer !== undefined) window.clearInterval(timer);
  timer = undefined;
  play.textContent = "Play";
  play.setAttribute("aria-pressed", "false");
}

back.addEventListener("click", () => {
  stop();
  go(index - 1);
});
next.addEventListener("click", () => {
  stop();
  go(index + 1);
});
play.addEventListener("click", () => {
  if (timer !== undefined) {
    stop();
    return;
  }
  if (index === last) go(0);
  play.textContent = "Pause";
  play.setAttribute("aria-pressed", "true");
  timer = window.setInterval(() => {
    if (index >= last) stop();
    else go(index + 1);
  }, 2600);
});
byId("demo").addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement;
  if (target.closest("summary, pre") !== null) return;
  if (event.key === "ArrowRight") {
    stop();
    go(index + 1);
  } else if (event.key === "ArrowLeft") {
    stop();
    go(index - 1);
  }
});

// The first view is the step at index 4: two people have a level, and the flood incident has three messages.
go(4);

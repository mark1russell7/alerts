/**
 * The local page. It reads the map from the alert runtime on this computer every 30 seconds, and when the page
 * comes back into view. It draws the map, the list of the incidents and the region codes with no shape.
 * It sends each request to the origin of the page only.
 */

import type { MapPayload } from "@mark1russell7/alerts";
import { byId, setupTheme } from "@mark1russell7/site-pages/chrome";
import { readLine, readMap, READ_EVERY_MS } from "./map-read.ts";
import { drawIncidentList, drawMapView, drawUnshaped } from "./map-view.ts";

setupTheme(byId<HTMLButtonElement>("theme"), "theme");

const mapBox = byId("map");
const list = byId("incidents");
const unshaped = byId("unshaped");
const problem = byId("problem");
const line = byId("read");

let payload: MapPayload | undefined;
let selected: string | undefined;
let lastGood: number | undefined;
let reading = false;

const time = (at: number): string => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

function select(anchor: string): void {
  // A focused incident keeps the focus after the new draw, in the same part of the page.
  const box = document.activeElement?.closest("#map, #incidents");
  selected = selected === anchor ? undefined : anchor;
  draw();
  if (box instanceof HTMLElement) box.querySelector<HTMLElement | SVGElement>(`[data-anchor="${CSS.escape(anchor)}"]`)?.focus();
}

function draw(): void {
  if (payload === undefined) return;
  const view = payload.view;
  if (selected !== undefined && !view.incidents.some((incident) => incident.anchor === selected)) selected = undefined;
  mapBox.replaceChildren(drawMapView(view, { basemap: payload.basemap, ...(selected === undefined ? {} : { selected }), select }));
  list.replaceChildren(drawIncidentList(view, selected, select));
  const codes = drawUnshaped(view);
  unshaped.replaceChildren(...(codes === null ? [] : [codes]));
}

async function refresh(): Promise<void> {
  if (reading || document.hidden) return;
  reading = true;
  try {
    const result = await readMap((path) => fetch(path, { cache: "no-store", credentials: "same-origin" }));
    if (result.ok) {
      payload = result.payload;
      lastGood = Date.now();
      draw();
    }
    problem.textContent = result.ok ? "" : result.text;
    problem.hidden = result.ok;
    line.textContent = readLine(lastGood, !result.ok, time);
  } finally {
    reading = false;
  }
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) void refresh();
});
setInterval(() => void refresh(), READ_EVERY_MS);
void refresh();

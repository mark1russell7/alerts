/**
 * The local page. It reads the map from the alert runtime on this computer every 30 seconds, and when the page
 * comes back into view. It draws the map, the list of the incidents and the region codes with no shape.
 * The map is a globe that a person can move. A browser with no WebGL 2 gets the flat map.
 * It sends each request to the origin of the page only.
 */

import type { MapPayload } from "@mark1russell7/alerts";
import { byId, setupTheme } from "@mark1russell7/site-pages/chrome";
import { loadGlobe } from "./globe-load.ts";
import { readLine, readMap, READ_EVERY_MS } from "./map-read.ts";
import { drawIncidentList, drawMapView, drawStatusLegend, drawUnshaped } from "./map-view.ts";

setupTheme(byId<HTMLButtonElement>("theme"), "theme");

const mapBox = byId("map");
const list = byId("incidents");
const legend = byId("legend");
const unshaped = byId("unshaped");
const problem = byId("problem");
const line = byId("read");

let payload: MapPayload | undefined;
let selected: string | undefined;
let lastGood: number | undefined;
let reading = false;

const time = (at: number): string => new Date(at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });

// A pick on the globe selects its incident. The camera stays, because the person looks at the incident.
// The draw also puts the mark of the selection on the incident, when the pick was a place or a region.
// The code of the globe is a file of the site. It comes after the first picture of the page, and then the page draws again.
const globe = loadGlobe(
  { box: byId("globe"), tools: byId("globe-tools"), words: byId("words"), whole: byId<HTMLButtonElement>("whole") },
  (anchor) => {
    selected = anchor;
    draw(false);
  },
  {},
  () => {
    draw(false);
  },
);

/** This function selects an incident of the list or of the flat map. A second selection of the incident removes the selection. */
function select(anchor: string): void {
  // A focused incident keeps the focus after the new draw, in the same part of the page.
  const box = document.activeElement?.closest("#map, #incidents");
  selected = selected === anchor ? undefined : anchor;
  draw(true);
  if (box instanceof HTMLElement) box.querySelector<HTMLElement | SVGElement>(`[data-anchor="${CSS.escape(anchor)}"]`)?.focus();
}

/** This function draws the page. With `move`, the camera of the globe goes to the selected incident. */
function draw(move: boolean): void {
  if (payload === undefined) return;
  const view = payload.view;
  if (selected !== undefined && !view.incidents.some((incident) => incident.anchor === selected)) selected = undefined;
  // The globe shows the payload when it can. If not, the flat map shows it.
  const onGlobe = globe.show(payload, selected, move);
  mapBox.hidden = onGlobe;
  mapBox.replaceChildren(...(onGlobe ? [] : [drawMapView(view, { basemap: payload.basemap, ...(selected === undefined ? {} : { selected }), select })]));
  // The legend names each status other than actual that the map shows.
  drawStatusLegend(legend, view);
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
      draw(false);
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

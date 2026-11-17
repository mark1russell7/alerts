/**
 * The globe of the local page: a stage of `@mark1russell7/visuals` with the parts of `globe-view.ts`. A person turns
 * the globe with a drag, and goes nearer with the wheel. The name of each place is a text of the page next to its dot.
 * A browser with no WebGL 2 gets no globe. Then the page shows the flat map of `map-view.ts`.
 */

import { ASSESSED_LEVELS, type AssessedLevel, type MapPayload } from "@mark1russell7/alerts";
import type { Region } from "@mark1russell7/geo";
import type { StageView } from "@mark1russell7/visuals";
import { createGlobe, GLOBE_POLAR, globePoint, inSight, pointRadius, regionView, type GlobeContent, type GlobeStyle, type GlobeTheme } from "@mark1russell7/visuals/globe";
import { createLabels, type StageLabel } from "@mark1russell7/visuals/labels";
import { createStage, stackContents, type Stage } from "@mark1russell7/visuals/three";
import { areaKind, GAP_KIND, globeParts, incidentRecord, outlineKind, pinKind, ZONE_KIND, type GlobeName, type GlobeParts, type GlobeValue } from "./globe-view.ts";
import { mapSummary } from "./map-view.ts";

/** The elements of the page that the globe uses. */
export interface GlobeElements {
  /** The box of the globe. The style sheet gives it a size. It is hidden while the page shows the flat map. */
  readonly box: HTMLElement;
  /** The box of the line and of the button of the globe. It is hidden while the page shows the flat map. */
  readonly tools: HTMLElement;
  /** The line that names the part of the globe below the pointer. */
  readonly words: HTMLElement;
  /** The button that shows each part of the map again. */
  readonly whole: HTMLButtonElement;
}

/** The globe of the local page. */
export interface LiveGlobe {
  /**
   * This function shows a map payload on the globe, with the selected incident. With `move`, the camera goes to the
   * selected incident, or to the view of each part when no incident is selected. The function gives false when the
   * globe cannot show the payload. Then the globe is hidden, and the page shows the flat map.
   */
  show(payload: MapPayload, selected: string | undefined, move: boolean): boolean;
}

/** The custom property of the style sheet that has the color of each level. */
const LEVEL_COLORS: Readonly<Record<AssessedLevel, string>> = {
  "life-safety": "--ls",
  urgent: "--urgent",
  notice: "--notice",
  digest: "--digest",
  none: "--none",
};

/** The part of the light that the area of an incident of each level stops. A higher level stops more light. */
const AREA_OPACITY: Readonly<Record<AssessedLevel, number>> = { none: 0.16, digest: 0.2, notice: 0.24, urgent: 0.3, "life-safety": 0.38 };

/** The smallest height of the camera above the surface, as a part of the radius of the Earth: approximately 6 km. */
const NEAREST = 0.001;

/** The space around a selected incident in its view. The picture also shows the regions around the incident. */
const NEAR_MARGIN = 2.2;

/** The space between a name of a place and the edge of the picture, in CSS pixels. */
const NAME_EDGE = 2;

/** The name of the view that shows each part of the map. */
const ALL = "all";

/** The name of the view that shows the incident that the camera follows. */
const NEAR = "near";

/** This function reads a color of the page: the value of a custom property of the root element, as a CSS hex color. */
function color(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * This function makes the theme of the globe from the colors of the page.
 * The style sheet is the one home of each color, so the legend, the flat map and the globe always agree.
 */
export function globeTheme(): GlobeTheme {
  const page = color("--page");
  const styles: Record<string, GlobeStyle> = {
    [ZONE_KIND]: { fill: color("--panel"), line: color("--line") },
    // The gap ring is a disk of the color of the page with a ring of the color of the legend. The dot of the place is on it.
    [GAP_KIND]: { fill: page, line: color("--urgent") },
  };
  for (const level of ASSESSED_LEVELS) {
    const tone = color(LEVEL_COLORS[level]);
    styles[areaKind(level)] = { fill: tone, opacity: AREA_OPACITY[level], line: tone };
    styles[outlineKind(level)] = { line: tone };
    styles[pinKind(level)] = { fill: tone, line: page };
  }
  return {
    // The globe has no surface that takes light, so the colors of the light change nothing.
    sky: "#ffffff",
    ground: "#ffffff",
    ball: color("--sea"),
    grid: color("--grid"),
    shade: color("--rim"),
    styles,
    other: { fill: color("--none") },
    hovered: color("--quiet"),
    selected: color("--ink"),
  };
}

/**
 * This function gives the label of the stage for the name of a place. The text stays off the mark of the place.
 * The text of a place with no mark has its middle on the position of the name.
 */
export function labelOf(name: GlobeName): StageLabel {
  const label = { record: name.record, at: globePoint(name.place), text: name.text, kind: name.kind, rank: name.rank };
  return name.size > 0 ? { ...label, clear: pointRadius(name.size) } : { ...label, sides: ["center"] };
}

/**
 * This function starts `change` each time the page changes between its light colors and its dark colors.
 * The sites of `visuals` and of `room-view` have the same function. The three functions move to
 * `@mark1russell7/site-pages/chrome`, and then this copy goes.
 */
function onThemeChange(change: () => void): void {
  new MutationObserver(change).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", change);
}

/**
 * This function starts the globe of the local page. It makes the stage at the first payload that the globe can show.
 * `select` gets the anchor of the incident that a person selects on the globe, or `undefined` for no incident.
 */
export function startGlobe(elements: GlobeElements, select: (anchor: string | undefined) => void): LiveGlobe {
  let stage: Stage<GlobeValue, GlobeTheme> | undefined;
  /** This value is true after the browser gave no WebGL 2. Then each payload goes to the flat map. */
  let none = false;
  /** The parts of the content of the stage. */
  let parts: GlobeParts | undefined;
  /** The text of the last payload. The globe makes a new content only for a different text. `shown` tells if the globe shows the payload. */
  let text: string | undefined;
  let shown = false;
  /** The selected incident of the last picture. */
  let last: string | undefined;
  /** The anchor of the incident that the camera follows: the last incident that a person selected in the list. */
  let followed: string | undefined;
  /** The view of each part, and the view of the followed incident, for the content of the stage. */
  let all: StageView = regionView([]);
  let near: StageView = all;
  // Each name of a view reads the view of the content at that time. Thus the key Home and a new size of the box use the last payload.
  const views: Readonly<Record<string, StageView>> = { [ALL]: (frame) => all(frame), [NEAR]: (frame) => near(frame) };

  /** This function gives the regions of an incident of the content, or `undefined` for an incident with no shape. */
  const shapesOf = (anchor: string | undefined): readonly Region[] | undefined => {
    const shapes = anchor === undefined ? undefined : parts?.incidents.get(anchor);
    return shapes === undefined || shapes.length === 0 ? undefined : shapes;
  };

  /** This function sets the two views from the parts of the content and the followed incident. */
  const setViews = (): void => {
    all = regionView(parts?.regions ?? []);
    const shapes = shapesOf(followed);
    near = shapes === undefined ? all : regionView(shapes, NEAR_MARGIN);
  };

  const setVisible = (visible: boolean): void => {
    elements.box.hidden = !visible;
    elements.tools.hidden = !visible;
  };

  /** This function puts a payload on the stage. It gives false when the globe cannot show the payload. */
  const put = (payload: MapPayload): boolean => {
    let next: GlobeParts;
    let globe: GlobeContent<GlobeValue>;
    try {
      next = globeParts(payload);
      // A payload with no shape has no picture. The flat map tells it in words.
      if (next.areas.length === 0 && next.points.length === 0) return false;
      globe = createGlobe({ areas: next.areas, points: next.points, grid: next.grid, nearest: NEAREST, lineWidth: 1.5, highlightWidth: 3 });
    } catch {
      // A shape that is not correct stops the globe for this payload. The flat map shows the shapes that it can.
      return false;
    }
    // The names are texts of the page above the picture. A place on the far side of the Earth has no name in the picture.
    const names = createLabels(elements.box, { labels: next.names.map(labelOf), visible: (point, eye) => inSight(point, eye, 1), edge: NAME_EDGE });
    const content = stackContents<GlobeValue, GlobeTheme>([globe, names]);
    parts = next;
    if (followed !== undefined && !next.incidents.has(followed)) followed = undefined;
    setViews();
    if (stage !== undefined) {
      stage.setContent(content);
    } else {
      // The stage reads the size of its box, so the box is in the page before the stage starts.
      setVisible(true);
      stage = createStage<GlobeValue, GlobeTheme>(elements.box, {
        content,
        theme: globeTheme(),
        label: mapSummary(payload.view),
        views,
        home: ALL,
        polar: GLOBE_POLAR,
        pan: false,
        onHover: (pick) => {
          elements.words.textContent = pick?.words ?? "";
        },
        onSelect: (pick) => {
          select(pick?.type === "incident" ? pick.anchor : pick?.type === "place" ? pick.incident : undefined);
        },
      });
      if (stage === undefined) {
        content.dispose();
        none = true;
        return false;
      }
      const made = stage;
      onThemeChange(() => {
        made.setTheme(globeTheme());
      });
      elements.whole.addEventListener("click", () => {
        followed = undefined;
        setViews();
        made.setView(ALL);
      });
    }
    stage.canvas.setAttribute("aria-label", mapSummary(payload.view));
    return true;
  };

  return {
    show(payload, selected, move): boolean {
      if (none) return false;
      const next = JSON.stringify([payload.view, payload.basemap]);
      if (next !== text) {
        text = next;
        shown = put(payload);
        if (!shown) elements.words.textContent = "";
      }
      setVisible(shown);
      if (!shown || stage === undefined) return false;
      // An incident with no shape has no part on the globe, so the globe shows no selection for it.
      stage.select(selected === undefined || shapesOf(selected) === undefined ? undefined : incidentRecord(selected));
      if (move && selected !== last) {
        followed = selected;
        setViews();
        stage.setView(shapesOf(followed) === undefined ? ALL : NEAR);
      }
      last = selected;
      return true;
    },
  };
}

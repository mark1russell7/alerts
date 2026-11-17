/**
 * The load of the globe. The code of the globe has `three`, which is large. So a page does not have it in its first
 * files. The page loads it only for a browser that can show the globe. A browser with no WebGL 2 gets the flat map
 * at once, and it does not load the code.
 */

import { stageSupported } from "@mark1russell7/visuals";
import type { GlobeElements, LiveGlobe } from "./globe-stage.ts";
import type { GlobePartsOptions } from "./globe-view.ts";

/**
 * The name of the mark that a page puts on its time line when it starts the load.
 * A file with a later start is not a start file of the page. The site check uses this.
 */
export const GLOBE_CODE_MARK = "globe-code";

/** The module of the globe: the part of `globe-stage.ts` that a page uses. */
export type GlobeModule = Pick<typeof import("./globe-stage.ts"), "startGlobe">;

/** The parts of the load that a test replaces. */
export interface GlobeLoad {
  /** This function tells if the browser can show the globe. The default is `stageSupported` of `@mark1russell7/visuals`. */
  readonly supported?: (() => boolean) | undefined;
  /** This function loads the module of the globe. The default loads `globe-stage.ts`, which is a file of the site. */
  readonly load?: (() => Promise<GlobeModule>) | undefined;
}

/**
 * This function gives the globe of a page, and loads the code of the globe when the browser can show it.
 *
 * While the code is on its way, the box of the globe is in the page with no picture. Thus the page does not move
 * when the picture comes. `change` starts when the globe is ready, and when its code does not come. The page then
 * draws again. A page that gets no code shows the flat map.
 *
 * A person can select an incident before the code comes. The first picture of the globe moves the camera to that
 * incident, if it is the selected incident at that time.
 */
export function loadGlobe(
  elements: GlobeElements,
  select: (anchor: string | undefined) => void,
  options: GlobePartsOptions,
  change: () => void,
  parts: GlobeLoad = {},
): LiveGlobe {
  const supported = parts.supported ?? stageSupported;
  const load = parts.load ?? ((): Promise<GlobeModule> => import("./globe-stage.ts"));
  if (!supported()) return { show: () => false };

  let globe: LiveGlobe | undefined;
  let failed = false;
  /** The incident that a person selected while the code was on its way. The camera goes to it at the first picture. */
  let wanted: string | undefined;
  let first = true;
  // The button has no effect before the globe is there.
  elements.whole.disabled = true;
  elements.box.setAttribute("aria-busy", "true");
  const start = async (): Promise<void> => {
    try {
      globe = (await load()).startGlobe(elements, select, options);
    } catch {
      failed = true;
    }
    elements.whole.disabled = false;
    elements.box.removeAttribute("aria-busy");
    change();
  };
  performance.mark(GLOBE_CODE_MARK);
  void start();

  return {
    show(payload, selected, move): boolean {
      if (globe !== undefined) {
        // The page draws again with no move when the code comes. So the load keeps a move that it got before.
        const late = first && selected !== undefined && selected === wanted;
        first = false;
        return globe.show(payload, selected, move || late);
      }
      if (move) wanted = selected;
      // The box keeps the place of the picture until the code comes. With no code, the page shows the flat map.
      elements.box.hidden = failed;
      elements.tools.hidden = failed;
      return !failed;
    },
  };
}

/**
 * This module keeps the outlines of the regions of the instance: the NWS zones and counties of the watched states and of
 * the live incidents. After each pass, the instance starts a refresh of the store of shapes. The refresh ends before the
 * next fetch of the alerts. Thus the alerts come first. The match by shape and the map route read the outlines here.
 */
import type { Incident, Instant, MapRegion, RegionCode, ShapeLookup, WatchedPlace } from "@mark1russell7/alerts";
import { stateOfCode } from "@mark1russell7/alerts-format-nws";
import { compareCodes, type Refreshed, type ShapeStore, type Wanted } from "@mark1russell7/alerts-shapes-nws";
import { errorMessage } from "@mark1russell7/text";

/** The outcome of one refresh of the outlines: its result, or the error that it threw. */
export type ShapeOutcome = { readonly ok: true; readonly refreshed: Refreshed } | { readonly ok: false; readonly error: unknown };

/**
 * This function gives a text about a refresh with a failure, a problem or an error, or `undefined` for a refresh with none. The
 * entry writes the text to the output of the process.
 */
export function shapeReport(outcome: ShapeOutcome): string | undefined {
  if (!outcome.ok) return `The refresh of the shapes threw: ${errorMessage(outcome.error)}`;
  const { requests, failures, problems, stop } = outcome.refreshed;
  if (failures.length === 0 && problems.length === 0) return undefined;
  const lines = [...failures.map(({ task, failure }) => `${task}: ${failure.kind}: ${failure.message}`), ...problems];
  return [`The refresh of the shapes made ${requests} requests and stopped at "${stop}". It has these failures and problems:`, ...lines.map((line) => `- ${line}`)].join("\n");
}

/** This function gives the key of a region code for a comparison. */
const codeKey = (code: RegionCode): string => `${code.system}:${code.code.trim().toUpperCase()}`;

/** This function compares two region codes: by the system, and then by the code. */
const byCode = (a: RegionCode, b: RegionCode): number => compareCodes(a.system, b.system) || compareCodes(a.code, b.code);

/** This function gives the codes of the areas of the live incidents in capitals, once each, in the order of the system and the code. */
export function liveCodes(incidents: readonly Incident[]): RegionCode[] {
  const codes = new Map<string, RegionCode>();
  for (const incident of incidents) {
    if (!incident.live) continue;
    for (const area of incident.areas) if (area.type === "code") codes.set(codeKey(area), { system: area.system, code: area.code.trim().toUpperCase() });
  }
  return [...codes.values()].sort(byCode);
}

/**
 * This function gives the regions that the store keeps: each state of a watched place, and the codes of the live incidents.
 * The store gets the zones of the codes first, and then the zones of each state.
 *
 * The codes of the places do not go into `codes`. Their zones come with the list of their state. Thus no request names the
 * zone of a place before the other zones of its state.
 */
export function wantedShapes(places: readonly WatchedPlace[], incidents: readonly Incident[]): Wanted {
  const states = new Set<string>();
  for (const place of places) {
    for (const code of place.codes) {
      const state = stateOfCode(code);
      if (state !== undefined) states.add(state);
    }
  }
  return { states: [...states].sort(compareCodes), codes: liveCodes(incidents) };
}

/** The outlines of the instance. */
export interface InstanceShapes {
  /** This function gives the shapes of a region code from the records of the store. The view of the map uses it. */
  readonly lookup: ShapeLookup;
  /**
   * This function gives the regions under the map: the regions of the watched places and of the live incidents, in the order
   * of the code. A region is a zone or a county, and its code is the UGC code.
   */
  basemap(): readonly MapRegion[];
  /** This function waits for the end of the refresh in progress. It does not throw. */
  idle(): Promise<void>;
  /** This function stops the refresh in progress, waits for its end, and closes the cache of the store. */
  close(): Promise<void>;
}

/** The outlines of the instance, with the step that the instance starts after each pass. */
export interface ShapeKeeper extends InstanceShapes {
  /**
   * This function starts a refresh of the store, when no refresh is in progress. The refresh starts no request that can end
   * after `until`: the next fetch of a source. With no `until`, no refresh starts.
   */
  afterPass(incidents: readonly Incident[], until: Instant | undefined): void;
}

/** The options of `keepShapes`. */
export interface ShapeKeeperOptions {
  /** The store of shapes. Without a store, the instance has no outline, and the map has no region. */
  readonly store?: ShapeStore | undefined;
  /** The watched places. */
  readonly places: readonly WatchedPlace[];
  /** The keeper gives each refresh to this function. */
  readonly onShapes?: ((outcome: ShapeOutcome) => void) | undefined;
  /** The keeper starts this function at its close, after the end of the refresh. The instance closes the cache of the store here. */
  readonly close?: (() => void) | undefined;
}

/** This function makes the keeper of the outlines of the instance. */
export function keepShapes(options: ShapeKeeperOptions): ShapeKeeper {
  const { store, places } = options;
  const stop = new AbortController();
  let incidents: readonly Incident[] = [];
  let running: Promise<void> | undefined;
  let closed = false;
  const report = (outcome: ShapeOutcome): void => {
    try {
      options.onShapes?.(outcome);
    } catch {
      // The hook only reports. A fault of the hook does not stop the keeper.
    }
  };

  return {
    lookup: (code) => store?.lookup(code),
    basemap() {
      if (store === undefined) return [];
      // TODO(geo/R12): give the whole watched states with `store.basemap(state)`, after geo simplifies the regions with shared
      // edges. The raw outlines of one state are many megabytes, thus the map has only the regions of the places and the incidents.
      const regions = new Map<string, MapRegion>();
      for (const code of [...places.flatMap((place) => place.codes), ...liveCodes(incidents)]) {
        const region = store.region(code);
        if (region !== undefined) regions.set(region.code.code, region);
      }
      return [...regions.values()].sort((a, b) => byCode(a.code, b.code));
    },
    afterPass(live, until) {
      incidents = live;
      if (store === undefined || until === undefined || closed || running !== undefined) return;
      const work = store.refresh({ wanted: wantedShapes(places, live), until, signal: stop.signal }).then(
        (refreshed) => report({ ok: true, refreshed }),
        // The close aborts the refresh. That abort is not a fault.
        (error: unknown) => (stop.signal.aborted ? undefined : report({ ok: false, error })),
      );
      running = work.finally(() => {
        running = undefined;
      });
    },
    idle: async () => {
      await running;
    },
    async close() {
      if (closed) return;
      closed = true;
      stop.abort(new Error("The instance closed the store of shapes."));
      await running;
      options.close?.();
    },
  };
}

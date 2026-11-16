/**
 * The shaking of an earthquake at a distance. The two laws of Atkinson and Wald (2007) give the Modified
 * Mercalli Intensity (MMI) from the magnitude and the hypocentral distance. The DYFI service of the USGS
 * draws these two laws for older events, and the tests hold the laws against those curves.
 *
 * Atkinson, G. M. and Wald, D. J. (2007). "Did You Feel It?" intensity data: a surprisingly good measure
 * of earthquake ground motion. Seismological Research Letters 78 (3), 362-368.
 *
 * The 2007 laws are a shortcut. The DYFI pages of newer events draw the laws of Atkinson, Worden and Wald (2014).
 * At magnitude 5.5, the 2007 felt radius is 20% smaller in active crust and 28% larger in stable crust. The tests
 * hold this difference. The 2014 laws replace the 2007 laws when their coefficients match the curves of the fixture
 * `dyfi-atten-us7000ki5u.json`.
 *
 * The laws also treat the event as a point. A large event breaks a fault of tens or hundreds of kilometers, so a place
 * near the far end of the fault gets more shaking than the law gives. The intensity contours of the ShakeMap product
 * of the USGS replace the law for the events that have them.
 */

import type { Position, Severity } from "@mark1russell7/alerts";

/** The coefficients of one intensity law of Atkinson and Wald (2007). */
export interface IntensityLaw {
  /** The id of the law. */
  readonly id: string;
  /** The region of the data of the law. */
  readonly region: string;
  /** The constant term. */
  readonly c1: number;
  /** The term of `M - 6`. */
  readonly c2: number;
  /** The term of the square of `M - 6`. */
  readonly c3: number;
  /** The term of `log R`. */
  readonly c4: number;
  /** The term of `R`. */
  readonly c5: number;
  /** The term of the far distance `B`. */
  readonly c6: number;
  /** The term of `M log R`. */
  readonly c7: number;
  /** The depth term in kilometers. The distance `R` of the law is the root of `D² + h²`. */
  readonly h: number;
  /** The distance `Rt` in kilometers where the far term starts. */
  readonly rt: number;
}

/** The law of active crust, from the data of California. */
export const ACTIVE_LAW: IntensityLaw = {
  id: "aw07-california",
  region: "California",
  c1: 12.27,
  c2: 2.27,
  c3: 0.1304,
  c4: -1.3,
  c5: -0.000707,
  c6: 1.95,
  c7: -0.577,
  h: 14,
  rt: 30,
};

/** The law of stable crust, from the data of the central and eastern United States. The shaking goes farther in stable crust. */
export const STABLE_LAW: IntensityLaw = {
  id: "aw07-ceus",
  region: "the central and eastern United States",
  c1: 11.72,
  c2: 2.36,
  c3: 0.1155,
  c4: -0.44,
  c5: -0.002044,
  c6: 2.31,
  c7: -0.479,
  h: 17,
  rt: 80,
};

/**
 * The box of the stable crust of North America, in degrees. `lawAt` gives the stable law in the box. This box is a
 * shortcut: in stable crust outside it, the active law gives a felt area that is too small. A map of the crust replaces it.
 */
export const STABLE_BOX = { west: -105, east: -50, south: 24, north: 72 } as const;

/** This function gives the law of an epicenter: `STABLE_LAW` in `STABLE_BOX`, and `ACTIVE_LAW` outside it. */
export function lawAt(epicenter: Position): IntensityLaw {
  const [lon, lat] = epicenter;
  const stable = lon >= STABLE_BOX.west && lon <= STABLE_BOX.east && lat >= STABLE_BOX.south && lat <= STABLE_BOX.north;
  return stable ? STABLE_LAW : ACTIVE_LAW;
}

/**
 * This function gives the MMI of a law for a magnitude at a hypocentral distance in kilometers. The law takes a
 * moment magnitude. Each other type of magnitude gives an estimate.
 */
export function intensityAt(law: IntensityLaw, magnitude: number, distanceKm: number): number {
  const r = Math.hypot(distanceKm, law.h);
  const logR = Math.log10(r);
  const m = magnitude - 6;
  const far = Math.max(0, Math.log10(r / law.rt));
  return law.c1 + law.c2 * m + law.c3 * m * m + law.c4 * logR + law.c5 * r + law.c6 * far + law.c7 * magnitude * logR;
}

/** The MMI where people indoors feel the shaking: III, weak shaking. */
export const FELT_INTENSITY = 3;

/** The largest radius in kilometers that `feltRadiusKm` gives. */
export const MAX_RADIUS_KM = 3000;

/** The step in kilometers of the scan of `feltRadiusKm`. A bisection then finds the edge in the step. */
const SCAN_KM = 1;

/** The precision in kilometers of the edge that `feltRadiusKm` gives. */
const EDGE_KM = 0.01;

/**
 * This function gives the radius in kilometers of the disc around the epicenter where the shaking is at `level` or
 * more. The edge is the first distance where the shaking falls below `level`. The radius is 0 when the shaking at the
 * epicenter is less than `level`, and `MAX_RADIUS_KM` at most.
 */
export function feltRadiusKm(law: IntensityLaw, magnitude: number, depthKm: number, level: number = FELT_INTENSITY): number {
  const depth = Math.max(0, depthKm);
  const reaches = (x: number): boolean => intensityAt(law, magnitude, Math.hypot(x, depth)) >= level;
  if (!reaches(0)) return 0;
  let inside = 0;
  while (inside + SCAN_KM <= MAX_RADIUS_KM && reaches(inside + SCAN_KM)) inside += SCAN_KM;
  if (inside + SCAN_KM > MAX_RADIUS_KM) return MAX_RADIUS_KM;
  let outside = inside + SCAN_KM;
  while (outside - inside > EDGE_KM) {
    const middle = (inside + outside) / 2;
    if (reaches(middle)) inside = middle;
    else outside = middle;
  }
  return Math.floor(inside * 100) / 100;
}

/** One band of the shaking: a severity and the lowest MMI of the band. */
export interface IntensityBand {
  readonly severity: Severity;
  /** The lowest MMI of the band. */
  readonly from: number;
}

/**
 * The bands of the shaking, from the strongest. The class of an MMI value is its rounded value. VIII or more is
 * `extreme`: ordinary buildings partly collapse. VII is `severe`: poor buildings get considerable damage. VI is
 * `moderate`: the damage is slight. The felt level up to VI is `minor`.
 */
export const INTENSITY_BANDS: readonly IntensityBand[] = [
  { severity: "extreme", from: 7.5 },
  { severity: "severe", from: 6.5 },
  { severity: "moderate", from: 5.5 },
  { severity: "minor", from: FELT_INTENSITY },
];

/**
 * This function gives the severity of the shaking of an MMI value: the severity of the first band of
 * `INTENSITY_BANDS` that holds the value. A value below the felt level is `minor`. A value that is not a number is `unknown`.
 */
export function severityOfIntensity(mmi: number): Severity {
  if (!Number.isFinite(mmi)) return "unknown";
  return INTENSITY_BANDS.find((band) => mmi >= band.from)?.severity ?? "minor";
}

/** The disc of one band: the places in the radius around the epicenter have the shaking of the band or more. */
export interface BandDisc extends IntensityBand {
  readonly radiusKm: number;
}

/**
 * This function gives the disc of each band of `INTENSITY_BANDS` that the shaking reaches, from the strongest band.
 * The discs are nested. The severity at a place is the severity of the smallest disc that holds the place.
 *
 * The `bias` is added to the law at each distance. A source with a measure of the strongest shaking sets it, so the
 * law agrees with the measure at the epicenter. A band is absent when the shaking at the epicenter is below the band.
 */
export function bandDiscs(law: IntensityLaw, magnitude: number, depthKm: number, bias = 0): BandDisc[] {
  const depth = Math.max(0, depthKm);
  const strongest = intensityAt(law, magnitude, depth);
  return INTENSITY_BANDS.filter((band) => strongest >= band.from - bias).map((band) => ({
    ...band,
    radiusKm: feltRadiusKm(law, magnitude, depth, band.from - bias),
  }));
}

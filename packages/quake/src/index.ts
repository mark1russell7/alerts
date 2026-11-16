/**
 * The shaking of an earthquake at each distance, for the alert system. The package gives the intensity laws of
 * Atkinson and Wald (2007), the felt radius of an event and the nested discs of the bands of the shaking.
 */

export {
  ACTIVE_LAW,
  bandDiscs,
  FELT_INTENSITY,
  feltRadiusKm,
  INTENSITY_BANDS,
  intensityAt,
  lawAt,
  MAX_RADIUS_KM,
  severityOfIntensity,
  STABLE_BOX,
  STABLE_LAW,
} from "./intensity.ts";
export type { BandDisc, IntensityBand, IntensityLaw } from "./intensity.ts";

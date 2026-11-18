/**
 * The areas of a geomagnetic storm: two polar caps at the geomagnetic poles. A storm has effects poleward of a
 * geomagnetic latitude, and the latitude goes down with each level of the scale G.
 */

import type { Area } from "@mark1russell7/alerts";
import { EARTH_MEAN_RADIUS_KM } from "@mark1russell7/geo";

/**
 * The geomagnetic latitude poleward of which a geomagnetic storm has effects, from no G level (a K-index of 4, index
 * 0) to G5. The SWPC writes these values in the line `Potential Impacts` of each geomagnetic message. The NOAA table of
 * the scales gives the same values from G2 to G5.
 */
export const POLEWARD_BY_LEVEL: readonly number[] = [65, 60, 55, 50, 45, 40];

/**
 * The geomagnetic poles of the dipole of the World Magnetic Model WMM2025 at its epoch 2025.0, in geocentric
 * coordinates as `[longitude, latitude]`. The two poles are antipodes. The model ends at the end of 2029. NCEI:
 * `https://www.ncei.noaa.gov/products/wandering-geomagnetic-poles`.
 */
export const GEOMAGNETIC_POLES: readonly (readonly [number, number])[] = [
  [-72.76, 80.79],
  [107.24, -80.79],
];

/**
 * This function gives the two polar caps of a geomagnetic latitude: two circles at the geomagnetic poles. The radius
 * is the arc from the pole to the latitude, on the sphere of the mean radius that the core uses for each distance.
 * Two sources of one storm thus give caps with the same centers, and the link rule of the merge can join them.
 */
export function polarCaps(latitude: number, block?: string): Area[] {
  const radiusKm = ((90 - latitude) * Math.PI * EARTH_MEAN_RADIUS_KM) / 180;
  return GEOMAGNETIC_POLES.map(([lon, lat]) => ({ type: "circle", center: [lon, lat], radiusKm, ...(block === undefined ? {} : { block }) }));
}

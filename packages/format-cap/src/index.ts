/**
 * The reader of CAP 1.2 messages (the Common Alerting Protocol of OASIS) for the sources of the alert
 * system: FEMA IPAWS, the NWS, NWWS-OI and other CAP feeds.
 *
 * `readCap` gives the elements of a message as texts. `splitAlerts` splits a feed into its alerts.
 * `chooseInfo` chooses one info block. `capPolygon` and `capCircle` give the areas in the order of the
 * core. The package also has the readers of the CAP values. The check of XML signatures comes later.
 */

export { capCircle, capPolygon, capPosition } from "./geometry.ts";
export { chooseInfo, DEFAULT_LANGUAGES, type ChosenInfo } from "./info.ts";
export {
  CAP_NAMESPACES,
  readCap,
  type CapAlert,
  type CapArea,
  type CapInfo,
  type CapPair,
  type CapRead,
  type CapReference,
  type CapResource,
  type CapVersion,
} from "./read.ts";
export { splitAlerts } from "./split.ts";
export {
  CAP_CATEGORIES,
  CAP_CERTAINTY,
  CAP_NOT_ALERTS,
  CAP_OPERATIONS,
  CAP_RESPONSES,
  CAP_SEVERITY,
  CAP_STATUS,
  CAP_URGENCY,
  capList,
  capTime,
  capValue,
} from "./values.ts";

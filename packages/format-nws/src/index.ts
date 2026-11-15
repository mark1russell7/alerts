/**
 * This package holds two formats of the US warning system. One is the Valid Time Event Code (P-VTEC)
 * of the NWS. The other is the kinds of the NWS and SAME event codes in the taxonomy of the alert
 * system. The NWS API source, the CAP sources and the weather radio source use these functions.
 */

export {
  categoryOf,
  EVENT_CODES,
  fromEventCode,
  fromEventName,
  fromPhenomenon,
  PHENOMENA,
  resolveKind,
  SIGNIFICANCE,
  STAGE_WORDS,
  UNKNOWN_KIND,
  type EventCode,
  type Hazard,
  type KindFacts,
  type ResolvedKind,
} from "./kinds.ts";
export {
  CLOSING_ACTIONS,
  formatVtec,
  formatVtecTime,
  mainVtec,
  NO_TIME,
  parseVtec,
  vtecKey,
  vtecTime,
  type Vtec,
  type VtecClass,
} from "./vtec.ts";

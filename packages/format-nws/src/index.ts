/**
 * This package holds four formats of the US warning system. The first is the Valid Time Event Code
 * (P-VTEC) of the NWS. The second is the kinds of the NWS and SAME event codes in the taxonomy of the
 * alert system. The third is the UGC and SAME region codes and the state codes. The fourth is the
 * event codes of the WEA messages. The NWS API source, the CAP sources and the weather radio source
 * use these functions.
 */

export {
  categoryOf,
  EVENT_CODES,
  fromEventCode,
  fromEventName,
  fromPhenomenon,
  hasVtec,
  KIND_PREFIXES,
  NAME_ALIASES,
  PHENOMENA,
  resolveKind,
  SIGNIFICANCE,
  STAGE_WORDS,
  type EventCode,
  type Hazard,
  type KindFacts,
  type ResolvedKind,
} from "./kinds.ts";
export {
  isSameCode,
  isUgcCode,
  parseSameLocation,
  STATE_FIPS,
  STATE_POSTAL,
  stateOfSame,
  stateOfUgc,
  type SameLocation,
} from "./codes.ts";
export { WEA_EVENT_CODES, WEA_PARAMETER } from "./wea.ts";
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

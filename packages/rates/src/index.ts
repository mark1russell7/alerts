/**
 * The base rates of the alert system, from public data of the whole country. The package measures
 * the verified share of the NWS warnings (IEM Cow) and the deaths and injuries of each event type
 * (NCEI Storm Events). It also holds the CAP certainty bands of `format-cap` in its file.
 *
 * The functions are pure. The script `scripts/measure.ts` fetches the data, writes `data/rates.json`
 * and compares a new measure with the committed file.
 */

export {
  COW_MARGIN_MS,
  COW_PHENOMENA,
  COW_URL,
  cowQuery,
  cowSettings,
  cowWindows,
  splitWindow,
  OWN_REPORT_TYPES,
  phenomenonKind,
  queryTime,
  readCow,
  tallyCow,
  type CowCount,
  type CowPhenomenon,
  type CowRead,
  type CowTally,
  type CowWarning,
  type CowWindow,
} from "./cow.ts";
export { checkRates, gatedValues, type GateBreak, type Gated } from "./gate.ts";
export {
  DETAILS_COLUMNS,
  detailsFiles,
  MAX_RECORD_TEXT,
  NCEI_FOLDER_URL,
  NCEI_KINDS,
  nceiKind,
  RecordFramer,
  sumDetails,
  type DetailsFile,
  type Harm,
  type YearHarm,
} from "./ncei.ts";
export {
  BOOTSTRAP_RUNS,
  cowRates,
  LEVEL,
  METHODS,
  nceiRates,
  RATES_FORMAT,
  ratesFile,
  type CowRate,
  type NceiRate,
  type PerYear,
  type Range,
  type RatesFile,
  type RatesInput,
  type Share,
} from "./rates.ts";
export { ratesSummary, TOP_TYPES, type GateResult } from "./summary.ts";
export { COW_YEARS, eachYear, lastFullYear, measureYears, NCEI_YEARS, parseYears, type Years } from "./years.ts";

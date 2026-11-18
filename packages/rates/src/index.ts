/**
 * The base rates of the alert system, from public data of the whole country. The package measures
 * the verified share of the NWS warnings (IEM Cow) and the deaths and injuries of each event type
 * (NCEI Storm Events). It also measures the alerts of each kind and the harm under an active alert,
 * from the IEM archive of the VTEC alerts and NCEI. It holds the CAP certainty bands of `format-cap` in its file.
 *
 * The functions are pure. The script `scripts/measure.ts` fetches the data, writes `data/rates.json`
 * and compares a new measure with the committed file. The function `priorsOf` gives the priors of the
 * shadow score from the file, and the script writes them to `data/priors.json`.
 */

export {
  COW_MARGIN_MS,
  COW_PHENOMENA,
  COW_QUERY_PHENOMENA,
  COW_UNVERIFIED,
  COW_UNVERIFIED_PHENOMENA,
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
  type CowQueryPhenomenon,
  type CowRead,
  type CowTally,
  type CowUnverified,
  type CowUnverifiedPhenomenon,
  type CowWarning,
  type CowWindow,
} from "./cow.ts";
export { checkRates, GATE_FORMATS, gatedValues, type GateBreak, type GateCheck, type Gated, type GateFile, type GateNoRead } from "./gate.ts";
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
  type HarmRow,
  type NceiLocalTime,
  type YearHarm,
} from "./ncei.ts";
export {
  BOOTSTRAP_RUNS,
  cowRates,
  cowUnverifiedRates,
  LEVEL,
  METHODS,
  MIN_YEAR_COUNT,
  nceiRates,
  noReadOf,
  RATES_FORMAT,
  ratesFile,
  type CowRate,
  type CowUnverifiedRate,
  type NceiRate,
  type PerYear,
  type Range,
  type RatesFile,
  type RatesInput,
  type Share,
} from "./rates.ts";
export { committedPriors, PRIORS_URL } from "./committed.ts";
export { priorsOf } from "./priors.ts";
export { ratesSummary, TOP_TYPES, TOP_UNDER, type GateResult } from "./summary.ts";
export {
  HarmJoin,
  isPlaced,
  NCEI_TERRITORIES,
  NCEI_WATERS,
  NCEI_ZONE_HOURS,
  nceiKindOf,
  nceiTime,
  nceiTypesOf,
  placeAll,
  placeHarm,
  UNDER_MARGIN_MS,
  underSection,
  zoneHours,
  type ActiveRow,
  type HarmCount,
  type HarmEvent,
  type JoinMatch,
  type UnderInput,
  type UnderKind,
  type UnderRate,
  type UnderSection,
  type UnplacedHarm,
  type UnplacedReason,
} from "./under.ts";
export {
  ALERT_PHENOMENA,
  ALERT_SIGNIFICANCES,
  alertKey,
  AlertTally,
  alertWindows,
  MARINE_PHENOMENA,
  MARINE_REASON,
  NATIONAL_NUMBERS,
  nationalNumber,
  NUMBERING_MIN_SHARED,
  NUMBERING_TOGETHER_SHARE,
  numberingDoubts,
  readWatchwarn,
  TOGETHER_MS,
  WATCHWARN_COLUMNS,
  WATCHWARN_PARAMS,
  WATCHWARN_URL,
  watchwarnQuery,
  watchwarnTime,
  type AlertCounts,
  type AlertRow,
  type AlertSignificance,
  type NumberingCheck,
  type WatchwarnRead,
} from "./watchwarn.ts";
export { ALERT_YEARS, COW_YEARS, eachYear, lastFullYear, measureYears, NCEI_YEARS, parseYears, type Years } from "./years.ts";

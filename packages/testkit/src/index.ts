/**
 * This package holds the fault suite of the alert system. Each case puts a fault proxy of `@mark1russell7/rigor-proxy`
 * between a source and a scripted server. The gate of the case examines the outcome of each fault.
 */
export {
  BODY_PARTS,
  MAIN_PATH,
  NWS_WATCH,
  baselineOf,
  caseBodies,
  fetchOnce,
  mainAfter,
  sameHead,
  startNwsServer,
  type Baseline,
  type CaseBodies,
  type FetchLimits,
  type OutcomeSummary,
} from "./nws.ts";
export { CASE_1_DRAWS, CASE_1_ID, CASE_1_LIMITS, runCutInBody, verdictOf, type CaseOptions, type CaseRun, type CutRecord, type Verdict } from "./cut-in-body.ts";
export {
  CASE_2_ID,
  CASE_2_SETTINGS,
  SLOW_ARMS,
  runSlowSource,
  slowVerdictOf,
  stallPoints,
  trickleMs,
  type SlowArm,
  type SlowOptions,
  type SlowRecord,
  type SlowRun,
  type SlowSettings,
  type SlowVerdict,
} from "./slow-source.ts";

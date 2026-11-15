/**
 * This package holds the fault suite of the alert system. Each case puts a fault proxy of `@mark1russell7/rigor-proxy`
 * between a source and a scripted server. The gate of the case examines the outcome of each fault.
 */
export {
  CASE_1_DRAWS,
  CASE_1_ID,
  CASE_1_PARTS,
  CASE_1_WATCH,
  MAIN_PATH,
  caseBodies,
  runCutInBody,
  verdictOf,
  type Baseline,
  type CaseOptions,
  type CaseRun,
  type CutRecord,
  type OutcomeSummary,
  type Verdict,
} from "./cut-in-body.ts";

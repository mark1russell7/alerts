/**
 * The shadow score of an incident: the probability of the event and the harm of one event, from public
 * measures. The score operates next to the table, and it does not decide a level at this time. The table
 * decides each send, and the gate test of `score.test.ts` holds this.
 */

import { assess, DEFAULT_ASSESS_POLICY, hasKind } from "./assess.ts";
import type { AssessPolicy, Assessment, Certainty, Incident, KindPrior, PersonWatch, ScoreFactor, ScoreGap, ScorePriors, ShadowScore, WatchedPlace } from "./contracts.ts";

/** The format of a file of priors. */
export const PRIORS_FORMAT: ScorePriors["format"] = "alerts-priors/1";

// The field of the longest prefix of the kind that has the field. A prefix ends at a dot, as in `hasKind`.
function kindFactor(priors: ScorePriors, kind: string, field: keyof KindPrior): ScoreFactor | undefined {
  let found: ScoreFactor | undefined;
  for (const [key, prior] of Object.entries(priors.kinds)) {
    const estimate = prior[field];
    if (estimate === undefined || !hasKind([key], kind)) continue;
    if (found === undefined || key.length > found.from.key.length) found = { estimate, from: { table: "kinds", key } };
  }
  return found;
}

// The probability of a CAP certainty value.
function certaintyFactor(priors: ScorePriors, certainty: Certainty): ScoreFactor | undefined {
  const estimate = priors.certainty[certainty];
  return estimate === undefined ? undefined : { estimate, from: { table: "certainty", key: certainty } };
}

/**
 * This function calculates the shadow score of an incident from the priors.
 *
 * - The probability of an observed event is the probability of the certainty `observed`.
 * - Else the probability of a warning is the verified share of the warnings of its kind. The measure of
 *   the warnings is data, so it decides over the certainty word of the sender.
 * - Else the probability is that of the certainty of the incident.
 * - The deaths and the injuries of one event come from the longest prefix of the kind with each field.
 *
 * A factor that the priors do not give makes a score with no read. The score names each missing factor.
 */
export function shadowScore(incident: Pick<Incident, "kind" | "certainty">, priors: ScorePriors): ShadowScore {
  const code = incident.kind.code;
  const verified = incident.certainty !== "observed" && incident.kind.significance === "warning" ? kindFactor(priors, code, "verified") : undefined;
  const probability = verified ?? certaintyFactor(priors, incident.certainty);
  const deaths = kindFactor(priors, code, "deaths");
  const injuries = kindFactor(priors, code, "injuries");
  if (probability !== undefined && deaths !== undefined && injuries !== undefined) return { read: true, probability, deaths, injuries };
  const missing: ScoreGap[] = [];
  if (probability === undefined) missing.push("probability");
  if (deaths === undefined) missing.push("deaths");
  if (injuries === undefined) missing.push("injuries");
  return { read: false, missing };
}

/**
 * This function gives the assessment of `assess`, with the shadow score as its last reason. The score
 * does not change the level or the other reasons. An assessment with no reason of the table gets no
 * score. Examples are an ended incident, a status that the policy does not send and an incident with no match.
 */
export function assessWithShadow(
  incident: Incident,
  person: PersonWatch,
  places: readonly WatchedPlace[],
  priors: ScorePriors,
  policy: AssessPolicy = DEFAULT_ASSESS_POLICY,
): Assessment {
  const assessment = assess(incident, person, places, policy);
  if (!assessment.reasons.some((reason) => reason.kind === "table")) return assessment;
  return { ...assessment, reasons: [...assessment.reasons, { kind: "shadow", score: shadowScore(incident, priors) }] };
}

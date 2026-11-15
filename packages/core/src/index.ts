/**
 * The signal core of the alert system. It holds the contracts of the event, the source and the
 * channel. It also holds the id functions, the merge, the first assessment and the escalation.
 * `docs/CONTRACTS.md` explains them.
 */
export * from "./contracts.ts";
export * from "./ids.ts";
export * from "./merge.ts";
export * from "./assess.ts";
export * from "./escalation.ts";

/**
 * The signal core of the alert system. It holds the contracts of the event, the source and the
 * channel. It also holds the id functions, the merge, the first assessment, the escalation, the
 * health of the sources and the coverage.
 * `docs/CONTRACTS.md` explains them.
 */
export * from "./contracts.ts";
export * from "./ids.ts";
export * from "./merge.ts";
export * from "./assess.ts";
export * from "./escalation.ts";
export * from "./health.ts";
export * from "./coverage.ts";

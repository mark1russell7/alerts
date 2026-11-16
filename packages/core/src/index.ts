/**
 * The signal core of the alert system. It holds the contracts of the event, the source and the
 * channel. It also holds the id functions, the merge, the first assessment and the escalation. It
 * holds the health of the sources, the lateness across sources, the coverage, the system reports and
 * the view of the map.
 *
 * It holds the taxonomy of the kinds. The map functions put their problems in its collector.
 * `docs/CONTRACTS.md` explains them.
 */
export * from "./contracts.ts";
export * from "./ids.ts";
export * from "./merge.ts";
export * from "./assess.ts";
export * from "./score.ts";
export * from "./escalation.ts";
export * from "./chain.ts";
export * from "./delivery.ts";
export * from "./why.ts";
export * from "./config.ts";
export * from "./health.ts";
export * from "./coverage.ts";
export * from "./lateness.ts";
export * from "./basemap.ts";
export * from "./map.ts";
export * from "./problems.ts";
export * from "./relevance.ts";
export * from "./schemas.ts";
export * from "./shapes.ts";
export * from "./system-reports.ts";
export * from "./taxonomy.ts";

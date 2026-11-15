/**
 * The collector of the problems of a map function. Each adapter makes lists of `MapProblem`, so the
 * core is the home of the collector. A reader of a format takes a `ProblemSink`.
 */

import type { MapProblem } from "./contracts.ts";

/** The place where a map function or a reader puts the problems of a message. */
export interface ProblemSink {
  add(path: string, message: string, fatal?: boolean): void;
}

/**
 * The problems of one message, in order. The collector puts its prefix before each path: the prefix
 * `features[3]` and the path `properties.onset` give `features[3].properties.onset`.
 */
export class Problems implements ProblemSink {
  readonly list: MapProblem[] = [];
  private readonly prefix: string;

  /** The prefix is the path of the message. The default is no prefix. */
  constructor(prefix = "") {
    this.prefix = prefix;
  }

  /** This method adds one problem. A problem is not fatal if the caller does not say so. */
  add(path: string, message: string, fatal = false): void {
    const full = this.prefix === "" ? path : path === "" ? this.prefix : `${this.prefix}.${path}`;
    this.list.push({ path: full, message, fatal });
  }

  /** The count of the fatal problems. A `FetchRecord` holds this count for the observations of a fetch. */
  get fatal(): number {
    return this.list.filter((problem) => problem.fatal).length;
  }
}

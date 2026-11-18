/**
 * The choice of the pages that a host reads. A report of a status page has no area, so only a person with an interest
 * graph or a subject watch can get it. A host reads only the pages that one of its persons can get.
 */

import { hasKind, nodesOverlap, type PersonWatch } from "@mark1russell7/alerts";

import { nodeOf, pageSubjects, type StatusPage } from "./page.ts";
import { STATUS_PAGES } from "./register.ts";

const TOPIC = "topic:";

/** The fields of a page that the choice reads. A feed of one provider with no area gives the same fields. */
export type ReadTarget = Pick<StatusPage, "domain" | "kind" | "components">;

/**
 * This function tells if a person can get the reports of a page. One edge of the interest graph is on at a node that
 * overlaps a subject of the page (`pageSubjects`). Or one edge that is on comes from a topic of the kind of the page. Or
 * the person watches a system of a subject of the page, or a subject that overlaps one.
 *
 * Two nodes overlap when one covers the other (`nodesOverlap` of the core). A domain covers only itself. A path covers
 * each path below it.
 */
export function watchReads(watch: PersonWatch, page: ReadTarget): boolean {
  const subjects = pageSubjects(page);
  const nodes = subjects.map(nodeOf);
  const reaches = (node: string): boolean => nodes.some((each) => nodesOverlap(each, node));
  const edges = (watch.interests?.edges ?? []).filter((edge) => edge.on);
  if (edges.some((edge) => reaches(edge.from) || reaches(edge.to))) return true;
  if (edges.some((edge) => edge.from.startsWith(TOPIC) && hasKind([edge.from.slice(TOPIC.length)], page.kind))) return true;
  return (watch.subjects ?? []).some((subject) =>
    subject.id === undefined ? subjects.some((each) => each.system === subject.system) : reaches(nodeOf({ system: subject.system, id: subject.id })),
  );
}

/**
 * This function gives the pages of `pages` that one or more of the persons can get, in the order of `pages`. With no
 * such person, it gives an empty list, and the host sends no request to a status page.
 */
export function pagesFor(watches: readonly PersonWatch[], pages: readonly StatusPage[] = STATUS_PAGES): readonly StatusPage[] {
  return pages.filter((page) => watches.some((watch) => watchReads(watch, page)));
}

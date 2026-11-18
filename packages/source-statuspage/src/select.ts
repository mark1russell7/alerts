/**
 * The choice of the pages that a host reads. A report of a status page has no area, so only a person with an interest
 * graph or a subject watch can get it. A host reads only the pages that one of its persons can get.
 */

import { hasKind, type PersonWatch } from "@mark1russell7/alerts";

import { SUBJECT_SYSTEM, type StatusPage } from "./page.ts";
import { STATUS_PAGES } from "./register.ts";

const TOPIC = "topic:";

/**
 * This function tells if a person can get the reports of a page. The interest graph of the person has an edge that is
 * on at the node of the domain of the service, or an edge from a topic of the kind of the page. Or the person watches
 * the subjects of the system `domain`, or the domain of the service.
 */
export function watchReads(watch: PersonWatch, page: StatusPage): boolean {
  const node = `${SUBJECT_SYSTEM}:${page.domain}`;
  const edges = (watch.interests?.edges ?? []).filter((edge) => edge.on);
  if (edges.some((edge) => edge.from === node || edge.to === node)) return true;
  if (edges.some((edge) => edge.from.startsWith(TOPIC) && hasKind([edge.from.slice(TOPIC.length)], page.kind))) return true;
  return (watch.subjects ?? []).some((subject) => subject.system === SUBJECT_SYSTEM && (subject.id === undefined || subject.id === page.domain));
}

/**
 * This function gives the pages of `pages` that one or more of the persons can get, in the order of `pages`. With no
 * such person, it gives an empty list, and the host sends no request to a status page.
 */
export function pagesFor(watches: readonly PersonWatch[], pages: readonly StatusPage[] = STATUS_PAGES): readonly StatusPage[] {
  return pages.filter((page) => watches.some((watch) => watchReads(watch, page)));
}

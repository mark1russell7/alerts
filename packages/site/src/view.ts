/**
 * The view of the demo. It draws one frame of the replay: the map, the view by level, the sources,
 * the incidents and the message of the step. The view only draws: the frames hold each decision.
 */

import { areasWithoutBlocks, type Assessment, type HealthState, type Incident, type Report, type Position } from "@mark1russell7/alerts";
import { h } from "@mark1russell7/site-pages/chrome";
import { LEVEL_WORDS, levelChip, s } from "./draw.ts";
import { COUNTIES, PEOPLE, PLACES, RIVER, SOURCES, ZONES, type Zone } from "./demo.ts";
import {
  changeText,
  clock,
  HEALTH_WORDS,
  incidentLabel,
  joinFacts,
  KIND_WORDS,
  LEVEL_MEANINGS,
  nameOf,
  OP_WORDS,
  reasonText,
  shortName,
} from "./explain.ts";
import { LEVELS_DOWN, topLevel, type Frame } from "./replay.ts";

// The map puts the longitude 0 to 1 on x and the latitude 0.6 to 0 on y. The sea is below the latitude 0.
const X = (position: Position): number => Math.round(position[0] * 1000);
const Y = (position: Position): number => Math.round((0.6 - position[1]) * 1000);
const path = (ring: readonly Position[]): string => `M${ring.map((point) => `${String(X(point))},${String(Y(point))}`).join("L")}Z`;
const line = (points: readonly Position[]): string => `M${points.map((point) => `${String(X(point))},${String(Y(point))}`).join("L")}`;

/** This function gives the zones that the code areas of an incident cover. */
export function zonesOf(incident: Pick<Incident, "areas">): Zone[] {
  const codes = new Set(incident.areas.flatMap((area) => (area.type === "code" ? [`${area.system}:${area.code}`] : [])));
  return ZONES.filter((zone) => {
    const county = COUNTIES.find((one) => one.code === zone.county);
    return codes.has(`ugc:${zone.code}`) || codes.has(`ugc:${zone.county}`) || (county !== undefined && codes.has(`same:${county.same}`));
  });
}

const centroid = (ring: readonly Position[]): Position => [
  ring.reduce((sum, point) => sum + point[0], 0) / ring.length,
  ring.reduce((sum, point) => sum + point[1], 0) / ring.length,
];

/** This function gives the assessments of one incident. */
const of = (frame: Frame, incident: Incident): Assessment[] => frame.assessments.filter((assessment) => assessment.incident === incident.anchor);

/** This function gives each incident of a frame: the incidents of the source and of the system reports. */
const allIncidents = (frame: Frame): Incident[] => [...frame.incidents, ...frame.sources.incidents];

/** This function gives each assessment of a frame: the assessments of the source and of the system reports. */
const allAssessments = (frame: Frame): Assessment[] => [...frame.assessments, ...frame.sources.assessments];

/** This function gives the incident level class of the map: the highest level of a person, or `test`. */
function levelClass(frame: Frame, incident: Incident): string {
  if (incident.status !== "actual") return "test";
  return `level-${topLevel(of(frame, incident))}`;
}

/** This function draws the map of one frame. */
export function drawMap(frame: Frame, selected: string | undefined, select: (anchor: string) => void): SVGElement {
  const map = s("svg", { viewBox: "-10 -10 1020 690", role: "img", "aria-labelledby": "map-title", class: "map" });
  map.append(s("title", { id: "map-title" }, "A map of the made-up region: four zones, the river, the two homes and the areas of the live incidents."));
  map.append(s("rect", { class: "sea", x: -10, y: 600, width: 1020, height: 80 }));
  map.append(s("text", { class: "sea-label", x: 930, y: 655 }, "Sea"));
  for (const zone of ZONES) map.append(s("path", { class: "zone", d: path(zone.ring) }));

  const live = frame.incidents.filter((incident) => incident.live);
  for (const incident of live) {
    const chosen = selected === incident.anchor;
    const group = s("g", {
      class: `incident ${levelClass(frame, incident)}${chosen ? " selected" : ""}${selected !== undefined && !chosen ? " dim" : ""}`,
      "data-anchor": incident.anchor,
    });
    for (const zone of zonesOf(incident)) group.append(s("path", { class: "area", d: path(zone.ring) }));
    for (const area of areasWithoutBlocks(incident.areas)) {
      if (area.type === "polygon") for (const ring of area.rings) group.append(s("path", { class: "shape", d: path(ring) }));
    }
    group.addEventListener("click", () => select(incident.anchor));
    map.append(group);
  }

  map.append(s("path", { class: "river", d: line(RIVER) }));
  for (const zone of ZONES) {
    const [x, y] = centroid(zone.ring);
    const label = s("text", { class: "zone-label", x: X([x, y]), y: Y([x, y]) - 40 }, zone.name);
    label.append(s("tspan", { class: "zone-code", x: X([x, y]), dy: 26 }, zone.code));
    map.append(label);
  }
  // A ring marks each home that a live system report names as its area: a gap of the coverage.
  for (const incident of frame.sources.incidents.filter((one) => one.live)) {
    for (const area of incident.areas) {
      const place = area.type === "place" ? PLACES.find((one) => one.id === area.place) : undefined;
      if (place?.at === undefined) continue;
      const level = topLevel(frame.sources.assessments.filter((assessment) => assessment.incident === incident.anchor));
      map.append(s("circle", { class: `gap level-${level}`, "data-place": place.id, cx: X(place.at), cy: Y(place.at), r: 42 }));
    }
  }
  for (const place of PLACES) {
    if (place.at === undefined) continue;
    const person = PEOPLE.find((one) => one.places.includes(place.id));
    const level = person === undefined ? "none" : topLevel(allAssessments(frame).filter((assessment) => assessment.person === person.person));
    const letter = person === undefined ? "?" : nameOf(person.person).slice(-1);
    const pin = s("g", { class: `pin level-${level}`, transform: `translate(${String(X(place.at))},${String(Y(place.at))})` });
    pin.append(s("circle", { r: 22 }), s("text", { y: 8 }, letter));
    map.append(pin);
  }
  return map;
}

/**
 * This function draws the view by level: a lane for each level, with each person and incident in it.
 * The lanes also hold the system reports, because the same assessment gives their levels.
 */
export function drawLevels(frame: Frame): HTMLElement {
  const lanes = h("div", { class: "lanes" });
  const incidents = allIncidents(frame);
  for (const level of LEVELS_DOWN) {
    const here = allAssessments(frame).filter((assessment) => assessment.level === level && (level !== "none" || isLive(incidents, assessment)));
    const lane = h(
      "section",
      { class: `lane level-${level}`, "data-level": level, "aria-label": LEVEL_WORDS[level] },
      h("h4", {}, h("span", { class: "dot", "aria-hidden": "true" }), LEVEL_WORDS[level], h("span", { class: "count" }, String(here.length))),
      h("p", { class: "meaning" }, LEVEL_MEANINGS[level]),
    );
    const list = h("ul", {});
    for (const assessment of here) {
      const incident = incidents.find((one) => one.anchor === assessment.incident);
      if (incident === undefined) continue;
      list.append(
        h(
          "li",
          { class: `entry${incident.status === "system" ? " system" : ""}`, "data-person": assessment.person },
          h(
            "details",
            {},
            h("summary", {}, h("strong", {}, nameOf(assessment.person)), " · ", incidentLabel(incident)),
            h("ol", { class: "reasons" }, ...assessment.reasons.map((reason) => h("li", {}, reasonText(reason, incident)))),
          ),
        ),
      );
    }
    if (here.length === 0) list.append(h("li", { class: "empty" }, "Nobody"));
    lane.append(list);
    lanes.append(lane);
  }
  return lanes;
}

// The lane `none` shows only the live incidents. An ended incident sends nothing, and the incident list shows it.
const isLive = (incidents: readonly Incident[], assessment: Assessment): boolean => incidents.some((incident) => incident.anchor === assessment.incident && incident.live);

/** This function draws the list of the incidents, with the reports of each and the facts that join them. */
export function drawIncidents(frame: Frame, selected: string | undefined, select: (anchor: string) => void): HTMLElement {
  const list = h("div", { class: "incidents" });
  if (frame.incidents.length === 0) list.append(h("p", { class: "empty" }, "No incidents yet."));
  const byId = new Map<string, Report>(frame.state.reports.map((report) => [report.id, report]));
  const fresh = new Set<string>(frame.reports.map((report) => report.id));
  for (const incident of frame.incidents) {
    const reports = incident.reports.flatMap((id) => byId.get(id) ?? []).sort((a, b) => a.sent - b.sent);
    const level = topLevel(of(frame, incident));
    const card = h(
      "article",
      {
        class: `incident-card${selected === incident.anchor ? " selected" : ""}${incident.live ? "" : " ended"}`,
        "data-anchor": incident.anchor,
        tabindex: 0,
        "aria-label": `${incident.kind.label}, ${incident.live ? "live" : "ended"}`,
      },
      h(
        "header",
        {},
        h("h4", {}, incident.kind.label),
        h("span", { class: `chip ${incident.live ? "live" : "ended"}` }, incident.live ? "Live" : "Ended"),
        incident.status === "actual" ? null : h("span", { class: "chip test" }, `Status: ${incident.status}`),
        levelChip(level),
      ),
      h("p", { class: "facts" }, `Severity ${incident.severity}, urgency ${incident.urgency}, certainty ${incident.certainty}. ${String(reports.length)} message${reports.length === 1 ? "" : "s"}.`),
    );
    const steps = h("ol", { class: "reports" });
    reports.forEach((report, index) => {
      const facts = joinFacts(report, reports.slice(0, index));
      steps.append(
        h(
          "li",
          { class: fresh.has(report.id) ? "new" : "" },
          h("span", { class: "when" }, clock(report.sent)),
          h("span", { class: `op op-${report.op}` }, OP_WORDS[report.op]),
          h("span", { class: "who" }, report.sender),
          ...facts.map((fact) => h("span", { class: "join" }, `Merge rule ${String(fact.rule)}: ${fact.text}`)),
        ),
      );
    });
    card.append(steps);
    card.addEventListener("click", () => select(incident.anchor));
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        select(incident.anchor);
      }
    });
    list.append(card);
  }
  return list;
}

/** This function draws the message of the step: the raw text, the report and the problems of the map. */
export function drawMessage(frame: Frame): HTMLElement {
  const box = h("div", { class: "message" });
  const message = frame.step.message;
  if (message === undefined) {
    box.append(h("p", { class: "empty" }, "No message arrives in this step. Only the time changes."));
    return box;
  }
  const report = frame.reports[0];
  if (report !== undefined) {
    box.append(
      h("p", { class: "headline" }, report.headline),
      h("p", { class: "facts" }, `${report.sender}, ${clock(report.sent)}. Type: ${OP_WORDS[report.op]}. Kind: ${report.kind.code}.`),
    );
  }
  const problems = frame.problems.length;
  box.append(
    h("p", { class: problems === 0 ? "ok" : "bad", "data-problems": problems }, `The map function made ${String(frame.reports.length)} report, with ${String(problems)} problem${problems === 1 ? "" : "s"}.`),
    h("details", {}, h("summary", {}, `The message, as the source gives it (${message.name})`), h("pre", {}, h("code", {}, message.body))),
  );
  if (report !== undefined) {
    const shown = {
      key: report.key,
      status: report.status,
      op: report.op,
      kind: report.kind,
      severity: report.severity,
      urgency: report.urgency,
      certainty: report.certainty,
      references: report.references,
      correlation: report.correlation,
      areas: report.areas.map((area) => (area.type === "code" ? `${area.system}:${area.code}` : area.type)),
    };
    box.append(h("details", {}, h("summary", {}, "The report that the core gets"), h("pre", {}, h("code", {}, JSON.stringify(shown, null, 2)))));
  }
  return box;
}

/**
 * This function gives the four counts of the pipeline at a frame. The reports, the incidents and
 * the levels include the system reports, because the merge and the assessment carry them too.
 */
export function counts(frames: readonly Frame[], index: number): { messages: number; reports: number; incidents: number; levels: number } {
  const frame = frames[index]!;
  return {
    messages: frames.slice(0, index + 1).filter((one) => one.step.message !== undefined).length,
    reports: frame.state.reports.length,
    incidents: allIncidents(frame).filter((incident) => incident.live).length,
    levels: allAssessments(frame).filter((assessment) => assessment.level !== "none").length,
  };
}

/** The class of the chip of each health state. */
const STATE_TONES: Readonly<Record<HealthState, string>> = {
  unknown: "quiet",
  healthy: "good",
  slow: "warn",
  failing: "bad",
  silent: "bad",
  changed: "bad",
};

/**
 * This function draws the sources of one frame. It shows the health of each source and the
 * coverage of each kind at each home. It also shows the system reports and the level of each person.
 */
export function drawSources(frame: Frame): HTMLElement {
  const { sources } = frame;

  const health = h("ul", { class: "health", "aria-label": "The health of each source" });
  for (const entry of sources.health) {
    const descriptor = SOURCES.find((source) => source.id === entry.source);
    health.append(
      h(
        "li",
        { class: "source", "data-source": entry.source, "data-state": entry.state },
        h("div", { class: "row" }, h("strong", {}, shortName(entry.source)), h("span", { class: `chip state ${STATE_TONES[entry.state]}` }, HEALTH_WORDS[entry.state])),
        h("p", { class: "facts" }, `Since ${clock(entry.since)}. ${entry.reason}`),
        descriptor === undefined ? null : h("p", { class: "domains" }, "Outside domains: ", ...descriptor.dependsOn.flatMap((domain, index) => [index === 0 ? "" : ", ", h("code", {}, domain)])),
        ...sources.transitions.filter((change) => change.instance === entry.source).map((change) => h("p", { class: "change" }, changeText(change))),
      ),
    );
  }

  const coverage = h("ul", { class: "coverage", "aria-label": "The coverage of each kind at each home" });
  for (const entry of sources.coverage) {
    coverage.append(
      h(
        "li",
        { class: entry.short ? "short" : "met", "data-place": entry.place, "data-kind": entry.kind },
        h("span", { class: "home" }, shortName(entry.place)),
        h("span", { class: "kind" }, KIND_WORDS[entry.kind] ?? entry.kind),
        h("span", { class: "count" }, `${String(entry.independent)} of ${String(entry.required)}`),
        h("span", { class: `chip ${entry.short ? "bad" : "good"}` }, entry.short ? "Short" : "Met"),
        h("span", { class: "up" }, entry.sources.length === 0 ? "No source is up." : `Up: ${entry.sources.map(shortName).join(", ")}`),
      ),
    );
  }

  const reports = h("div", { class: "system", "aria-label": "The system reports" });
  if (sources.incidents.length === 0) reports.append(h("p", { class: "empty" }, "No system report. Each source is up, and each coverage meets the policy."));
  const byId = new Map<string, Report>(frame.state.reports.map((report) => [report.id, report]));
  const fresh = new Set<string>(sources.reports.map((report) => report.id));
  for (const incident of sources.incidents) {
    const lines = incident.reports.flatMap((id) => byId.get(id) ?? []).sort((a, b) => a.sent - b.sent || (a.key < b.key ? -1 : 1));
    const assessments = sources.assessments.filter((assessment) => assessment.incident === incident.anchor);
    const card = h(
      "article",
      { class: `system-card${incident.live ? "" : " ended"}`, "data-kind": incident.kind.code, "aria-label": `${incidentLabel(incident)}, ${incident.live ? "live" : "ended"}` },
      h(
        "header",
        {},
        h("h5", {}, incidentLabel(incident)),
        h("span", { class: `chip ${incident.live ? "live" : "ended"}` }, incident.live ? "Live" : "Ended"),
        levelChip(topLevel(assessments)),
      ),
      h("p", { class: "facts" }, `Severity ${incident.severity}, urgency ${incident.urgency}.`),
    );
    const steps = h("ol", { class: "reports" });
    lines.forEach((report, index) => {
      steps.append(
        h(
          "li",
          { class: fresh.has(report.id) ? "new" : "" },
          h("span", { class: "when" }, clock(report.sent)),
          h("span", { class: `op op-${report.op}` }, OP_WORDS[report.op]),
          h("span", { class: "said" }, report.headline),
          report.description === undefined ? null : h("span", { class: "said quiet" }, report.description),
          ...joinFacts(report, lines.slice(0, index)).map((fact) => h("span", { class: "join" }, `Merge rule ${String(fact.rule)}: ${fact.text}`)),
        ),
      );
    });
    const people = h(
      "ul",
      { class: "people" },
      ...assessments.map((assessment) =>
        h(
          "li",
          { "data-person": assessment.person, "data-level": assessment.level },
          h(
            "details",
            {},
            h("summary", {}, h("strong", {}, nameOf(assessment.person)), " ", levelChip(assessment.level)),
            h("ol", { class: "reasons" }, ...assessment.reasons.map((reason) => h("li", {}, reasonText(reason, incident)))),
          ),
        ),
      ),
    );
    card.append(steps, people);
    reports.append(card);
  }

  return h(
    "div",
    { class: "sources" },
    h("div", { class: "part" }, h("h4", {}, "Health"), health, h("h4", {}, "Coverage at each home"), h("p", { class: "hint" }, "Independent sources that are up, of the count that the policy needs."), coverage),
    h("div", { class: "part" }, h("h4", {}, "System reports"), reports),
  );
}

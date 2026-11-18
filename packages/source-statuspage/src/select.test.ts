import { servicesLayer, workLayer, type InterestEdge, type PersonId, type PersonWatch, type SubjectWatch } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { pagesFor, watchReads } from "./select.ts";
import { registeredPage, STATUS_PAGES } from "./register.ts";

const PERSON = "person-1" as PersonId;
const watchOf = (edges: readonly InterestEdge[] | undefined, subjects?: readonly SubjectWatch[]): PersonWatch => ({
  person: PERSON,
  places: [],
  rules: [],
  ...(edges === undefined ? {} : { interests: { format: "alerts-interest/1", person: PERSON, edges, mutes: [] } }),
  ...(subjects === undefined ? {} : { subjects }),
});
const idsOf = (watches: readonly PersonWatch[]) => pagesFor(watches).map((page) => page.id);

describe("pagesFor", () => {
  it("gives no page for persons with no graph and no subject watch", () => {
    expect(idsOf([])).toEqual([]);
    expect(idsOf([watchOf(undefined), watchOf([])])).toEqual([]);
  });

  it("gives the pages of the online services, the clouds and the DNS and CDN providers for the work software", () => {
    const pages = pagesFor([watchOf(workLayer(["software"]))]);
    expect(new Set(pages.map((page) => page.kind))).toEqual(new Set(["infra.saas.outage", "infra.cloud.outage", "infra.internet.dns-cdn"]));
    expect(pages.map((page) => page.id)).toEqual(STATUS_PAGES.filter((page) => page.kind.startsWith("infra.") && page.kind !== "infra.payments.outage").map((page) => page.id));
  });

  it("gives the pages of the payment services and the brokers for the work finance", () => {
    expect(idsOf([watchOf(workLayer(["finance"]))])).toEqual(["statuspage-robinhood", "statuspage-visa-acceptance"]);
  });

  it("gives the page of a service that the person names, and the pages of each person in the order of the register", () => {
    expect(idsOf([watchOf(servicesLayer(["domain:coinbase.com"]))])).toEqual(["statuspage-coinbase"]);
    expect(idsOf([watchOf(servicesLayer(["domain:solana.com"])), watchOf(servicesLayer(["domain:chime.com"]))])).toEqual(["statuspage-chime", "statuspage-solana"]);
  });

  it("reads the domain of a service at each end of an edge of the graph", () => {
    const edge: InterestEdge = { id: "e1", from: "domain:cloudflare.com", to: "domain:example.com", kind: "cyber", weight: { value: 1, low: 1, high: 1 }, origin: "measured", on: true };
    expect(idsOf([watchOf([edge])])).toEqual(["statuspage-cloudflare"]);
    expect(idsOf([watchOf([{ ...edge, from: "domain:example.com", to: "domain:github.com" }])])).toEqual(["statuspage-github"]);
  });

  it("does not read a page for an edge that the person turned off", () => {
    expect(idsOf([watchOf(servicesLayer(["domain:coinbase.com"]).map((edge) => ({ ...edge, on: false })))])).toEqual([]);
  });

  it("gives each page for a watch of the system domain, and one page for a watch of one domain", () => {
    expect(idsOf([watchOf(undefined, [{ system: "domain" }])])).toEqual(STATUS_PAGES.map((page) => page.id));
    expect(idsOf([watchOf(undefined, [{ system: "domain", id: "github.com" }, { system: "alerts.source" }])])).toEqual(["statuspage-github"]);
  });

  it("gives the page of a service for the domain of an endpoint of one of its keys", () => {
    expect(idsOf([watchOf(servicesLayer(["domain:api.twilio.com"]))])).toEqual(["statuspage-twilio"]);
    expect(idsOf([watchOf(servicesLayer(["domain:api.pushover.net"]))])).toEqual(["statuspage-pushover"]);
  });
});

describe("watchReads", () => {
  it("reads a page of a kind under a topic of the graph, and not a page of a kind beside it", () => {
    const github = registeredPage("statuspage-github")!;
    const edge = (topic: string): InterestEdge => ({ id: topic, from: `topic:${topic}`, to: "person", kind: "interest", weight: { value: 0.5, low: 0, high: 1 }, origin: "work", on: true });
    expect(watchReads(watchOf([edge("infra")]), github)).toBe(true);
    expect(watchReads(watchOf([edge("infra.saas.outage")]), github)).toBe(true);
    expect(watchReads(watchOf([edge("infra.sa")]), github)).toBe(false);
    expect(watchReads(watchOf([edge("infra.cloud")]), github)).toBe(false);
  });

  it("reads a page for each domain of the page, and not for another subdomain of the service", () => {
    const twilio = registeredPage("statuspage-twilio")!;
    expect(watchReads(watchOf(servicesLayer(["domain:twilio.com"])), twilio)).toBe(true);
    expect(watchReads(watchOf(servicesLayer(["domain:api.twilio.com"])), twilio)).toBe(true);
    expect(watchReads(watchOf(undefined, [{ system: "domain", id: "api.twilio.com" }]), twilio)).toBe(true);
    expect(watchReads(watchOf(servicesLayer(["domain:video.twilio.com"])), twilio)).toBe(false);
    expect(watchReads(watchOf(servicesLayer(["domain:api.github.com"])), registeredPage("statuspage-github")!)).toBe(false);
  });

  it("reads the page of Twilio for a path that overlaps the path of a carrier component, and not for another path", () => {
    const twilio = registeredPage("statuspage-twilio")!;
    const reads = (node: string): boolean => watchReads(watchOf(servicesLayer([node])), twilio);
    // A channel of the SMS of North America covers each kind of number. A watch of a kind of number is below the SMS.
    for (const node of ["provider-region:twilio", "provider-region:twilio/europe", "provider-region:twilio/europe/sms", "provider-region:twilio/north-america/sms", "provider-region:twilio/north-america/sms/short-code/x"]) {
      expect(reads(node), node).toBe(true);
    }
    for (const node of ["provider-region:twilio/europe/mms", "provider-region:twilio/north-america/rcs", "provider-region:twilio-x", "provider-region:gcp/europe-west1", "domain:twilio/europe/sms"]) {
      expect(reads(node), node).toBe(false);
    }
    expect(watchReads(watchOf(undefined, [{ system: "provider-region", id: "twilio/apac" }]), twilio)).toBe(true);
    expect(watchReads(watchOf(undefined, [{ system: "provider-region" }]), twilio)).toBe(true);
    expect(watchReads(watchOf(undefined, [{ system: "provider-region" }]), registeredPage("statuspage-github")!)).toBe(false);
  });
});

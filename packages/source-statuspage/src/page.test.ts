import { knownKind, SUBJECT_SYSTEMS, type SourceId } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { isDomain, isPageBase, pageProblems, SUBJECT_SYSTEM, type StatusPage } from "./page.ts";
import { ATLASSIAN_STATUSPAGE, registeredPage, STATUS_PAGES } from "./register.ts";

const GOOD: StatusPage = { id: "statuspage-example" as SourceId, title: "Example", base: "https://status.example.test", origin: "example", domain: "example.test", kind: "infra.saas.outage", dependsOn: [ATLASSIAN_STATUSPAGE] };

describe("pageProblems", () => {
  it("gives no problem for a good config", () => {
    expect(pageProblems(GOOD)).toEqual([]);
    expect(pageProblems({ ...GOOD, interval: 60_000, slowAfter: 5000 })).toEqual([]);
  });

  it("gives one problem for each bad field, with no URL of the config in a text", () => {
    const base = "https://user:secret@status.example.test/api";
    const problems = pageProblems({ ...GOOD, id: "Status Page" as SourceId, title: " ", base, origin: "", domain: "Example.test", kind: "infra.saas.down", dependsOn: ["atlassian"], interval: 10, slowAfter: 1.5 });
    expect(problems).toHaveLength(9);
    expect(problems.join(" ")).not.toContain("secret");
    expect(pageProblems({ ...GOOD, dependsOn: [] })).toEqual(["the list of failure domains is empty"]);
  });

  it("accepts only a base with https, a host and nothing more", () => {
    expect(isPageBase("https://status.example.test")).toBe(true);
    for (const url of ["http://status.example.test", "https://status.example.test/", "https://status.example.test/api", "https://status.example.test:8443", "https://a:b@status.example.test", "status.example.test"]) expect(isPageBase(url), url).toBe(false);
  });

  it("accepts only a domain name in lower case with two or more labels", () => {
    for (const domain of ["github.com", "bitbucket.org", "a-b.example.co"]) expect(isDomain(domain), domain).toBe(true);
    for (const domain of ["GitHub.com", "localhost", "github.com/", "-a.com", "a..com", ""]) expect(isDomain(domain), domain).toBe(false);
  });
});

describe("SUBJECT_SYSTEM", () => {
  it("is a system of entities of the core, so the interest graph of a person reads the subject", () => {
    expect(SUBJECT_SYSTEMS[SUBJECT_SYSTEM]).toBe("entity");
  });
});

describe("STATUS_PAGES", () => {
  it("holds pages with good configs, unique ids, unique bases and known kinds, in the order of their ids", () => {
    expect(STATUS_PAGES.length).toBeGreaterThanOrEqual(30);
    for (const page of STATUS_PAGES) {
      expect(pageProblems(page), page.id).toEqual([]);
      expect(page.id.startsWith("statuspage-"), page.id).toBe(true);
      expect(knownKind(page.kind), page.id).toBe(true);
    }
    const ids = STATUS_PAGES.map((page) => page.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(new Set(STATUS_PAGES.map((page) => page.base)).size).toBe(ids.length);
    expect([...ids].sort()).toEqual(ids);
  });

  it("finds a page by its id", () => {
    expect(registeredPage("statuspage-github")).toMatchObject({ base: "https://www.githubstatus.com", domain: "github.com", kind: "infra.saas.outage", dependsOn: [ATLASSIAN_STATUSPAGE] });
    expect(registeredPage("statuspage-none")).toBeUndefined();
  });
});

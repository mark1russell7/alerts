import { knownKind, SUBJECT_SYSTEMS, type SourceId } from "@mark1russell7/alerts";
import { describe, expect, it } from "vitest";
import { endpointKey, isDomain, isPageBase, nodeOf, PAGE_FORMATS, pageProblems, pageSubjects, PATH_PATTERN, REGION_SYSTEM, regionKey, SUBJECT_SYSTEM, subjectsOf, type PageFormat, type StatusPage } from "./page.ts";
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

  it("accepts each format of a page, and gives a problem for a format that it does not know", () => {
    for (const format of PAGE_FORMATS) expect(pageProblems({ ...GOOD, format })).toEqual([]);
    expect(pageProblems({ ...GOOD, format: "rss" as PageFormat })).toEqual(['the format "rss" is not a format of a page']);
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

describe("the keys of the components", () => {
  it("gives one problem for each bad key of a component", () => {
    const problems = pageProblems({
      ...GOOD,
      components: [
        endpointKey("", "A", "a.example.test"),
        endpointKey("c1", " ", "API.example.test"),
        endpointKey("c1", "B", "example.test"),
        endpointKey("c2", "C", "push.example.test"),
        endpointKey("c2", "D", "push.example.test"),
        regionKey("c3", "E", "example/Europe/sms"),
        regionKey("c4", "F", "example"),
        { id: "c5", name: "G", subject: { system: "iso3166", id: "FR" } },
        { id: "c6", name: "H", subject: { system: "asn", id: " 13335" } },
      ],
    });
    expect(problems).toEqual([
      "a key of a component has no id",
      'the key of the component "c1" has no name',
      'the domain "API.example.test" of a component is not a domain name in lower case',
      'the key of the component "c1" gives the domain of the service',
      'the component "c2" has two keys with one subject',
      'the path "example/Europe/sms" of a component is not two or more lower-case parts with a / between two parts',
      'the path "example" of a component is not two or more lower-case parts with a / between two parts',
      'the subject system "iso3166" of the component "c5" is not a system of entities',
      'the subject of the component "c6" has an empty id, or spaces at an end of its id',
    ]);
  });

  it("accepts one component with two subjects, and a key of each system of entities", () => {
    const components = [
      endpointKey("c1", "Voice", "voice.example.test"),
      regionKey("c1", "Voice", "example/europe/voice"),
      { id: "c2", name: "Network", subject: { system: "asn", id: "13335" } },
    ];
    expect(pageProblems({ ...GOOD, components })).toEqual([]);
  });

  it("takes a path of two or more parts of lower-case letters, digits and single hyphens", () => {
    for (const path of ["a/b", "twilio/north-america/sms/long-code", "x1/y-2/z"]) expect(PATH_PATTERN.test(path), path).toBe(true);
    for (const path of ["a", "a/", "/a", "a//b", "a/B", "a/b-", "a/-b", "a/b--c", "a b/c", "a/b/"]) expect(PATH_PATTERN.test(path), path).toBe(false);
  });

  it("gives the domain of the service, then each subject of a key, with no subject twice", () => {
    expect(pageSubjects(GOOD).map(nodeOf)).toEqual(["domain:example.test"]);
    const keys = [
      endpointKey("a", "A", "api.example.test"),
      endpointKey("b", "B", "api.example.test"),
      regionKey("c", "C", "example/europe/sms"),
      endpointKey("d", "D", "push.example.test"),
      regionKey("e", "E", "example/europe/sms"),
    ];
    expect(pageSubjects({ ...GOOD, components: keys }).map(nodeOf)).toEqual(["domain:example.test", "domain:api.example.test", "provider-region:example/europe/sms", "domain:push.example.test"]);
  });

  it("gives the subjects of a report: the service first, then each other subject of its keys with the names of its components", () => {
    const keys = [
      endpointKey("a", "Messages", "api.example.test"),
      regionKey("b", "SMS, Europe", "example/europe/sms"),
      endpointKey("c", "Calls", "api.example.test"),
      regionKey("b", "SMS, Europe", "example/europe/sms"),
      { id: "d", name: "Home", subject: { system: SUBJECT_SYSTEM, id: GOOD.domain } },
    ];
    expect(subjectsOf(GOOD, keys)).toEqual([
      { system: SUBJECT_SYSTEM, id: GOOD.domain, label: GOOD.title },
      { system: SUBJECT_SYSTEM, id: "api.example.test", label: `${GOOD.title}: Messages, Calls` },
      { system: REGION_SYSTEM, id: "example/europe/sms", label: `${GOOD.title}: SMS, Europe` },
    ]);
  });
});

describe("SUBJECT_SYSTEM", () => {
  it("is a system of entities of the core, so the interest graph of a person reads the subject", () => {
    expect(SUBJECT_SYSTEMS[SUBJECT_SYSTEM]).toBe("entity");
    expect(SUBJECT_SYSTEMS[REGION_SYSTEM]).toBe("entity");
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

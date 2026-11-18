import { readFileSync } from "node:fs";
import { regionId as awsRegionId } from "@mark1russell7/alerts-source-aws";
import { regionId as gcpRegionId } from "@mark1russell7/alerts-source-gcp";
import { describe, expect, it } from "vitest";
import { AZURE_ALIASES, CLOUD_PROVIDERS, originRegion } from "./feed.ts";

describe("originRegion", () => {
  it("gives the region of an origin of each cloud provider", () => {
    expect(originRegion("google-europe-west2")).toMatchObject({ id: "gcp/europe-west2", provider: { domain: "cloud.google.com" } });
    expect(originRegion("amazon-eu-west-1")).toMatchObject({ id: "aws/eu-west-1", provider: { domain: "aws.amazon.com" } });
    expect(originRegion("microsoft-westeurope")).toMatchObject({ id: "azure/westeurope", provider: { domain: "azure.microsoft.com" } });
    expect(originRegion("oracle-eu-frankfurt-1")?.id).toBe("oci/eu-frankfurt-1");
  });

  it("gives the name of the status page of Azure for a service tag of Radar", () => {
    expect(originRegion("microsoft-centralfrance")?.id).toBe("azure/francecentral");
    expect(originRegion("microsoft-germanywc")?.id).toBe("azure/germanywestcentral");
    // Only Azure has the aliases.
    expect(originRegion("google-centralfrance")?.id).toBe("gcp/centralfrance");
  });

  it("gives undefined for an unknown prefix, a prefix with no region and a name of an object field", () => {
    for (const origin of ["acme-north-1", "google", "google-", "-west", "constructor-x", "toString-x", ""]) expect(originRegion(origin), origin).toBeUndefined();
  });

  it("gives an alias for each Azure origin of the real outage whose name is not a region of the status page of Azure", () => {
    const outage = (JSON.parse(readFileSync(new URL("../fixtures/outages-20261118.json", import.meta.url), "utf8")) as { result: { annotations: { origins: string[] }[] } }).result.annotations[0]!;
    const aliased = outage.origins.map((origin) => origin.replace(/^microsoft-/, "")).filter((region) => Object.hasOwn(AZURE_ALIASES, region));
    expect(aliased.sort()).toEqual(["brazilse", "centralfrance", "chilec", "germanyn", "germanywc", "norwaye", "norwayw", "southfrance", "switzerlandn", "switzerlandw"]);
  });

  it("gives the ids of the regions that the source packages of Google Cloud and AWS give", () => {
    expect(originRegion("google-europe-west2")?.id).toBe(gcpRegionId("europe-west2"));
    expect(originRegion("amazon-eu-west-1")?.id).toBe(awsRegionId("eu-west-1"));
    expect(CLOUD_PROVIDERS["oracle"]?.domain).toBeUndefined();
  });
});

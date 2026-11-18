import { HostScheduler } from "polite-crawler/politeness";
import { describe, expect, it } from "vitest";
import { AWS_BASE, AWS_DESCRIPTOR, createAwsSource, guidOf, regionId, serviceOf } from "./index.ts";

const clock = { now: () => 0, sleep: async () => {} };
const reply = async () => ({ status: 200, statusText: "OK", headers: {}, body: "" });

describe("createAwsSource", () => {
  it("gives the procedures of the source contract, with no check and no locate", () => {
    const source = createAwsSource({ pace: { scheduler: new HostScheduler(clock, 1), now: clock.now }, transport: reply, userAgent: "alerts-tests" });
    expect(source.describe()).toBe(AWS_DESCRIPTOR);
    expect(source.locate).toBeUndefined();
    expect(source.check).toBeUndefined();
    const observation = { id: "o" as never, source: AWS_DESCRIPTOR.id, fetched: 0, contentType: "application/json", body: "", transport: { latency: 0 } };
    expect(source.map({ observation }).reports).toEqual([]);
  });

  it("describes a snapshot poll each 5 minutes, with no key, no canary and the whole Earth as its coverage", () => {
    expect(AWS_DESCRIPTOR).toEqual({
      id: "aws-health",
      title: "AWS Health Dashboard: the events of the public cloud",
      origins: ["aws"],
      dependsOn: ["provider:aws"],
      uses: ["internet", "dns", "power"],
      kinds: ["infra.cloud.outage"],
      coverage: "global",
      transport: "poll",
      interval: 300_000,
      slowAfter: 15_000,
      auth: "none",
      listing: "snapshot",
    });
  });

  it("splits the key of a service into the service and its region, and gives the id of a region", () => {
    expect(serviceOf("multipleservices-me-central-1")).toEqual({ service: "multipleservices", region: "me-central-1" });
    expect(serviceOf("ec2-us-gov-east-1")).toEqual({ service: "ec2", region: "us-gov-east-1" });
    expect(serviceOf("aws-partner-central")).toEqual({ service: "aws-partner-central" });
    expect(serviceOf("cloudfront")).toEqual({ service: "cloudfront" });
    expect(regionId("eu-west-1")).toBe("aws/eu-west-1");
  });

  it("reads the key of the service and the time of an item from its guid", () => {
    expect(guidOf("https://status.aws.amazon.com/#multipleservices-me-central-1_1789468030")).toEqual({ key: "multipleservices-me-central-1", seconds: 1_789_468_030 });
    expect(guidOf("https://status.aws.amazon.com/#cloudfront")).toBeUndefined();
    expect(guidOf(undefined)).toBeUndefined();
  });

  it("gives the signal of the caller to the fetch: a fetch behind a parked host sends no request after the abort", async () => {
    // The sleep of the pace ends only at the abort. Thus without the signal the fetch waits for ever.
    const parked = { now: () => 0, sleep: (_ms: number, signal?: AbortSignal) => new Promise<void>((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal.reason as Error), { once: true })) };
    const scheduler = new HostScheduler(parked, 1);
    scheduler.park(new URL(AWS_BASE).host, 60_000);
    let sent = 0;
    const source = createAwsSource({
      pace: { scheduler, now: parked.now },
      transport: async () => {
        sent += 1;
        return { status: 200, statusText: "OK", headers: {}, body: "" };
      },
      userAgent: "alerts-tests",
    });
    const controller = new AbortController();
    const pending = source.fetch({ watch: { places: [] } }, controller.signal);
    controller.abort(new Error("The fetch ended at its limit."));
    await expect(pending).rejects.toThrow("The fetch ended at its limit.");
    expect(sent).toBe(0);
  });
});

import type { SourceDescriptor } from "@mark1russell7/alerts";
import { EMSC_DESCRIPTOR } from "@mark1russell7/alerts-source-emsc";
import { IEM_DESCRIPTOR } from "@mark1russell7/alerts-source-iem";
import { IPAWS_DESCRIPTOR } from "@mark1russell7/alerts-source-ipaws";
import { NWS_DESCRIPTOR } from "@mark1russell7/alerts-source-nws-api";
import { SWPC_DESCRIPTOR } from "@mark1russell7/alerts-source-swpc";
import { descriptorOf, TSUNAMI_CENTERS } from "@mark1russell7/alerts-source-tsunami";
import { USGS_DESCRIPTOR } from "@mark1russell7/alerts-source-usgs";
import { describe, expect, it } from "vitest";
import { readAtlas } from "./read.ts";

/** The descriptors of each adapter that the atlas adopts. A new adopted adapter needs a row here. */
const DESCRIPTORS: Readonly<Record<string, readonly SourceDescriptor[]>> = {
  "@mark1russell7/alerts-source-emsc": [EMSC_DESCRIPTOR],
  "@mark1russell7/alerts-source-iem": [IEM_DESCRIPTOR],
  "@mark1russell7/alerts-source-ipaws": [IPAWS_DESCRIPTOR],
  "@mark1russell7/alerts-source-nws-api": [NWS_DESCRIPTOR],
  "@mark1russell7/alerts-source-swpc": [SWPC_DESCRIPTOR],
  "@mark1russell7/alerts-source-tsunami": [descriptorOf(TSUNAMI_CENTERS.ntwc), descriptorOf(TSUNAMI_CENTERS.ptwc)],
  "@mark1russell7/alerts-source-usgs": [USGS_DESCRIPTOR],
};

/** The kinds of the failure domains that the path of the atlas and the `dependsOn` of a descriptor both give. */
const SHARED_KINDS = ["cdn", "carrier"];
const prefixOf = (id: string): string | null => (id.includes(":") ? id.slice(0, id.indexOf(":")) : null);

const atlas = readAtlas();
const kinds = new Map(atlas.paths.map((part) => [part.id, part.kind]));
const adopted = atlas.sources.filter((source) => source.decision === "adopt");

describe("the paths of the atlas and the descriptors of the adapters", () => {
  it("has the descriptors of each adopted adapter", () => {
    expect(adopted.map((source) => source.adapter).sort()).toEqual(Object.keys(DESCRIPTORS).sort());
  });

  // A shared CDN or carrier is a common fault of two sources. When one list lacks it, the coverage counts two sources as apart.
  it("gives each part of an adopted path that is not a host in the dependsOn of each descriptor of its adapter", () => {
    const missing = adopted.flatMap((source) =>
      (DESCRIPTORS[source.adapter ?? ""] ?? []).flatMap((descriptor) =>
        source.path.filter((id) => kinds.get(id) !== "host" && !descriptor.dependsOn.includes(id)).map((id) => `${descriptor.id} lacks ${id} of ${source.id}`),
      ),
    );
    expect(missing).toEqual([]);
  });

  it("gives each CDN and carrier of the dependsOn of a descriptor in the path of its adopted source", () => {
    const missing = adopted.flatMap((source) =>
      (DESCRIPTORS[source.adapter ?? ""] ?? []).flatMap((descriptor) =>
        descriptor.dependsOn
          .filter((id) => SHARED_KINDS.includes(prefixOf(id) ?? "") && !source.path.includes(id))
          .map((id) => `the path of ${source.id} lacks ${id} of ${descriptor.id}`),
      ),
    );
    expect(missing).toEqual([]);
  });
});

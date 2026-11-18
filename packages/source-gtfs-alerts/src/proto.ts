/**
 * The part of the GTFS Realtime schema that the source reads: the feed message, its header, and the service alert of each
 * entity. The field numbers come from `gtfs-realtime.proto` of the GTFS Realtime reference (Apache License 2.0,
 * https://gtfs.org/documentation/realtime/proto/). The decoder skips each field that is not in this part, for example
 * the trip updates and the vehicle positions of a feed that mixes them with the alerts.
 *
 * Each field is optional here, also the fields that the reference marks as required. Thus a feed with a missing field
 * gives a problem of the map, not an exception of the decoder. The enums stay numbers, so a new value of the reference
 * is not lost.
 */

import protobuf from "protobufjs/light.js";

const optional = (type: string, id: number): { type: string; id: number } => ({ type, id });
const repeated = (type: string, id: number): { rule: string; type: string; id: number } => ({ rule: "repeated", type, id });

/** The descriptor of the part of the schema, in the JSON format of protobufjs. */
export const GTFS_REALTIME_DESCRIPTOR = {
  nested: {
    transit_realtime: {
      nested: {
        FeedMessage: { fields: { header: optional("FeedHeader", 1), entity: repeated("FeedEntity", 2) } },
        FeedHeader: {
          fields: {
            gtfsRealtimeVersion: optional("string", 1),
            incrementality: optional("int32", 2),
            timestamp: optional("uint64", 3),
          },
        },
        FeedEntity: { fields: { id: optional("string", 1), isDeleted: optional("bool", 2), alert: optional("Alert", 5) } },
        Alert: {
          fields: {
            activePeriod: repeated("TimeRange", 1),
            informedEntity: repeated("EntitySelector", 5),
            cause: optional("int32", 6),
            effect: optional("int32", 7),
            url: optional("TranslatedString", 8),
            headerText: optional("TranslatedString", 10),
            descriptionText: optional("TranslatedString", 11),
            severityLevel: optional("int32", 14),
            causeDetail: optional("TranslatedString", 17),
            effectDetail: optional("TranslatedString", 18),
          },
        },
        TimeRange: { fields: { start: optional("uint64", 1), end: optional("uint64", 2) } },
        EntitySelector: {
          fields: {
            agencyId: optional("string", 1),
            routeId: optional("string", 2),
            routeType: optional("int32", 3),
            trip: optional("TripDescriptor", 4),
            stopId: optional("string", 5),
            directionId: optional("uint32", 6),
          },
        },
        TripDescriptor: { fields: { tripId: optional("string", 1), routeId: optional("string", 5), startDate: optional("string", 3) } },
        TranslatedString: { fields: { translation: repeated("Translation", 1) } },
        Translation: { fields: { text: optional("string", 1), language: optional("string", 2) } },
      },
    },
  },
};

const FEED_MESSAGE = protobuf.Root.fromJSON(GTFS_REALTIME_DESCRIPTOR).lookupType("transit_realtime.FeedMessage");

/** One translation of a text. */
export interface Translation {
  readonly text?: string;
  readonly language?: string;
}

/** A text in one or more languages. */
export interface TranslatedString {
  readonly translation?: readonly Translation[];
}

/** A time range of an alert, in seconds since the epoch. An absent end is open. */
export interface TimeRange {
  readonly start?: number;
  readonly end?: number;
}

/** The part of the network that an alert names. */
export interface EntitySelector {
  readonly agencyId?: string;
  readonly routeId?: string;
  readonly routeType?: number;
  readonly trip?: { readonly tripId?: string; readonly routeId?: string; readonly startDate?: string };
  readonly stopId?: string;
  readonly directionId?: number;
}

/** A service alert. */
export interface Alert {
  readonly activePeriod?: readonly TimeRange[];
  readonly informedEntity?: readonly EntitySelector[];
  readonly cause?: number;
  readonly effect?: number;
  readonly url?: TranslatedString;
  readonly headerText?: TranslatedString;
  readonly descriptionText?: TranslatedString;
  readonly severityLevel?: number;
  readonly causeDetail?: TranslatedString;
  readonly effectDetail?: TranslatedString;
}

/** An entity of the feed. The source reads only its alert. */
export interface FeedEntity {
  readonly id?: string;
  readonly isDeleted?: boolean;
  readonly alert?: Alert;
}

/** A feed message, with the part of the schema that the source reads. */
export interface FeedMessage {
  readonly header?: { readonly gtfsRealtimeVersion?: string; readonly incrementality?: number; readonly timestamp?: number };
  readonly entity?: readonly FeedEntity[];
}

/** This function decodes a feed message. It throws for bytes that are not a protobuf message. */
export function decodeFeed(bytes: Uint8Array): FeedMessage {
  const message = FEED_MESSAGE.decode(bytes);
  return FEED_MESSAGE.toObject(message, { longs: Number, arrays: false, defaults: false }) as FeedMessage;
}

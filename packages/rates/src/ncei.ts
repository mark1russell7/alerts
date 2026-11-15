/**
 * The deaths and injuries of each event type, from the Storm Events database of NOAA NCEI. The
 * database has one file of details for each year. Each row is one event in one county or zone, with
 * its type, its month, and its direct and indirect deaths and injuries.
 *
 * The functions read a file as a stream of texts. They keep only the sums of each type. They do not
 * keep a row or a state.
 */

import { parseCsv } from "@procedures/json/csv";

/** The folder of the Storm Events files of NCEI. */
export const NCEI_FOLDER_URL = "https://www.ncei.noaa.gov/pub/data/swdi/stormevents/csvfiles/";

/** One file of details: the events of one year, in a version of NCEI. */
export interface DetailsFile {
  readonly year: number;
  /** The date of the version, in the form `YYYYMMDD`. */
  readonly created: string;
  readonly name: string;
}

/**
 * This function finds the files of details in the page of the folder. For each year, it keeps the
 * file with the latest version. The files come in the order of their years.
 */
export function detailsFiles(page: string): DetailsFile[] {
  const latest = new Map<number, DetailsFile>();
  for (const match of page.matchAll(/StormEvents_details-ftp_v1\.0_d(\d{4})_c(\d{8})\.csv\.gz/g)) {
    const [name, year, created] = match as unknown as [string, string, string];
    const file = { year: Number(year), created, name };
    const known = latest.get(file.year);
    if (known === undefined || known.created < created) latest.set(file.year, file);
  }
  return [...latest.values()].sort((a, b) => a.year - b.year);
}

/** The longest text that `RecordFramer` keeps before it finds the end of a record: 8 MB. */
export const MAX_RECORD_TEXT = 8_000_000;

/**
 * A framer cuts a stream of CSV texts at the ends of whole records. A field in quotes can have a line
 * break. Thus a line break ends a record only when the count of quotes before it is even (RFC 4180).
 */
export class RecordFramer {
  #rest = "";
  #quotes = 0;

  /** This function adds a text of the stream. It gives the whole records that the stream completed, with their line breaks. */
  push(chunk: string): string {
    const scanned = this.#rest.length;
    this.#rest += chunk;
    let end = -1;
    for (let index = scanned; index < this.#rest.length; index += 1) {
      const char = this.#rest.charCodeAt(index);
      if (char === 34) this.#quotes += 1;
      else if (char === 10 && this.#quotes % 2 === 0) end = index;
    }
    if (end < 0) {
      if (this.#rest.length > MAX_RECORD_TEXT) throw new Error(`The CSV text has no end of a record in ${String(MAX_RECORD_TEXT)} characters. A quote is not closed.`);
      return "";
    }
    const records = this.#rest.slice(0, end + 1);
    this.#rest = this.#rest.slice(end + 1);
    this.#quotes = 0;
    for (let index = 0; index < this.#rest.length; index += 1) if (this.#rest.charCodeAt(index) === 34) this.#quotes += 1;
    return records;
  }

  /** This function gives the text after the last line break. The text must be a whole record or white space. */
  end(): string {
    if (this.#quotes % 2 !== 0) throw new Error("The CSV text ends in a field in quotes.");
    const rest = this.#rest;
    this.#rest = "";
    return rest;
  }
}

/** The columns of a file of details that the sums read. */
export const DETAILS_COLUMNS = ["BEGIN_YEARMONTH", "EVENT_ID", "EVENT_TYPE", "INJURIES_DIRECT", "INJURIES_INDIRECT", "DEATHS_DIRECT", "DEATHS_INDIRECT"] as const;

/** The sums of one event type. */
export interface Harm {
  /** The count of rows: one row for each event in one county or zone. */
  readonly events: number;
  readonly deathsDirect: number;
  readonly deathsIndirect: number;
  readonly injuriesDirect: number;
  readonly injuriesIndirect: number;
}

/** The sums of one file of details. */
export interface YearHarm {
  readonly year: number;
  /** The count of rows of the file. */
  readonly rows: number;
  /** The months of the year with one or more rows, from 1 to 12. */
  readonly months: readonly number[];
  /** The sums of each event type, by the name of NCEI. */
  readonly types: Readonly<Record<string, Harm>>;
}

const count = (text: string, column: string, id: string): number => {
  const value = text.trim();
  if (!/^\d+$/.test(value)) throw new Error(`The event ${id} has the bad ${column} ${JSON.stringify(text)}.`);
  return Number(value);
};

/**
 * This function sums the deaths and injuries of each event type in one file of details. It reads the
 * file as a stream of texts. It throws an error for a row of a different year or a bad count. It also
 * throws an error for a row with a different count of fields, or for an event id that is not unique.
 */
export async function sumDetails(texts: AsyncIterable<string> | Iterable<string>, year: number): Promise<YearHarm> {
  const framer = new RecordFramer();
  const types = new Map<string, { events: number; deathsDirect: number; deathsIndirect: number; injuriesDirect: number; injuriesIndirect: number }>();
  const months = new Set<number>();
  const ids = new Set<string>();
  let header: readonly string[] | undefined;
  let columns: Readonly<Record<(typeof DETAILS_COLUMNS)[number], number>> | undefined;
  let rows = 0;
  const take = (text: string): void => {
    if (text.trim() === "") return;
    for (const fields of parseCsv(text)) {
      if (header === undefined || columns === undefined) {
        header = fields;
        const found = Object.fromEntries(DETAILS_COLUMNS.map((name) => [name, fields.indexOf(name)])) as Record<(typeof DETAILS_COLUMNS)[number], number>;
        const missing = DETAILS_COLUMNS.filter((name) => found[name] < 0);
        if (missing.length > 0) throw new Error(`The file of ${String(year)} has no column ${missing.join(", ")}.`);
        columns = found;
        continue;
      }
      if (fields.length !== header.length) throw new Error(`A row of ${String(year)} has ${String(fields.length)} fields, and the header has ${String(header.length)}.`);
      const at = (name: (typeof DETAILS_COLUMNS)[number]): string => fields[(columns as Record<string, number>)[name] as number] as string;
      const id = at("EVENT_ID");
      if (ids.has(id)) throw new Error(`The file of ${String(year)} has the event ${id} two times.`);
      ids.add(id);
      const yearMonth = at("BEGIN_YEARMONTH");
      if (!/^\d{6}$/.test(yearMonth) || Number(yearMonth.slice(0, 4)) !== year) throw new Error(`The event ${id} starts in ${JSON.stringify(yearMonth)}, not in ${String(year)}.`);
      const month = Number(yearMonth.slice(4));
      if (month < 1 || month > 12) throw new Error(`The event ${id} has the bad month ${JSON.stringify(yearMonth)}.`);
      months.add(month);
      const type = at("EVENT_TYPE").trim();
      if (type === "") throw new Error(`The event ${id} has no type.`);
      let sums = types.get(type);
      if (sums === undefined) types.set(type, (sums = { events: 0, deathsDirect: 0, deathsIndirect: 0, injuriesDirect: 0, injuriesIndirect: 0 }));
      sums.events += 1;
      sums.deathsDirect += count(at("DEATHS_DIRECT"), "DEATHS_DIRECT", id);
      sums.deathsIndirect += count(at("DEATHS_INDIRECT"), "DEATHS_INDIRECT", id);
      sums.injuriesDirect += count(at("INJURIES_DIRECT"), "INJURIES_DIRECT", id);
      sums.injuriesIndirect += count(at("INJURIES_INDIRECT"), "INJURIES_INDIRECT", id);
      rows += 1;
    }
  };
  for await (const text of texts) take(framer.push(text));
  take(framer.end());
  if (header === undefined) throw new Error(`The file of ${String(year)} is empty.`);
  const sortedTypes = [...types.keys()].sort();
  return { year, rows, months: [...months].sort((a, b) => a - b), types: Object.fromEntries(sortedTypes.map((type) => [type, types.get(type) as Harm])) };
}

/**
 * The kind of the taxonomy for each event type of NCEI (NWS Directive 10-1605, and the older names
 * of the database). A type with no alert of its own has no kind (null), for example a drought or a
 * funnel cloud. A type that this map does not have goes to the list of new types of the measure.
 */
export const NCEI_KINDS: Readonly<Record<string, string | null>> = {
  "Astronomical Low Tide": "met.marine.low-water",
  Avalanche: "geo.avalanche",
  Blizzard: "met.winter.blizzard",
  "Coastal Flood": "met.flood.coastal",
  "Cold/Wind Chill": "met.cold.wind-chill",
  "Debris Flow": "geo.debris-flow",
  "Dense Fog": "met.fog",
  "Dense Smoke": "env.smoke",
  Drought: null,
  "Dust Devil": null,
  "Dust Storm": "met.dust-storm",
  "Excessive Heat": "met.heat.extreme",
  "Extreme Heat": "met.heat.extreme",
  "Extreme Cold/Wind Chill": "met.cold.extreme",
  "Extreme Cold": "met.cold.extreme",
  "Flash Flood": "met.flood.flash",
  Flood: "met.flood",
  "Freezing Fog": "met.fog.freezing",
  "Frost/Freeze": "met.freeze",
  "Funnel Cloud": null,
  Hail: "met.thunderstorm.severe",
  Heat: "met.heat",
  "Heavy Rain": null,
  "Heavy Snow": "met.winter.storm",
  "High Surf": "met.surf",
  "High Wind": "met.wind.high",
  Hurricane: "met.tropical.hurricane",
  "Hurricane (Typhoon)": "met.tropical.hurricane",
  "Ice Storm": "met.winter.ice-storm",
  "Lake-Effect Snow": "met.winter.lake-effect-snow",
  "Lakeshore Flood": "met.flood.lakeshore",
  Landslide: "geo.debris-flow",
  Lightning: "met.thunderstorm",
  "Marine Dense Fog": "met.marine.fog",
  "Marine Hail": "met.marine.special",
  "Marine High Wind": "met.marine.storm",
  "Marine Hurricane/Typhoon": "met.tropical.hurricane",
  "Marine Lightning": "met.marine",
  "Marine Strong Wind": "met.marine.gale",
  "Marine Thunderstorm Wind": "met.marine.special",
  "Marine Tropical Depression": "met.tropical",
  "Marine Tropical Storm": "met.tropical.storm",
  "Northern Lights": null,
  OTHER: null,
  "Rip Current": "met.rip-current",
  Seiche: "met.flood.lakeshore",
  Sleet: "met.winter.weather",
  Sneakerwave: "met.beach-hazards",
  "Storm Surge/Tide": "met.surge",
  "Strong Wind": "met.wind",
  "Thunderstorm Wind": "met.thunderstorm.severe",
  Tornado: "met.tornado",
  "Tropical Depression": "met.tropical",
  "Tropical Storm": "met.tropical.storm",
  Tsunami: "geo.tsunami",
  "Volcanic Ash": "geo.volcano.ashfall",
  "Volcanic Ashfall": "geo.volcano.ashfall",
  Waterspout: "met.marine.special",
  Wildfire: "fire.wildfire",
  "Winter Storm": "met.winter.storm",
  "Winter Weather": "met.winter.weather",
};

/** This function gives the kind of an event type. It gives null for a type with no kind, and undefined for a type that the map does not have. */
export function nceiKind(type: string): string | null | undefined {
  return Object.hasOwn(NCEI_KINDS, type) ? NCEI_KINDS[type] : undefined;
}

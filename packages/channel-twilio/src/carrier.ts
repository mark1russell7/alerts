// The carrier network of Twilio that takes a call or a text to a phone (AL-35, `docs/CONTRACTS.md`).

import type { Address, NodeKey } from "@mark1russell7/alerts";
import { parsePhoneNumberFromString, type PhoneNumber } from "libphonenumber-js/max";

/** The regions of the carrier network of Twilio. The status page of Twilio has one component for each region and product. */
export type TwilioRegion = "north-america" | "latin-america" | "apac" | "europe" | "middle-east-africa";

/** The type of the number that sends the texts. In North America, each type has its own carrier path. */
export type SenderType = "long-code" | "short-code" | "toll-free";

/** The node keys of the carrier regions of Twilio start with this text: `provider-region:twilio/<region>/<product>`. */
export const TWILIO_CARRIER = "provider-region:twilio";

/**
 * The countries of each region, as ISO 3166 codes. The region of a country is the region of its carriers.
 *
 * - The United States, Canada and the United States territories are in North America. They use the numbers and the
 *   rules of the United States.
 * - The other countries of the North American numbering plan, as Jamaica, are in Latin America.
 * - The codes `AC` and `TA` are the islands that libphonenumber-js gives as countries.
 */
export const TWILIO_REGIONS: Readonly<Record<TwilioRegion, readonly string[]>> = {
  "north-america": ["AS", "CA", "GU", "MP", "PR", "US", "VI"],
  "latin-america": [
    ...["AR", "BO", "BR", "BZ", "CL", "CO", "CR", "EC", "FK", "GF", "GT", "GY", "HN", "MX", "NI", "PA", "PE", "PY", "SR", "SV", "UY", "VE"],
    ...["AG", "AI", "AW", "BB", "BL", "BM", "BQ", "BS", "CU", "CW", "DM", "DO", "GD", "GP", "HT", "JM", "KN", "KY", "LC", "MF", "MQ", "MS", "SX", "TC", "TT", "VC", "VG"],
  ],
  apac: [
    ...["AF", "BD", "BN", "BT", "CN", "HK", "ID", "IN", "IO", "JP", "KG", "KH", "KP", "KR", "KZ", "LA", "LK", "MM", "MN", "MO", "MV", "MY", "NP", "PH", "PK", "SG", "TH", "TJ", "TL", "TM", "TW", "UZ", "VN"],
    ...["AU", "CC", "CK", "CX", "FJ", "FM", "KI", "MH", "NC", "NF", "NR", "NU", "NZ", "PF", "PG", "PW", "SB", "TK", "TO", "TV", "VU", "WF", "WS"],
  ],
  europe: [
    ...["AD", "AL", "AM", "AT", "AX", "AZ", "BA", "BE", "BG", "BY", "CH", "CY", "CZ", "DE", "DK", "EE", "ES", "FI", "FO", "FR", "GB", "GE", "GG", "GI", "GL", "GR"],
    ...["HR", "HU", "IE", "IM", "IS", "IT", "JE", "LI", "LT", "LU", "LV", "MC", "MD", "ME", "MK", "MT", "NL", "NO", "PL", "PM", "PT", "RO", "RS", "RU", "SE", "SI", "SJ", "SK", "SM", "TR", "UA", "VA", "XK"],
  ],
  "middle-east-africa": [
    ...["AE", "BH", "IL", "IQ", "IR", "JO", "KW", "LB", "OM", "PS", "QA", "SA", "SY", "YE"],
    ...["AC", "AO", "BF", "BI", "BJ", "BW", "CD", "CF", "CG", "CI", "CM", "CV", "DJ", "DZ", "EG", "EH", "ER", "ET", "GA", "GH", "GM", "GN", "GQ", "GW", "KE", "KM", "LR", "LS", "LY"],
    ...["MA", "MG", "ML", "MR", "MU", "MW", "MZ", "NA", "NE", "NG", "RE", "RW", "SC", "SD", "SH", "SL", "SN", "SO", "SS", "ST", "SZ", "TA", "TD", "TG", "TN", "TZ", "UG", "YT", "ZA", "ZM", "ZW"],
  ],
};

const REGION_OF = new Map<string, TwilioRegion>(Object.entries(TWILIO_REGIONS).flatMap(([region, countries]) => countries.map((country) => [country, region as TwilioRegion] as const)));

// A short code is a number of 5 or 6 digits with no country code.
const SHORT_CODE = /^[0-9]{5,6}$/;

/** This function gives the region of a country, from its ISO 3166 code. A code that the table does not have gives no region. */
export function twilioRegion(country: string): TwilioRegion | undefined {
  return REGION_OF.get(country);
}

// The parse of a phone number in E.164 form. The parse does not throw, but this function also catches a throw.
function parsed(phone: string | undefined): PhoneNumber | undefined {
  if (phone === undefined) return undefined;
  try {
    return parsePhoneNumberFromString(phone);
  } catch {
    return undefined;
  }
}

/** This function gives the region of a phone number in E.164 form. A number with no country gives no region. It does not throw. */
export function phoneRegion(phone: string | undefined): TwilioRegion | undefined {
  const country = parsed(phone)?.country;
  return country === undefined ? undefined : twilioRegion(country);
}

/**
 * This function gives the type of the number that sends the texts. A short code has 5 or 6 digits. A toll-free
 * number is `toll-free`. Each other valid number is a long code. A number that is not valid gives no type.
 */
export function senderType(from: string): SenderType | undefined {
  if (SHORT_CODE.test(from)) return "short-code";
  const number = parsed(from);
  if (number === undefined || !number.isValid()) return undefined;
  return number.getType() === "TOLL_FREE" ? "toll-free" : "long-code";
}

/**
 * This function gives the carrier service of a call to an address: `provider-region:twilio/<region>/voice`. An address
 * with no phone number of a known country gives an empty list. The function does not throw.
 */
export function twilioCallServices(address: Address): readonly NodeKey[] {
  const region = phoneRegion(address["to"]);
  return region === undefined ? [] : [`${TWILIO_CARRIER}/${region}/voice`];
}

/**
 * This function gives the carrier service of a text to an address: `provider-region:twilio/<region>/sms`. In North
 * America, the type of the sender `from` adds one part, for example `.../north-america/sms/toll-free`. Without a type, the
 * node is `.../north-america/sms`. An address with no phone number of a known country gives an empty list.
 *
 * The result tells a private fact of the address and of the sender. Thus no log and no problem holds it.
 */
export function twilioTextServices(address: Address, from?: string): readonly NodeKey[] {
  const region = phoneRegion(address["to"]);
  if (region === undefined) return [];
  const sms = `${TWILIO_CARRIER}/${region}/sms`;
  const type = region === "north-america" && from !== undefined ? senderType(from) : undefined;
  return [type === undefined ? sms : `${sms}/${type}`];
}

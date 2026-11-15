/**
 * The messages of the NWS for Wireless Emergency Alerts (WEA). The NWS sends a WEA message to FEMA
 * IPAWS, and IPAWS sends it to the phones in the area. The NWS API marks such a message with the
 * parameter `WEAHandling`.
 */

/** The name of the parameter of the NWS that marks a WEA message. Its value is the handling, for example `Imminent Threat`. */
export const WEA_PARAMETER = "WEAHandling";

/**
 * The NWS event codes of the products that can be WEA messages. The list is larger than necessary:
 * a product of the list is a WEA message only with the parameter `WEAHandling`. Examples are a flash
 * flood warning and a severe thunderstorm warning with a destructive tag.
 *
 * A code that is not in the list gives no false miss. The lateness check then has fewer cases.
 */
export const WEA_EVENT_CODES: readonly string[] = ["DSW", "EWW", "FFW", "HUW", "SQW", "SSW", "SVR", "TOR", "TSW", "TYW"];

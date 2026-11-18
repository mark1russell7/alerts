/**
 * The register of well-known status pages. Each page gave a summary with a list of incidents to a probe on 2026-11-18.
 * The pages of Atlassian Statuspage gave an `ETag`. The page of incident.io gave none.
 *
 * The kind of a page is the kind of its service. The service is an online service, a cloud platform, a provider of DNS,
 * delivery or certificates, or a payment service. It can also be a bank, a broker, a crypto exchange or a blockchain.
 */

import type { SourceId } from "@mark1russell7/alerts";

import type { ComponentKey, StatusPage } from "./page.ts";

/** The failure domain of each page that Atlassian Statuspage hosts. */
export const ATLASSIAN_STATUSPAGE = "provider:atlassian-statuspage";

/** The failure domain of each page that incident.io hosts. */
export const INCIDENT_IO = "provider:incident-io";

/** The failure domain of a page behind the delivery network of Cloudflare. */
export const CLOUDFLARE_CDN = "cdn:cloudflare";

const SAAS = "infra.saas.outage";
const CLOUD = "infra.cloud.outage";
const DNS_CDN = "infra.internet.dns-cdn";
const PAYMENTS = "infra.payments.outage";
const BANK = "market.bank.outage";
const BROKER = "market.broker.outage";
const EXCHANGE = "market.crypto.exchange-outage";
const CHAIN = "market.crypto.chain-halt";

/** This function gives the config of one page: its id is `statuspage-` and the name. */
const page = (name: string, title: string, host: string, domain: string, kind: string, dependsOn: readonly string[] = [ATLASSIAN_STATUSPAGE], origin = name): StatusPage => ({
  id: `statuspage-${name}` as SourceId,
  title,
  base: `https://${host}`,
  origin,
  domain,
  kind,
  dependsOn,
});

/**
 * The keys of the components of Twilio that an alert uses for a call or a text message. These are the text messages,
 * the carrier network of the texts and the voice of the region US1. The API of these services is `api.twilio.com`. Each
 * id is a group of the page on 2026-11-18. An outage of Twilio Video or SendGrid names only `twilio.com`.
 */
export const TWILIO_KEYS: readonly ComponentKey[] = [
  { id: "s2k3h0mkqnth", name: "Programmable Messaging", domain: "api.twilio.com" },
  { id: "j3s4w3gnsj08", name: "Programmable Voice US1", domain: "api.twilio.com" },
  { id: "j8hlnyphbbs0", name: "Carrier Network", domain: "api.twilio.com" },
];

/** The well-known status pages, in the order of their ids. */
export const STATUS_PAGES: readonly StatusPage[] = [
  page("bitbucket", "Bitbucket", "bitbucket.status.atlassian.com", "bitbucket.org", SAAS, [ATLASSIAN_STATUSPAGE], "atlassian"),
  page("box", "Box", "status.box.com", "box.com", SAAS),
  page("chime", "Chime", "status.chime.com", "chime.com", BANK),
  page("circle", "Circle", "status.circle.com", "circle.com", EXCHANGE),
  page("circleci", "CircleCI", "status.circleci.com", "circleci.com", SAAS),
  page("claude", "Claude", "status.claude.com", "claude.ai", SAAS, [ATLASSIAN_STATUSPAGE], "anthropic"),
  page("cloudflare", "Cloudflare", "www.cloudflarestatus.com", "cloudflare.com", DNS_CDN),
  page("coinbase", "Coinbase", "status.coinbase.com", "coinbase.com", EXCHANGE, [ATLASSIAN_STATUSPAGE, CLOUDFLARE_CDN]),
  page("digicert", "DigiCert", "status.digicert.com", "digicert.com", DNS_CDN),
  page("digitalocean", "DigitalOcean", "status.digitalocean.com", "digitalocean.com", CLOUD, [ATLASSIAN_STATUSPAGE, CLOUDFLARE_CDN]),
  page("discord", "Discord", "discordstatus.com", "discord.com", SAAS),
  page("dropbox", "Dropbox", "status.dropbox.com", "dropbox.com", SAAS),
  page("elastic", "Elastic Cloud", "status.elastic.co", "elastic.co", CLOUD),
  page("epicgames", "Epic Games", "status.epicgames.com", "epicgames.com", SAAS),
  page("figma", "Figma", "status.figma.com", "figma.com", SAAS),
  page("gemini", "Gemini Exchange", "status.gemini.com", "gemini.com", EXCHANGE),
  page("github", "GitHub", "www.githubstatus.com", "github.com", SAAS),
  page("hubspot", "HubSpot", "status.hubspot.com", "hubspot.com", SAAS),
  page("kraken", "Kraken", "status.kraken.com", "kraken.com", EXCHANGE),
  page("linode", "Linode", "status.linode.com", "linode.com", CLOUD),
  page("mailgun", "Mailgun", "status.mailgun.com", "mailgun.com", SAAS),
  page("netlify", "Netlify", "www.netlifystatus.com", "netlify.com", CLOUD),
  page("newrelic", "New Relic", "status.newrelic.com", "newrelic.com", SAAS),
  page("npm", "npm", "status.npmjs.org", "npmjs.com", SAAS),
  page("openai", "OpenAI", "status.openai.com", "openai.com", SAAS, [INCIDENT_IO]),
  page("reddit", "Reddit", "www.redditstatus.com", "reddit.com", SAAS),
  page("render", "Render", "status.render.com", "render.com", CLOUD),
  page("robinhood", "Robinhood", "status.robinhood.com", "robinhood.com", BROKER),
  page("sentry", "Sentry", "status.sentry.io", "sentry.io", SAAS),
  page("shopify", "Shopify", "www.shopifystatus.com", "shopify.com", SAAS),
  page("snowflake", "Snowflake", "status.snowflake.com", "snowflake.com", CLOUD),
  page("solana", "Solana", "status.solana.com", "solana.com", CHAIN),
  { ...page("twilio", "Twilio", "status.twilio.com", "twilio.com", SAAS), components: TWILIO_KEYS },
  page("vercel", "Vercel", "www.vercel-status.com", "vercel.com", CLOUD),
  page("visa-acceptance", "Visa Acceptance Solutions", "status.visaacceptance.com", "visaacceptance.com", PAYMENTS, [ATLASSIAN_STATUSPAGE], "visa"),
];

/** This function gives the page of the register with the id `id`, or `undefined`. */
export function registeredPage(id: string): StatusPage | undefined {
  return STATUS_PAGES.find((each) => each.id === id);
}

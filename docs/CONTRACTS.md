# Contracts

This file gives the three contracts of the alert system: the event, the source and the channel. The sources effort and the delivery effort start from them. The types are in [`packages/core/src/contracts.ts`](../packages/core/src/contracts.ts), in the package `@mark1russell7/alerts`.

Status: draft, 2026-11-14. The core effort owns this file. To change a contract, write to the core effort first.

## The flow

```
source adapter                 core (pure)                                   runtime
──────────────                 ───────────                                   ───────
fetch ──► Observation ──► map ──► Report ──► merge state ──► Incident ──► assess ──► Level ──► escalate ──► channel.send
  │            (log)                          (grow-only)       │                                  ▲            │
  └─ outcome ──► health ──► coverage ──► system reports ────────┘                                  └─ ack ◄─────┘
```

- An **observation** is one raw message, as the source gave it. The log keeps each one, so the system can map it again after a fix.
- A **report** is one observation in the one format of the system. It is built on CAP 1.2, the format of the NWS and FEMA. A report does not change. An update or a cancel is a new report.
- An **incident** is one real event, made from one or more reports.
- The **health** of each source and the **coverage** of each kind at each place go through the same pipeline as system reports. Thus "weather coverage at a place fell to one source" is an alert like any other.

## Packages

| Package | Folder | What it holds |
| --- | --- | --- |
| `@mark1russell7/alerts` | `packages/core` | The contracts, the merge, the assessment, the routing, the escalation, the health and the coverage. Pure functions on an injected clock. |
| `@mark1russell7/alerts-source-<id>` | `packages/source-<id>` | One source adapter as procedures. |
| `@mark1russell7/alerts-channel-<id>` | `packages/channel-<id>` | One delivery channel as procedures. |
| `@mark1russell7/alerts-runtime` | `packages/runtime` | The service: the loops, the event log, the delivery ledger and the heartbeat, on `@mark1russell7/service` and the SQLite home. |
| `@mark1russell7/alerts-testkit` | `packages/testkit` | The conformance tests of the adapters, the fixtures and the fault plans. |

The repo is public. It holds no person, no place, no address and no key. The private configuration gives them at run time: people and places from a private store, keys from `~/.alerts/secrets.env`.

## The merge laws

The merge state is a set of grow-only sets: reports, acknowledgments and deliveries. The join of two states is their union. So the join is:

- **idempotent**: `join(a, a) = a`. A duplicate report changes nothing.
- **commutative**: `join(a, b) = join(b, a)`. The order of arrival changes nothing.
- **associative**: `join(join(a, b), c) = join(a, join(b, c))`. Two copies of the system that exchange their states get the same state.

Two copies can get one report id with two contents, for example from two versions of an adapter. The join then keeps the content with the smaller canonical JSON (RFC 8785). This choice is a total order, so the join keeps the three laws.

The groups of reports are a function of the merge state alone, with no clock. Two reports of one status are in one incident when:

1. one report references the other (the CAP references), or
2. they share a correlation key (an NWS VTEC event, a USGS event id), or
3. the link rule of their kinds matches: the same family of kind, areas that overlap and times that overlap.

The links are transitive: when A links to B and B links to C, the three reports are in one incident. A link rule gives the blocks of a report, for example its family of kind and its day. The merge tests only two reports that share a block. So the cost grows with the size of the blocks, not with the square of the count of reports.

A line is a report and the reports of its source that update or cancel it. The head of a line is its last report: no report of the same source references it. An incident is live at a time when one or more heads are not cancelled and not expired at that time. Its severity, urgency and certainty are the highest of its live heads. Its corroboration is the count of the different origins of its reports.

A cancel ends only its own line. A copy from another source can miss the cancel. Then the incident stays live until that copy expires. This error is on the safe side.

The incident id is its anchor: its smallest report id. The anchor can change when two incidents merge. So an acknowledgment and a delivery point to a report of the incident, not to the anchor.

A delivery is one accepted send. A failed send makes no delivery, so its step stays due and the runtime tries it again. The sent level of a person for an incident is the highest level of the deliveries to the person for its reports. This value only grows, so a merge does not send an alert again.

Property tests hold each law. They use the seeded generator of `@mark1russell7/rigor-generators`, and the variable `SEED` replays a run. They also examine that each order of arrival gives the same incidents.

## The source contract

Each source package registers three or more procedures under `alerts.source.<id>`:

| Procedure | Effects | Rule |
| --- | --- | --- |
| `describe` | none | It gives the `SourceDescriptor`. |
| `fetch` | reads `network` | It goes through polite-crawler. It is idempotent. For a failure of the source, it gives `{ ok: false, failure }` and does not throw. |
| `map` | none | A pure and total function. It does not throw. The same observation gives the same reports with the same ids. It makes the ids with the id functions of the core. |
| `check` | none | Optional. It examines a fetch against the canary of the source. |
| `locate` | reads `network` | Optional. It gives the region codes of a position (`ugc`, `same`) for a source with a lookup, for example the `/points` query of the NWS API. It is idempotent. |

The rules of each adapter:

1. **An empty answer is not a failure.** `{ ok: true, observations: [], complete: true }` means "no alert". A failure is `{ ok: false }`. The health uses the difference.
2. **The map tells of format changes.** A field that the map does not understand is a `MapProblem`. A fatal problem makes no report. Problems move the health to `changed`.
3. **The descriptor tells the truth about dependencies.** `origins` names the authorities whose messages the source carries. `dependsOn` names the failure domains outside the cell: providers, CDNs, transmitters. `uses` names the resources of the cell: `internet`, `power`, `receiver`. The coverage uses both.
4. **The ids are hashes of content.** The core gives the id functions in `ids.ts`. An adapter does not make its own ids.
   - `observationId`: the SHA-256 of the source id, the content type, the request URL and the body. The fetch time is not part of it, so a poll with no change gives the same id.
   - `reportId`: the SHA-256 of the source id, the source key and the sent time.
   - `messageKey`: the SHA-256 of the incident report, the level, the person and the step.
   - The hash input is a JSON array that starts with the scheme `alerts-id/1` and the kind of id. Each copy of the system gives the same id.
5. **The fixtures are real and contain no personal data.** Each adapter keeps recorded answers of its source in `fixtures/`, with the expected reports. The places of the tests are public places, not the places of a real person.
6. **A canary when the source has one.** For example: the national feed of the NWS has one or more active alerts. A national feed with no alert is more likely a fault than a calm country.

The testkit gives one conformance suite, and each adapter passes it. The suite examines the laws of `map` on the fixtures and on mutated fixtures. It examines the outcomes of `fetch` behind a fault proxy: cut, delay, reset, 429, 500 and a changed body. It also examines the descriptor.

## Health and coverage

The core calculates the health of each source from the outcomes of its fetches, not the adapter. The health is a state machine on `@mark1russell7/algebra`:

| State | When |
| --- | --- |
| `unknown` | No fetch yet. |
| `healthy` | The last fetch passed, in less than `slowAfter`. |
| `slow` | The last fetch passed, in `slowAfter` or more. |
| `failing` | The last fetches failed, or the canary failed. |
| `silent` | No new message for `maxQuiet`, for a source where quiet is not normal. |
| `changed` | The map gave problems. |

Each change of state is a system report.

The system uses two kinds of independence, and keeps them apart:

- **Independence for coverage** asks: "can one fault stop both sources?" Two sources are independent when their `dependsOn` sets have no shared domain. The NWS API and the NOAA Weather Radio are independent: one comes from a provider on the internet, and the other comes from a transmitter.
- **Independence for corroboration** asks: "are these two witnesses, or one witness twice?" Two sources are independent when their `origins` differ. A news story that repeats an NWS warning is not a second witness.

The cell is the copy of the system on one machine. Its internet link, its power and its receivers are common to each of its sources. So a source names them in `uses`, not in `dependsOn`. Else each internet source falls into one group, and the coverage cannot tell two providers apart.

The coverage of a kind at a place has two parts:

- `independent`: the smallest count of outside failure domains whose faults stop each healthy source of the kind. At 2 or more, no single outside fault stops the coverage. The policy asks for 2 or more for each life-safety kind. A smaller count is a system report: `urgent` at one, `life-safety` at zero during a watch or a warning at the place.
- `commonResources`: the cell resources that each of these sources uses. One fault of one of them stops all of these sources in this cell. The radio input and a second cell remove these common faults. The blindness formula of the design study uses them as the shared fault `c`.

## The channel contract

Each channel package registers four procedures under `alerts.channel.<id>`:

| Procedure | Effects | Rule |
| --- | --- | --- |
| `describe` | none | It gives the `ChannelDescriptor`: the failure domains, the break through Do Not Disturb, the repeats, the kind of acknowledgment and the cost. |
| `send` | writes `network` | It sends one `Message` to one `Address`. A failure is `{ ok: false }`. It does not throw. |
| `status` | reads `network` | It gives the state of a receipt: accepted, delivered, acknowledged, expired or failed. |
| `cancel` | writes `network` | It stops the repeats of a message. It is idempotent. |

The channel does not escalate. The core does:

- An `EscalationPolicy` gives the steps of a level: a channel and a time for each step. The first step of `life-safety` is Pushover at emergency priority. It repeats until acknowledged, and sounds through silent mode with iOS Critical Alerts.
- The escalation is a state machine on the clock of algebra: sent, then acknowledged, or the next step at its time, or exhausted. Exhausted is a system alert to the next person in the policy.
- An acknowledgment comes from any channel or from the UI. It stops the escalation of that level of that incident, and the core cancels the repeats on the other channels.

## The delivery promise

For `life-safety`, the system prefers a duplicate to a miss.

- Each copy of the system keeps the delivery ledger in its merge state. A copy waits for its rank times a short delay before a send, and does not send when the joined ledger already has the delivery.
- When two copies cannot reach each other, both can send. Then the person can get the alert two times. The person does not get it zero times.
- The message key is the SHA-256 of the incident report, the level, the person and the step. A channel that can drop a repeated key does so.

## Levels and the first night rule

| Level | What it does |
| --- | --- |
| `life-safety` | It wakes the person, sounds through silent mode and escalates until acknowledged. |
| `urgent` | A push at once, without the break through Do Not Disturb. |
| `notice` | A push in the day, else the digest. |
| `digest` | The next digest. |

The first assessment is a table. An incident is `life-safety` when each of these conditions is true:

- The status is `actual`.
- The kind is in the life-safety list: tornado, flash flood, extreme wind, fire, evacuation, shelter in place, tsunami, earthquake shaking.
- The area contains a watched place, or comes within its buffer.
- The severity is `severe` or `extreme`.
- The urgency is `immediate` or `expected`.

The table becomes the calculation of the design study (AL-1 and AL-7). The calculation multiplies the probability that the event is real, the impact on the person and the urgency. It compares the result with the cost to interrupt the person at that time.

## People and places

The contracts carry only ids: `PersonId` and `PlaceId`. The runtime gets people, places, addresses and the night rule of each person from the private configuration.

The positions of the places do not go to a source. A source fetches by area, for example all the alerts of a state, and the core matches the places on the machine of the instance. So a `WatchedPlace` gives an adapter region codes and a buffer, and no name, no address and no position. A source that needs a position gets it only when the owner lets that source get it.

The core matches the area of a report to a place with one rule for each source. A polygon or a circle comes first, with the buffer of the place. Else the region codes decide. Polygon math waits for its home, `@mark1russell7/geo`. Until then, the core matches by codes only.

## Open points

- The procedure schemas: Standard Schema validators (zod 4) for each input and output, in the core package.
- The link rule of each family of kind, for rule 3 of the merge.
- The merge state grows with each report. A compaction of the incidents that ended before a horizon keeps it small. It must keep the three laws.
- The taxonomy: the list of codes, from the CAP and NWS event names first (AL-5).

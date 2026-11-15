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
| `@mark1russell7/alerts-format-<name>` | `packages/format-<name>` | The reader of one message format that two or more sources use: `format-cap` for CAP 1.2, `format-nws` for VTEC and the NWS kinds. |
| `@mark1russell7/alerts-source-<id>` | `packages/source-<id>` | One source adapter as procedures. |
| `@mark1russell7/alerts-channel-<id>` | `packages/channel-<id>` | One delivery channel as procedures. |
| `@mark1russell7/alerts-runtime` | `packages/runtime` | The service: the loops, the event log, the delivery ledger and the heartbeat, on `@mark1russell7/service` and the SQLite home. |
| `@mark1russell7/alerts-testkit` | `packages/testkit` | The conformance tests of the adapters, the fixtures and the fault plans. |
| `@alerts/site` | `packages/site` | The public site: a demo that replays made-up messages through the real code. It holds no person and no place. |

The preparedness planner (AL-20) and the app with the map of the watched places (AL-18) get their folders when they start. A package of this repo is for a general part. A part that names a person or a place stays in the private configuration.

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
2. **The map tells of format changes.** A field that the map does not understand is a `MapProblem`. A fatal problem makes no report. Only fatal problems move the health to `changed`. So when the map cannot read an area or a subject that a watch can match, it gives a fatal problem. Until the core matches shapes, an area needs a region code or a place.
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

The core calculates the health of each source from the records of its fetches, not the adapter. The runtime writes one `FetchRecord` when each fetch ends. The health is a state machine on `@mark1russell7/algebra`, and `HEALTH_MACHINE` is its document.

| State | When |
| --- | --- |
| `unknown` | No fetch passed yet. |
| `healthy` | The last fetch passed, in less than `slowAfter`. |
| `slow` | The last fetch passed, in `slowAfter` or more. |
| `failing` | The last `failAfter` fetches failed, or no fetch passed for `staleAfter`, or the last canary check failed. |
| `silent` | No fresh observation for `maxQuiet`, for a source where quiet is not normal. |
| `changed` | The map gave fatal problems for the last passed fetch. |

The default of `failAfter` is 2 fetches, and the default of `staleAfter` is 3 intervals. When two conditions are true, the first state of this order applies: `failing`, `unknown`, `changed`, `silent`, `slow`, `healthy`. A stuck loop of the runtime writes no record, so the stale timer makes the source `failing`. A failed canary holds until a canary check passes.

The health is a pure fold. `observeFetch` adds one record, and `advanceHealth` moves the time. Each step gives the changes of state as transitions, and the time of its next timer in `wakeAt`. A replay of the transitions against the document finds each change that the document does not permit. Tests replay random records, and compare each state with a direct calculation from the records.

A source that is down is a system report. The section [System reports](#system-reports) tells the rules.

The system uses two kinds of independence, and keeps them apart:

- **Independence for coverage** asks: "can one fault stop both sources?" Two sources are independent when their `dependsOn` sets have no shared domain. The NWS API and the NOAA Weather Radio are independent: one comes from a provider on the internet, and the other comes from a transmitter.
- **Independence for corroboration** asks: "are these two witnesses, or one witness twice?" Two sources are independent when their `origins` differ. A news story that repeats an NWS warning is not a second witness.

The cell is the copy of the system on one machine. Its internet link, its power and its receivers are common to each of its sources. So a source names them in `uses`, not in `dependsOn`. Else each internet source falls into one group, and the coverage cannot tell two providers apart.

`coverage(input, policy)` gives the coverage of each kind at each place. It is a pure calculation on the descriptors, the health of the sources and the places.

- A source counts when its health is in `policy.up`. The first policy counts `healthy` and `slow`. A source with no health is `unknown`.
- A source covers a kind when one of its prefixes has the kind. A source of a part of the kind does not count.
- A source covers a place when its coverage is `global`, or when a code of its coverage covers a code of the place. So a place lists its codes at each level: the NWS zone and county, SAME, the state (`state`) and the country (`iso3166`).
- An area with only a shape covers no place until `@mark1russell7/geo` has the tests.

The coverage has these parts:

- `independent`: the smallest count of outside failure domains whose faults stop each source of the kind that is up. At 2 or more, no single outside fault stops the coverage. The policy asks for 2 or more for each life-safety kind, and 1 for each other kind. A smaller count is a system report: `urgent` for a life-safety kind, and `life-safety` at zero during a watch or a warning at the place.
- `faults`: the domains of that smallest set. The report names them. A source with no domain in `dependsOn` gets its own domain `source:<id>`.
- `proven`: the search of the smallest set ended. The count is a minimum hitting set, and `minimumHittingSet` of `@mark1russell7/collections/graph` calculates it exactly. When the search passes its budget, `proven` is false, and `coverageShort` gives true. A count that the search did not prove is not a pass.
- `commonResources`: the cell resources that each of these sources uses. One fault of one of them stops all of these sources in this cell. The radio input and a second cell remove these common faults. The blindness formula of the design study uses them as the shared fault `c`.

### System reports

`systemReports(lines, snapshot, at)` makes the reports of the core. Each source in `DOWN_STATES` (`failing`, `silent` and `changed`) is a condition. Each coverage that `coverageShort` finds is a condition. Each condition is a line of CAP reports with the status `system` and the source `system`:

- The start of a condition gives an `alert`.
- A change of its facts gives an `update`. The update references the last key of the line. A new count in the reason of the health is not a fact, so it gives no update.
- The end of the condition gives a `cancel`, an all clear. A later start gives a new line, because the level already sent of a line only grows.
- The state of the fold is data: the open lines and the count of the reports. An equal snapshot gives no report.
- Tests hold the open lines against the conditions over random snapshots, and through the merge.

Each report has an observation: the canonical JSON of its facts. The log keeps it, as it keeps the observations of the sources.

A health report has no area. Its subject is `{ system: "alerts.source", id: <source id> }`. So it goes only to a person who watches that subject in `PersonWatch.subjects`. Its kind is `system.health.<state>`, and it gets `notice` at most.

A coverage report has the area of the watched place, `{ type: "place", place }`. So it goes to each person who watches that place. Its kind is `system.coverage.<kind>`. Its severity and urgency come from the gap:

| Gap | Severity, urgency | Life-safety kind | Other kind |
| --- | --- | --- | --- |
| No independent source during a watch or a warning of the kind at the place | `extreme`, `immediate` | `life-safety` | `notice` |
| Fewer independent sources than the policy needs | `severe`, `expected` | `urgent` | `notice` |
| A count that the search did not prove | `moderate`, `expected` | `notice` | `notice` |

`threats(incidents, places)` gives the watches and the warnings. A threat is a live incident with the status `actual` at a watched place. Its stage is `watch`, `warning` or absent. A report of the core has the status `system`, so it is not a threat.

The assessment policy holds two system classes, and each class admits only the status `system`. A class can name its statuses. Else the statuses of the policy apply. The NWS kinds `system.test` and `system.admin` are not in these classes, so the policy statuses apply to them.

### Lateness across sources

Some sources carry a copy of the messages of another source. FEMA IPAWS carries each NWS warning for Wireless Emergency Alerts. Over 30 days, the public IPAWS feed had 17 gaps of 4 hours or more and one gap of 12.6 hours. So a quiet feed is normal, and the quiet timer of the health cannot show that the source stopped. The check across sources shows it.

- An `Expectation` is data: the source `from`, the source `to` and a `ReportFilter`. For IPAWS, the filter is the status `actual` and the parameter `WEAHandling`.
- The two copies must be in one incident. So the source `to` must give a correlation key of the source `from`, for example the VTEC key.
- `carriages(state, incidents, expectations)` gives one check for each expectation and each incident: the first report of `from` that passes the filter, and the first copy of `to`. The result is a function of the set of reports.
- `delayLimit(delays, { quantile, level })` gives the limit of the delay. It is the distribution-free upper bound of the quantile of the measured delays, from `quantileInterval` of `@mark1russell7/rigor-statistics`. No person sets a time.
- A small sample has no upper bound. Then the expectation has no limit, and the check only measures.
- A check is a miss when it passes its limit with no copy. In normal work, some copies come late and some copies do not come. So one miss is not a proof.
- `missRecord(checks, expectation, delay, at)` counts the misses of the past. Only a check after a met check is a trial, so a long stop of the source counts as one miss.
- `missLimit(record, level)` gives the count of misses in a row that makes the source late. It is the smallest k with `high ** k <= 1 - level`. `high` is the upper bound of the rate of the misses, from `clopperPearson` of `@mark1russell7/rigor-statistics`. No person sets a count.
- `lateLimits(checks, expectations, at, { quantile, level })` gives the two limits of each expectation: the delay and the count of misses.
- `lateness(checks, expectations, limits, at)` gives the state of each expectation: `no-limit`, `no-data`, `met` or `late`. The source is late when the misses after the last check that came reach the count.
- A copy that comes after a miss ends the misses, because it shows that the source carries the reports again.
- `wakeAt` is the next time when a check passes its limit. The runtime starts `lateLimits` and `lateness` again at that time.

A late source has two effects:

- `coverage` does not count it, also when its health state is up. Its fetches pass, but it does not carry the reports. `lateSources` gives the list for `CoverageInput.late`.
- Each late expectation is a line of system reports with the kind `system.health.late`. Its subject is the source `to`, so it goes to the person who watches the sources. Each new miss is a new fact, so it gives an update.

A copy that did not come is not a measure of the delay, because its delay is not known. So a sample from a time when the source was down gives a lower limit of the delay. A lower limit gives more late states, which is the safe side. In normal work, a run of misses that makes the source late comes with a chance of `1 - level` or less.

## The channel contract

Each channel package registers four procedures under `alerts.channel.<id>`:

| Procedure | Effects | Rule |
| --- | --- | --- |
| `describe` | none | It gives the `ChannelDescriptor`: the failure domains, the cell resources, the break through Do Not Disturb, the repeats, the kind of acknowledgment and the cost. |
| `send` | writes `network` | It sends one `Message` to one `Address`. When `message.quiet` is true, it uses its silent mode. A failure is `{ ok: false }`. It does not throw. |
| `status` | reads `network` | It gives the state of a receipt: accepted, delivered, acknowledged, expired or failed. |
| `cancel` | writes `network` | It stops the repeats of a message. It is idempotent. |

The channel does not escalate. The core does:

- An `EscalationPolicy` gives the steps of a level: a channel and a time for each step. The first step of `life-safety` is Pushover at emergency priority. It repeats until acknowledged, and sounds through silent mode with iOS Critical Alerts.
- The escalation is a state machine on the clock of algebra: sent, then acknowledged, or the next step at its time, or exhausted. Exhausted is a system alert to the next person in the policy.
- An acknowledgment comes from any channel or from the UI. It stops the escalation of that level of that incident, and the core cancels the repeats on the other channels.
- Only an acknowledgment proves that the person got a message. The Pushover receipt field `last_delivered_at` is the time of a retry of the server, not a proof.
- The core decides the silent mode. `escalate` sets `quiet` on each send, and `Message.quiet` takes it. Each channel maps it to its silent mode: Pushover priority `-1`, or a text and no call on Twilio. No channel keeps its own rule about the time of day.
- On an iPhone, an Emergency message of Pushover sounds through silent mode only when the Pushover app has Critical Alerts on for Emergency. A reset of the iOS permission of Pushover turns that setting off.

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

The first assessment is a table of data: `DEFAULT_ASSESS_POLICY`. The policy puts each kind in a class. Each class has two lookups: the highest level for the severity and the highest level for the urgency. The level of the table is the lower of the two.

| Severity | Life-safety class | Other kinds |
| --- | --- | --- |
| `extreme` | `life-safety` | `urgent` |
| `severe` | `life-safety` | `urgent` |
| `moderate` | `urgent` | `notice` |
| `minor` | `notice` | `digest` |
| `unknown` | `life-safety` | `digest` |

| Urgency | Life-safety class | Other kinds |
| --- | --- | --- |
| `immediate` | `life-safety` | `urgent` |
| `expected` | `life-safety` | `urgent` |
| `future` | `urgent` | `notice` |
| `past` | `digest` | `digest` |
| `unknown` | `life-safety` | `notice` |

So an incident is `life-safety` when each of these conditions is true:

- The status is `actual`.
- The kind is in the life-safety class. `LIFE_SAFETY_KINDS` has its codes.
- An area of the incident contains a watched place.
- The severity is `severe`, `extreme` or `unknown`.
- The urgency is `immediate`, `expected` or `unknown`.

The life-safety class holds tornado, flash flood, extreme wind, hurricane, storm surge, fire, tsunami and earthquake shaking. It also holds evacuation, shelter in place, civil danger, civil emergency, and chemical, biological, radiological and nuclear hazards. For these kinds, an unknown value counts as high, because a miss costs more than a false alarm. A tornado watch has the urgency `future`, so it is `urgent`: a push at once that does not wake the person.

Each lookup only grows with the severity and with the urgency. So a more severe or more urgent incident does not get a lower level. Tests hold this order and the rule above for each value.

The level for a person is the highest level at the places of the person. A rule of the person can lower the level of some kinds at some places. For example, warnings at the places of other people can come as `urgent`. At each place, the first rule that matches applies, and a rule does not raise the level.

The assessment reads no clock, because the level is about the incident. The escalation reads `now`, so it holds the night rule:

- Each person can have a quiet window (`PersonWatch.quiet`): a time zone, and a start and an end in local times, for example `22:00` to `07:00`. An equal start and end give the full day.
- In the window, each send below `life-safety` is quiet. A `life-safety` send ignores the window. It wakes the person.
- The quiet value is for the time of the send. A step that became due before the end of the window and goes out after it is not quiet.
- `inQuietWindow` is `inWindow` of `@mark1russell7/algebra/clock`. It calculates the local time in the time zone of the window. Thus the window follows the change to and from daylight saving time.
- Tests hold a window across midnight, the two days of the change, an hour that occurs two times and an hour that does not occur.
- A bad window gives no quiet send. A message that is too loud is not a miss. `quietWindowProblems` finds the bad window.
- The system does not use the Quiet Hours of Pushover. The core holds the one rule, so each channel follows the same rule.

Each assessment has its reasons: the gate that stopped it, the class, the two lookups, the places and the rules. The UI shows them.

The table becomes the calculation of AL-31. The calculation multiplies the probability that the event is real, the impact on the person and the urgency. It compares the result with the cost to interrupt the person at that time. The probabilities come from base rates that the event log measures, not from values that a person sets.

## People and places

The contracts carry only ids: `PersonId` and `PlaceId`. The runtime gets people, places, addresses and the night rule of each person from the private configuration.

A person also watches subjects, other than places, in `PersonWatch.subjects`: a source of the system, a service or a cloud region. A watch with no id matches each subject of its system. A rule with places does not apply to a subject. The person who operates the system watches `{ system: "alerts.source" }`, and gets the health reports.

The positions of the places do not go to a source. A source fetches by area, for example all the alerts of a state, and the core matches the places on the machine of the instance. So a `WatchedPlace` gives an adapter region codes and a buffer, and no name, no address and no position. A source that needs a position gets it only when the owner lets that source get it.

The core matches the area of a report to a place with one rule for each source. A polygon or a circle comes first, with the buffer of the place. Else the region codes decide. Polygon math waits for its home, `@mark1russell7/geo`. Until then, the core matches by codes only.

Two codes match when their systems and their values are equal. The first digit of a SAME code is a part of the county, and `0` is the full county. So a part also matches the full county, and the match errs on the safe side.

The area `{ type: "place" }` covers that watched place only. Only the reports of the core use it. An area with only shapes matches no place until `@mark1russell7/geo` has the tests. The assessment then gives the reason `no-codes`. The first sources, the NWS and IPAWS, give codes with each area.

## Open points

- The procedure schemas: Standard Schema validators (zod 4) for each input and output, in the core package.
- The link rule of each family of kind, for rule 3 of the merge.
- The calculation of the level from probabilities and costs (AL-31), with the base rates from the event log.
- The merge state grows with each report. A compaction of the incidents that ended before a horizon keeps it small. It must keep the three laws.
- The taxonomy: the list of codes, from the CAP and NWS event names first (AL-5).

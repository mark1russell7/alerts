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
| `@mark1russell7/alerts-fetch` | `packages/fetch` | The fetch parts that the sources share: the request through polite-crawler, and the map from an answer to a failure. |
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

A line is a report and the reports of its source that update or cancel it. The head of a line is its last report: no report of the same source references it. An incident is live at a time when one or more heads are not cancelled and not expired at that time. Its corroboration is the count of the different origins of its reports.

The severity, urgency and certainty of an incident are the highest of its live heads. An `unknown` value of a head takes the value of the latest report of its event with a known value. That report is not later than the head and is not a cancel. A tie of time takes the highest value. Thus a row of IEM keeps the values of the message of the NWS.

A copy of a message from another source does not get the references of the line. The rule of the copies closes this gap:

- Two reports of one origin with a shared correlation key tell of one event.
- The later reports of the event replace an earlier report, from any source, when together they name each region code of it.
- A replaced report is not a head. Thus a cancel of the NWS also ends the copy of that alert from IPAWS. The rows of IEM, one for each county, end the NWS message of two counties.

For each code, the latest reports that name it stay. So the rule loses no later statement of a code. A code that no later report names keeps its report live, and a report with no region code is not replaced. Then the report stays live until it expires or its source ends it. This error is on the safe side. The rule reads only the reports of the group, so it keeps the three laws.

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
2. **The map tells of format changes.** A part of a message that the map does not understand is a `MapProblem`. Each problem has one effect:
   - A **fatal** problem makes no report.
   - A **lossy** problem (`lossy: true`) keeps the report, but the report lacks a value of the message or holds a fallback in its place.
   - A **note** keeps the whole report. The message has more than the report holds, for example an unknown field.

   Fatal and lossy problems move the health to `changed`. Notes do not. So a renamed value that the map replaces with a fallback shows in the health.
   When the map cannot read an area or a subject that a watch can match, it gives a fatal problem. Until the core matches shapes, an area needs a region code or a place.
3. **The descriptor tells the truth about dependencies.** `origins` names the authorities whose messages the source carries. `dependsOn` names the failure domains outside the cell: providers, CDNs, transmitters. `uses` names the resources of the cell: `internet`, `power`, `receiver`. The coverage uses both.
4. **The ids are hashes of content.** The core gives the id functions in `ids.ts`. An adapter does not make its own ids.
   - `observationId`: the SHA-256 of the source id, the content type, the request URL and the body. The fetch time is not part of it, so a poll with no change gives the same id. The URL is the part that the `map` function reads. A URL with the time of the poll gives the URL with no time, and a test holds that `map` does not read the time.
   - `reportId`: the SHA-256 of the source id, the source key and the sent time.
   - `messageKey`: the SHA-256 of the incident report, the level, the person and the step.
   - The hash input is a JSON array that starts with the scheme `alerts-id/1` and the kind of id. Each copy of the system gives the same id.
5. **The fixtures are real and contain no personal data.** Each adapter keeps recorded answers of its source in `fixtures/`, with the expected reports. The places of the tests are public places, not the places of a real person.
6. **A canary when the source has one.** For example: the national feed of the NWS has one or more active alerts. A national feed with no alert is more likely a fault than a calm country.
7. **The kinds are codes of the taxonomy.** Each kind that `map` gives is a code of `TAXONOMY`. A kind that the tables do not know is `other.unknown`, with a problem. A gate test of the adapter holds this rule with `unknownKinds`.

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
| `changed` | The map gave fatal or lossy problems for the last passed fetch. |

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

## The taxonomy

`TAXONOMY` of the core holds each kind code and its plain name. A code is dotted, for example `met.flood.flash`.

- The first part is a category: the 12 categories of CAP 1.2, then `cyber`, `market`, `civic` and `system`. `categoryOf` gives it.
- The taxonomy is a tree. The parent of each code is also a code, and each category is a root.
- The taxonomy is closed. `knownKind` tells if a code is in it. The coverage codes `system.coverage.<code>` are a family of the core.
- A code with a typo does not match the life-safety class, so it can stop a wake. Thus each adapter has a gate test, and each policy names only known codes.
- The kinds go from physical events to technical outages. A new adapter adds its new codes to `TAXONOMY` in its pull request.

## The route and the delivery step

The core function `route` gives the escalations at a time. Each escalation is one incident, one level and one person.

- The levels of an incident and a person are the levels of its starts and its deliveries, and the assessed level.
- The assessed level counts only when it is higher than those levels and the person has a policy for it. So the level does not go down.
- Only the highest level continues. A lower level ends at the start of a higher level, so its repeats stop.
- An escalation continues until an acknowledgment or the end of the incident. An acknowledgment of a level also covers each lower level.
- The end of an incident is its expiry, or the time when it stops being live.

The start of an escalation is the time at which its level first applied. The runtime writes each start to its log. After a restart, each step comes at its time from the same start.

The runtime does one delivery step in each pass, after the system reports:

1. It polls each open receipt of a channel with the acknowledgment `poll`, one time in each interval. A receipt that the person acknowledged gives an acknowledgment.
2. It writes the start of each new escalation.
3. It sends each step that is due, and it cancels the repeats of each escalation that is over.
4. It writes the result of each call to the log at once, after the call.

Each call of a channel has a time limit. A failed call writes nothing, so the next step decides it again. Before it goes again, a call waits for the time that the channel tells, or for the retry time of the configuration.

A send that passes its time limit stays in flight, because the provider can accept it later:

- No second send of its key starts until the first send ends, or until the flight limit `flightLimit` ends. The flight limit is not shorter than the time limit.
- A late send that the provider accepts gets its delivery in the log at the next step. Thus its acknowledgment and its cancel work.
- After the flight limit, a second send goes. A late first send that lands after it is a duplicate, and the log keeps one delivery of the key.
- A send that the channel accepts in time, and whose write to the log fails, also gets its delivery at the next step. Thus no second send goes.

The Pushover channel tags each emergency message with its delivery key, and it cancels by the tag. Thus a cancel also stops the repeats of a copy whose receipt the log does not have. A crash after a send and before its write is such a case.

A recipient has no problem from `recipientProblems` before it gets alerts:

- A person who watches a place or a subject has a policy of the level `life-safety`.
- No rule keeps a life-safety kind, or the coverage of one, below `life-safety`. A rule with no kinds applies to each kind.
- Each rule names kinds of the taxonomy, and the quiet window has a good time zone and good local times.

The message of a send takes its text from one report of the incident. That report is the latest one with the severity and the urgency of the incident. The body has the instruction first, then the area and the description. The channel cuts the text to its limits.

One part waits:

- The exhaustion alert to the next person waits for a second person (AL-21). Until then, the repeats continue after the exhaustion, and the routes of each pass show it.

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

A kind is in the life-safety class when its warning tells the people at a place to act at once to save their lives. They take shelter, leave, or go to high ground. The class holds tornado, flash flood, extreme wind, hurricane, typhoon, storm surge, fire, tsunami, earthquake shaking, debris flow and volcanic eruption. It also holds the national emergency (EAN), evacuation, shelter in place, civil danger, civil emergency, and chemical, biological, radiological and nuclear hazards. For these kinds, an unknown value counts as high, because a miss costs more than a false alarm. A tornado watch has the urgency `future`, so it is `urgent`: a push at once that does not wake the person.

Some dangerous kinds are not in the class. Their danger comes over hours, or it is on the road or at sea. These kinds reach `urgent` at most:

- extreme heat, extreme cold, a coastal flood, a river flood, a winter storm and a blizzard.
- a dust storm and a snow squall, which are dangers to drivers.
- the marine kinds, and ashfall. The ashfall codes are children of `geo.volcano`, not of the eruption.

A severe thunderstorm with the destructive damage threat is also not in the class. The damage threat tags of the NWS and the Wireless Emergency Alert handling of the issuer are inputs of AL-31.

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

## The service

The runtime operates as one service of `@mark1russell7/service`. Its entry is `packages/runtime/src/main.ts`. Only that file uses `run()`, and only that file reads a real clock.

The loop of the runtime is the worker `passes`:

- The worker does one pass at a time. After a pass, it sleeps until the wake time of the pass, or until `wake()`.
- The function `loopTimes` gives the times of the loop from the limits of the runtime. No time of the loop is set by hand.
- The bound of a pass is the longest fetch limit, plus two calls of the delivery. A failed pass waits its retry, and the wait doubles up to the shortest interval of a source.
- The loop reads two clocks. The monotonic clock of the lifecycle gives its waits and its bounds. The wall clock gives the instants of the runtime.
- A test gives `fakeClock` and `fakeWallClock` of `@mark1russell7/algebra/clock`.

The service keeps the loop alive and safe:

- The check `passes.progress` gates the liveness. It fails when a pass takes longer than its bound, or when the next pass is later than its bound. Then the supervisor stops the process and starts it again.
- The drain holds the pass in flight. Its cap is the cap of the profile, plus the bound of a pass. Thus a shutdown does not cut a pass.
- The service closes the log in the phase `tear down dependencies`, after the close of the worker. Thus no pass writes to a closed log.
- The API on the loopback address gives `GET /status`: the time, the wake time, the sources, the sends and the conflicts of the last pass. It also gives the reason when the loop is stuck. The probes have a port of their own.

The function `openInstance` makes the instance of the owner from the private configuration:

- The sources are the NWS API and IPAWS. The channel is Pushover.
- Each source gets the watch of `sourcePlaces`. Thus a source gets the region codes, and a position only when the place shares it with that source.
- The User-Agent of each request names the project and its page. It names no person.
- The times of the delivery come from facts of the channel. A call has a limit of 10 seconds. The poll goes at the pace of the emergency repeats, 30 seconds.
- A failed call goes again after one time limit of a call. The flight limit is two time limits.
- The limits of the lateness use the quantile 0.99, at the level 0.95.

The instance does not start when it finds one of these problems:

- a missing secret, or a key that does not have the form of a Pushover key (30 letters and digits)
- each problem of `parseConfig`: the JSON, the schema and the references
- a place that no source covers. Usually the place does not have a code of each level: the zone, the county, SAME, the state and the country.

The environment gives `PORT` (8080), `PROBE_PORT` (9090) and `SERVICE_PROFILE` (`local`, `daemon` or `pod`). The folder `ALERTS_HOME` (`.alerts` in the home folder) holds the private files: `config.json`, `secrets.env` and the log `runtime.sqlite`. No repository holds them. A problem of `secrets.env` names its line and its key, and no value. The output of a failed pass shows no value of `secrets.env`.

## People and places

The contracts carry only ids: `PersonId` and `PlaceId`. The runtime gets people, places, addresses and the night rule of each person from the private configuration.

### The private configuration

The core gives the format of the private configuration, `AlertConfig` (`alerts-config/1`). The repository holds no configuration. Each copy of the system loads the same configuration.

- `places`: the id, a label, a position, the region codes and the buffer of each place. The field `sharePosition` names the sources that get the position.
- `people`: the `PersonWatch` of each person, a label, and the escalation policies of the person.
- `contacts`: the address of a person on a channel. A value of an address is a text, or a reference `{ secret: "NAME" }` to a key of the secret store.
- `policies`: the escalation policies of each person with no policies of their own.

The times of the delivery and the rank of a copy are not in `AlertConfig`. They are settings of each copy.

The schema `alertConfigSchema` checks the JSON of the configuration first. Then the function `loadConfig` checks the references and makes the recipient of each person. The caller gives the secret store, so the core reads no file. The runtime does not start when the load gives a problem. The load finds:

- two places or two people with one id, and a place with no region code
- a place of a person or of a rule that the configuration or the person does not have
- a contact of an unknown person, two contacts of a person on one channel, and a secret with no value
- each problem of `recipientProblems`

A problem names ids, fields and the names of secrets. It does not hold the value of a secret, a label or a position.

The function `parseConfig` reads the JSON text of the configuration. It checks the JSON, then the schema, then the references. Its result is a `Result` of `@mark1russell7/optional`: the configuration and the recipients, or the problems. The runtime starts only with an `ok` result. A problem of the JSON does not quote the text, because the text can hold a private value.

The function `sourcePlaces` gives the places for one source, with no label, and with a position only when the place shares it with that source. The function `localPlaces` gives each position for the matching on the machine of the instance.

A person also watches subjects, other than places, in `PersonWatch.subjects`: a source of the system, a service or a cloud region. A watch with no id matches each subject of its system. A rule with places does not apply to a subject. The person who operates the system watches `{ system: "alerts.source" }`, and gets the health reports.

The positions of the places do not go to a source. A source fetches by area, for example all the alerts of a state, and the core matches the places on the machine of the instance. So a `WatchedPlace` gives an adapter region codes and a buffer, and no name, no address and no position. A source that needs a position gets it only when the owner lets that source get it.

The core matches the area of a report to a place with one rule for each source. A polygon or a circle comes first, with the buffer of the place. Else the region codes decide. Polygon math waits for its home, `@mark1russell7/geo`. Until then, the core matches by codes only.

Two codes match when their systems and their values are equal. The first digit of a SAME code is a part of the county, and `0` is the full county. So a part also matches the full county, and the match errs on the safe side.

The area `{ type: "place" }` covers that watched place only. Only the reports of the core use it. An area with only shapes matches no place until `@mark1russell7/geo` has the tests. The assessment then gives the reason `no-codes`. The first sources, the NWS and IPAWS, give codes with each area.

## The schemas

The file `schemas.ts` of the core has one zod 4 schema for each data type of the contracts and of the configuration. A schema checks data at a trust boundary. The boundaries are the output of a map function, the event log, the private configuration and the procedure tools.

- The types stay the source of truth. The type check fails when a schema and its type are different. This includes each optional key and each readonly key.
- Each object is strict, so an unknown key fails. An optional key with the value `undefined` also fails.
- No schema has a transform, so `z.toJSONSchema` converts each one for the procedure tools.
- A refinement holds each rule of a value that a type cannot hold, for example the anchor of an incident or a known kind code.
- The function `checkWith` checks a value with a schema at a boundary. Each problem names the path and the rule, for example `places[0].bufferKm`. It does not hold the value.

## Open points

- The procedure tools take the schema of each input and output from `schemas.ts`.
- The link rule of each family of kind, for rule 3 of the merge.
- The calculation of the level from probabilities and costs (AL-31), with the base rates from the event log.
- The merge state grows with each report. A compaction of the incidents that ended before a horizon keeps it small. It must keep the three laws.

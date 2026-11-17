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
| `@mark1russell7/alerts-atlas` | `packages/atlas` | The source atlas: each signal class, the candidate sources of each class with a decision and its reason, and the records of the research rounds. Its gate needs 2 or more sources with no risk for each class, or a reason. It measures the layers of the cover of each class. |
| `@mark1russell7/alerts-channel-<id>` | `packages/channel-<id>` | One delivery channel as procedures. |
| `@mark1russell7/alerts-runtime` | `packages/runtime` | The service: the loops, the event log, the delivery ledger and the heartbeat, on `@mark1russell7/service` and the SQLite home. |
| `@mark1russell7/alerts-testkit` | `packages/testkit` | The conformance tests of the adapters, the fixtures and the fault plans. |
| `@alerts/site` | `packages/site` | The public site: a demo that replays made-up messages through the real code. It holds no person and no place. |

The preparedness planner (AL-20) and the app with the map of the watched places (AL-18) get their folders when they start. A package of this repo is for a general part. A part that names a person or a place stays in the private configuration.

The repo is public. It holds no person, no place, no address and no key. The private configuration gives them at run time: people and places from a private store, keys from `~/.alerts/secrets.env`.

## The merge laws

The merge state is a set of grow-only sets: reports, acknowledgments, deliveries and end marks. The join of two states is their union. So the join is:

- **idempotent**: `join(a, a) = a`. A duplicate report changes nothing.
- **commutative**: `join(a, b) = join(b, a)`. The order of arrival changes nothing.
- **associative**: `join(join(a, b), c) = join(a, join(b, c))`. Two copies of the system that exchange their states get the same state.

Two copies can get one report id with two contents, for example from two versions of an adapter. The join then keeps the content with the smaller canonical JSON (RFC 8785). This choice is a total order, so the join keeps the three laws.

The groups of reports are a function of the merge state alone, with no clock. Two reports of one status are in one incident when:

1. one report references the other (the CAP references), or
2. they share a correlation key (an NWS VTEC event, a USGS event id), or
3. the link rule of their kinds matches: the same family of kind, two onsets near in time and two points near on the ground (below).

The links are transitive: when A links to B and B links to C, the three reports are in one incident. A link rule gives the blocks of a report, for example its family of kind and its day. The merge tests only two reports that share a block. So the cost grows with the size of the blocks, not with the square of the count of reports.

### The link rule (rule 3)

Two sources can report one real event with different ids. Then no reference and no correlation key joins their reports, and the person gets two alerts for one event. The link rule joins them.

The rule comes from a policy, `LinkPolicy`. The function `linkRule` makes the rule of a policy. The first policy, `DEFAULT_LINK_POLICY`, has one family: `geo.earthquake`. Two reports of this family link when:

- their onsets are 30 s apart or less
- the centers of their circle areas are 100 km apart or less, on the great circle
- the values of their parameter `magnitude` are 1.0 apart or less.

The rule is on the safe side. A false join can hide a second event after an acknowledgment, but a false split gives only a second alert. Thus:

- A report with no onset, no circle area or no magnitude links to no report. The magnitude counts only when the family has a limit of the magnitude.
- Two reports of one source do not link. A source that gives two ids tells of two events, for example a shock and its aftershock.

The field `link` of the private configuration replaces the policy, and `linkPolicySchema` checks it. A family is a code of the taxonomy or a prefix of codes. The blocks of a report are the slot of its onset and the slot before it. A slot is as long as the window of the family.

The chain is a known limit. The rule compares two reports at a time, and the incidents are the connected components. Two events of one source 25 s apart stay apart. A report of another source between them links to each of them, and the three reports are then one incident. A gate case of `link.test.ts` holds this limit.

A pairwise rule only joins incidents when a report comes. It does not split an incident, so a sent alert stays with its incident. The severity of the incident is the highest of its live heads.

### The lines and the heads

A line is a report and the reports of its source that update or cancel it. The head of a line is its last report: no report of the same source references it. A cancel of a part is the one exception (below). An incident is live at a time when one or more heads are not cancelled, not expired and not ended at that time. Its corroboration is the count of the different origins of its reports.

The severity, urgency and certainty of an incident are the highest of its live heads. An `unknown` value of a head takes the value of the latest report of its event with a known value. That report is not later than the head and is not a cancel. A tie of time takes the highest value. Thus a row of IEM keeps the values of the message of the NWS.

A copy of a message from another source does not get the references of the line. The rule of the copies closes this gap:

- Two reports of one origin with a shared correlation key tell of one event.
- The later reports of the event replace an earlier report, from any source, when together they name each region code of it.
- A replaced report is not a head. Thus a cancel of the NWS also ends the copy of that alert from IPAWS. The rows of IEM, one for each county, end the NWS message of two counties.

For each code, the latest reports that name it stay. So the rule loses no later statement of a code. A code that no later report names keeps its report live, and a report with no region code is not replaced. Then the report stays live until it expires or its source ends it. This error is on the safe side. The rule reads only the reports of the group, so it keeps the three laws.

The rule of a part: a cancel that names a proper subset of the codes of the report that it references ends only those codes. The NWS ends a part of a warning so: one cancel for the part, and one update for the rest. When the update is lost, the rest stays live until it expires, on the safe side. Each other reference ends the whole report, as CAP tells.

A later statement of a code also removes the code from the areas of the incident. The incident takes from each head only its codes with no later statement. A block with such a code also loses its shapes, because a code cannot cut a shape. The block then decides by its other codes, and a block with no shape covers each place in its codes. So this error is on the safe side too.

An end mark tells that a report of a snapshot source left the list of the source (`ended: true`), or is in the list again (`ended: false`). A report is ended at a time when its latest mark at or before that time is an end. When two marks of one report have the same time, the report stays live. This choice is on the safe side, and it is a function of the set, so the three laws hold. A mark changes no group. It changes only the field `live` and the levels of the live heads. An ended report still gives its known values to the fill of `unknown` values, as an expired report does.

An end mark can also hold the time of the data of the list that ended the report (`asOf`). The runtime reads it to refuse an old list. The merge does not read it.

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
   When the map cannot read an area or a subject that a watch can match, it gives a fatal problem. A place with no position matches only by codes, so an area needs a region code or a place.
3. **The descriptor tells the truth about dependencies.** `origins` names the authorities whose messages the source carries. `dependsOn` names the failure domains outside the cell: providers, CDNs, carriers, transmitters. Each id starts with its kind, for example `cdn:akamai`. `uses` names the resources of the cell: `internet`, `dns`, `power`, `receiver`. The coverage uses both.
4. **The ids are hashes of content.** The core gives the id functions in `ids.ts`. An adapter does not make its own ids.
   - `observationId`: the SHA-256 of the source id, the content type, the request URL and the body. The fetch time is not part of it, so a poll with no change gives the same id. The URL is the part that the `map` function reads. A URL with the time of the poll gives the URL with no time, and a test holds that `map` does not read the time.
   - `reportId`: the SHA-256 of the source id, the source key and the sent time. A message with two or more reports adds the part of each report, for example the info block `info[1]` of a CAP message.
   - `messageKey`: the SHA-256 of the incident report, the level, the person and the step. An episode after the first one is also in it.
   - The hash input is a JSON array that starts with the scheme `alerts-id/1` and the kind of id. Each copy of the system gives the same id.
5. **The fixtures are real and contain no personal data.** Each adapter keeps recorded answers of its source in `fixtures/`, with the expected reports. The places of the tests are public places, not the places of a real person.
6. **A canary when the source has one.** For example: the national feed of the NWS has one or more active alerts. A national feed with no alert is more likely a fault than a calm country.
7. **A snapshot source tells it.** A source whose complete fetch gives each message in effect sets `listing: "snapshot"`. A message of such a list ends when it leaves the list, with no cancel.
   - After `SNAPSHOT_MISSES` complete fetches in a row with no observation of a live report, the runtime writes an `ended` event.
   - A failed fetch or an incomplete fetch counts nothing.
   - A report that ended and is in a complete list again gets a `back` event.
   - The counts are in memory only. A restart makes an end later, not sooner.
   - A cache can give an old list that is complete. A complete fetch of a snapshot source gives the time of its data (`asOf`): the time of its newest product.
   - An absent report counts a miss only when its `sent` time is not after `asOf`. A newer report keeps its count.
   - The end mark keeps the `asOf` of the list that ended the report. A report comes back only in a list with a later `asOf`.
   - A list with no `asOf` counts as current.
8. **The kinds are codes of the taxonomy.** Each kind that `map` gives is a code of `TAXONOMY`. A kind that the tables do not know is `other.unknown`, with a problem. A gate test of the adapter holds this rule with `unknownKinds`.

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

The cell is the copy of the system on one machine. Its internet link, its DNS resolver, its power and its receivers are common to each of its sources. A source that uses `internet` also uses `dns`. So a source names them in `uses`, not in `dependsOn`. Else each internet source falls into one group, and the coverage cannot tell two providers apart.

`coverage(input, policy)` gives the coverage of each kind at each place. It is a pure calculation on the descriptors, the health of the sources and the places.

- A source counts when its health is in `policy.up`. The first policy counts `healthy` and `slow`. A source with no health is `unknown`.
- A source covers a kind when one of its prefixes has the kind. A source of a part of the kind does not count.
- A source covers a place when its coverage is `global`, or when a code of its coverage holds a code of the place (`regionContains`). So a place lists its codes at each level: the NWS zone and county, SAME, the state (`state`) and the country (`iso3166`).
- A SAME code of a part of a county does not hold the full county. This rule errs on the safe side for the coverage: a source of a part does not hide a gap.
- A shape of the coverage covers a place when the shape contains the position of the place. The buffer does not count, as for the codes.
- A shape covers no place with no position. A shape that `@mark1russell7/geo` refuses covers no place, so the coverage shows a gap.

The coverage has these parts:

- `independent`: the smallest count of outside failure domains whose faults stop each source of the kind that is up. At 2 or more, no single outside fault stops the coverage. The policy asks for 2 or more for each life-safety kind, and 1 for each other kind. A smaller count is a system report: `urgent` for a life-safety kind, and `life-safety` at zero during a watch or a warning at the place.
- `faults`: the domains of that smallest set. The report names them. A source with no domain in `dependsOn` gets its own domain `source:<id>`.
- `proven`: the search of the smallest set ended. The count is a minimum hitting set, and `minimumHittingSet` of `@mark1russell7/collections/graph` calculates it exactly. When the search passes its budget, `proven` is false, and `coverageShort` gives true. A count that the search did not prove is not a pass.
- `commonResources`: the cell resources that each of these sources uses. One fault of one of them stops all of these sources in this cell. The radio input and a second cell remove these common faults. The blindness formula of the design study uses them as the shared fault `c`.

### System reports

`systemReports(lines, snapshot, at)` makes the reports of the core. Each source in `DOWN_STATES` (`failing`, `silent` and `changed`) is a condition. Each coverage that `coverageShort` finds is a condition. Each stage of the quota of a channel and each stage of the balance of a provider account is a condition. Each condition is a line of CAP reports with the status `system` and the source `system`:

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

A quota report has no area. Its subject is `{ system: "alerts.channel", id: <channel id> }`. Its kind is `system.quota.<stage>`, and it gets `notice` at most. `quotaStages` gives the stages that a quota reached, and each stage is one line:

| Stage | Condition | Severity, urgency |
| --- | --- | --- |
| `low` | 2 reserves of units or fewer left in the window | `moderate`, `expected` |
| `reserve` | The reserve or fewer left. The channel sends only `life-safety`. | `severe`, `expected` |
| `spent` | The provider refuses each message | `severe`, `immediate` |

- The facts of a line are the channel, the stage and the end of the window. A new count gives no update. Thus each stage gives one alert in a window.
- The message of the line `reserve` has `useReserve`. The channel sends it from the reserve, one time in each window (`PUSHOVER_RESERVE_NOTICES`). Else the reserve stops the message that tells of it.
- A snapshot with no quotas keeps each open line of a quota. Thus a failed read of a count ends no line.
- A quota can name its units with `unit`. The cap of the spend of a paid account counts `cents` (`spendQuota` of the runtime).
- `spendGates` of the runtime gives two gates of one cap, on one count. The gate of `life-safety` has no reserve. Thus only `life-safety` uses the reserve.

A balance report has no area. Its subjects are `{ system: "alerts.channel", id: <channel id> }` for each channel that the account pays for. Its kind is `system.balance.<stage>`, and it gets `notice` at most. `balanceStages` gives the stages of a `ProviderBalance` at a time, and each stage is one line:

| Stage | Condition | Severity, urgency |
| --- | --- | --- |
| `low` | The last read is below the floor | `moderate`, `expected` |
| `empty` | The last read is 0 or less. The provider refuses each paid message. | `severe`, `immediate` |
| `unread` | No read passed for the maximum age or longer (`balanceUnreadAt`) | `moderate`, `expected` |

- The facts of a line are the provider and the stage. A new balance gives no update.
- `low` and `empty` come from the last read that passed, also when the read is old. A read that passes ends `unread`.
- A snapshot with no balances keeps each open line of a balance.
- The runtime gives `balanceWatch` for each account. Each pass checks each watch, and a watch reads once a day. A failed read tries again after one hour.
- The time of the next read and the time of `unread` are timers of the pass.

A clock report has no area. Its subject is `{ system: "alerts.clock", id: "wall" }`. Its kind is `system.clock.step`, with the severity `minor` and the urgency `past`. Thus it gets `digest` at most:

- The condition is the latest step of the wall clock in `CLOCK_STEP_WINDOW` (24 hours) before the time of the snapshot (`recentStep`).
- The facts of the line are the time and the size of the step. A second step in the window gives an update.
- The line stays open for the window, thus the digest of the day shows the step. At the end of the window, the line ends with a cancel.
- The headline gives the direction and the size of the step, in whole hours, minutes or seconds (`stepSizeText`).

A log report has no area. Its subject is `{ system: "alerts.log", id: "runtime" }`. Its kind is `system.log.recovered`:

- The condition is the latest recovery of the log in `LOG_RECOVERY_WINDOW` (24 hours) before the time of the snapshot (`recentRecovery`).
- When the salvage read each part of the broken file, the severity is `minor` and the urgency is `past`. Thus it gets `digest` at most.
- When the salvage could not read each part, the severity is `moderate` and the urgency is `expected`. Thus it gets `notice` at most.
- The facts of the line are the time, the quarantine folder, the counts and the flag `whole`. A second recovery in the window gives an update.
- The line stays open for the window. At the end of the window, the line ends with a cancel.
- The description names the quarantine folder and the count of the kept events.

A copy report has no area. Its subject is `{ system: "alerts.copy", id: <copy id> }` (`COPY_SUBJECT`). Its kind is `system.copy.<stage>`, with the severity `moderate` and the urgency `expected`. Thus it gets `notice` at most. `copyStages` gives the stages of a `CopyWatch` at a time, and each stage is one line:

| Stage | Condition |
| --- | --- |
| `skew` | The clocks of the two copies differed by more than `skewLimit` at the last read |
| `config` | The other copy had a different hash of the configuration at the last read |
| `unread` | No read passed for the maximum age or longer (`copyUnreadAt`) |

- The facts of a line are the copy and the stage. A new difference or a new age gives no update.
- `skew` and `config` come from the last read that passed, also when the read is old. A read that passes ends `unread`.
- A snapshot with no copies keeps each open line of a copy.
- The time of `unread` is a timer of the pass.

A drill report has no area. Its subject is `{ system: "alerts.drill", id: <drill id> }` (`DRILL_SUBJECT`). Each copy has its own lines, thus the name of a line holds the copy id.

| Line | Kind | Condition | Level |
| --- | --- | --- | --- |
| `drill/<copy>/<id>` | `system.drill.run` | The last run waits for its acknowledgment | `life-safety` (`extreme`, `immediate`) |
| `drill/<copy>/<id>/failed` | `system.drill.failed` | The verdict of the last run is `failed` | `notice` at most |
| `drill/<copy>/<id>/no-start` | `system.drill.failed` | The drill has no next start | `notice` at most |
| `drill/<copy>/<id>/missed` | `system.drill.failed` | The window of the next start after the last run ended with no run | `notice` at most |

- `DrillSnapshot` gives the copy, the drill and its last run. A drill that is due has a run that starts at the time of the snapshot.
- The facts of the run line are the copy, the drill and the start. An acknowledgment in the time cancels the line.
- At the end of the time, the run line ends, and the failed line opens. A late acknowledgment gives an update of the failed line.
- The next run ends the failed line. A snapshot with no drills keeps each open line of a drill.
- A snapshot with `noStart` opens the line `no-start`, with the reason `no-start`. A next start ends it.
- A snapshot with `missed` opens the line `missed`, with the reason `missed` and the missed start as its onset. The next run ends it.
- `missedDrillAt(drill, runs, at, quiet)` gives the missed start. A late start in the same window is not a miss, and before the first run nothing is missed.

`latestIn(items, at, window)` gives the latest item in a window before a time. `recentStep` and `recentRecovery` use it.
`threats(incidents, places)` gives the watches and the warnings. A threat is a live incident with the status `actual` at a watched place. Its stage is `watch`, `warning` or absent. A report of the core has the status `system`, so it is not a threat.

The assessment policy holds three system classes, and each class admits only the status `system`. The class `system-drill` holds the drill runs, and it reaches `life-safety`. A class can name its statuses. Else the statuses of the policy apply. The NWS kinds `system.test` and `system.admin` are not in these classes, so the policy statuses apply to them.

### Lateness across sources

Some sources carry a copy of the messages of another source. FEMA IPAWS carries each NWS warning for Wireless Emergency Alerts. Over 30 days, the public IPAWS feed had 17 gaps of 4 hours or more and one gap of 12.6 hours. So a quiet feed is normal, and the quiet timer of the health cannot show that the source stopped. The check across sources shows it.

- An `Expectation` is data: the source `from`, the source `to` and a `ReportFilter`. For IPAWS, the filter is the status `actual` and the parameter `WEAHandling`.
- The two copies must be in one incident. So the source `to` must give a correlation key of the source `from`, for example the VTEC key.
- `carriages(state, incidents, expectations)` gives one check for each expectation and each message of `from`. A message is the reports of `from` in one incident with one sent time that pass the filter. Its copy is the first report of `to` in the incident with the same sent time. Thus an extension has its own check. The result is a function of the set of reports.
- `delayLimit(delays, { quantile, level })` gives the limit of the delay. It is the distribution-free upper bound of the quantile of the measured delays, from `quantileInterval` of `@mark1russell7/rigor-statistics`. No person sets a time.
- A small sample has no upper bound. Then the expectation has no limit, and the check only measures.
- `decide(checks, expectation, at, limitOf)` gives the record of one expectation: one decision for each check that started by `at`, in the order of the start. The record is a fold over the time.
- The deadline of a check is fixed at its start: `started + limit`, with the limit in force at that time. A later change of the limit does not move it.
- A check is `met` when its copy comes by the deadline, and `missed` when the deadline passes first. A copy after the deadline is a miss. A check before its deadline with no copy is `open`.
- A met check gives its delay to the sample of the delays. A missed check gives its limit, because its delay is only known to be more than the limit. Thus a lag or a backlog of the copies does not raise the limit.
- In the warm-up, no limit is in force. A check is `measured` when its copy comes, and `waiting` before that. A warm-up check is not a miss.
- With the measured rule, each limit after the first limit is at most the first limit. The rank of the bound grows by 1 or less for each sample, and each new sample is at most the limit at its start. Two gates of `lateness.test.ts` hold these rules.
- Thus a lasting rise of the normal delay shows as a lasting late state. A person ends it with a new baseline: an entry `{ id, since }` in the field `expectations` of the configuration.
- The `since` of an `Expectation` starts its record. `lateness` reads only the checks that start at `since` or later. The check of the instance refuses an unknown id and a `since` in the future.
- In normal work, some copies come late and some copies do not come. So one miss is not a proof.
- `missRecord(record)` counts the misses of the past. Only a decided check after a met check is a trial, so a long stop of the source counts as one miss.
- `missLimit(record, level)` gives the count of misses in a row that makes the source late. It is the smallest k with `high ** k <= 1 - level`. `high` is the upper bound of the rate of the misses, from `clopperPearson` of `@mark1russell7/rigor-statistics`. No person sets a count.
- `limitRule({ quantile, level })` gives the measured rule: `delayLimit` for the delay and `missLimit` for the count.
- `lateness(checks, expectations, at, rule)` gives the state of each expectation: `no-limit`, `no-data`, `met` or `late`. The source is late when the misses after the last met check reach the count.
- A lag keeps the source late: each copy after its deadline is a miss. The first met check ends the misses, because it shows that the source carries the reports in time again.
- `wakeAt` is the next deadline of an open check. The runtime starts `lateness` again at that time.
- Each decision calculates the limit again, so the cost is O(n²) for n checks.

A late source has two effects:

- `coverage` does not count it, also when its health state is up. Its fetches pass, but it does not carry the reports. `lateSources` gives the list for `CoverageInput.late`.
- Each late expectation is a line of system reports with the kind `system.health.late`. Its subject is the source `to`, so it goes to the person who watches the sources. Each new miss is a new fact, so it gives an update.

A copy that did not come is not a measure of the delay, because its delay is not known. So a sample from a time when the source was down gives a lower limit of the delay. A lower limit gives more late states, which is the safe side. In normal work, a run of misses that makes the source late comes with a chance of `1 - level` or less.

## The channel contract

Each channel package registers four procedures under `alerts.channel.<id>`:

| Procedure | Effects | Rule |
| --- | --- | --- |
| `describe` | none | It gives the `ChannelDescriptor`: the failure domains, the cell resources, the break through Do Not Disturb, the repeats, the kind of acknowledgment and the cost. |
| `send` | writes `network` | It sends one `Message` to one `Address`, with the copy id of this send. When `message.quiet` is true, it uses its silent mode. A failure is `{ ok: false }`. It does not throw. |
| `status` | reads `network` | It gives the state of a receipt: accepted, delivered, acknowledged, expired or failed. |
| `cancel` | writes `network` | It stops the repeats of a message: each copy of a receipt, or one copy by its copy id. It is idempotent. |

A descriptor with `address` tells the fields of the address of a person on the channel. Each field has a name, a need and a form.

- The load of the configuration checks each address on a known channel with `addressProblems`. A problem stops the start, before the first alert.
- An address has each necessary field, and each value has the form of its field. It has no field that the channel does not read.
- A problem names the field and its form, and not its value, because a value can be a secret.
- The form is a regular expression of the whole value. Pushover takes the key form of `@procedures/notify`. The Twilio call takes a phone number in E.164 form.

The channel does not escalate. The core does:

- An `EscalationPolicy` gives the steps of a level: a channel and a time for each step. The first step of `life-safety` is Pushover at emergency priority. It repeats until acknowledged, and sounds through silent mode with iOS Critical Alerts.
- The escalation is a state machine on the clock of algebra: sent, then acknowledged, or the next step at its time, or exhausted. Exhausted is a system alert to the next person in the policy.
- An acknowledgment comes from any channel or from the UI. It stops the escalation of that level of that incident, and the core cancels the repeats on the other channels.
- Only an acknowledgment proves that the person got a message. The Pushover receipt field `last_delivered_at` is the time of a retry of the server, not a proof.
- The core decides the silent mode. `escalate` sets `quiet` on each send, and `Message.quiet` takes it. Each channel maps it to its silent mode: Pushover priority `-1`, or a text and no call on Twilio. No channel keeps its own rule about the time of day.
- On an iPhone, an Emergency message of Pushover sounds through silent mode only when the Pushover app has Critical Alerts on for Emergency. A reset of the iOS permission of Pushover turns that setting off.
- A channel with `why` in its descriptor gets a why line in `Message.why`: why the message reaches the person, in the limit of the channel. `WHY_LIMITS` in `why.ts` holds the limit of each kind of channel. Pushover takes the push limit, and puts the line first in the body.

The Twilio call channel makes one voice call for each send:

- The call says the title, the why line and the body two times. Its last sentence tells the person to acknowledge in the app.
- A quiet message, a message that expired and an address with a problem get no call. The outcome is `refused`.
- An answer is `delivered`, and not `acknowledged`. The machine detection of Twilio can take a voice mailbox for a person.
- A call that nobody answered, and a call that Twilio could not make, are `failed`. The escalation goes to its next step.
- `cancel` ends the call in each state. Twilio refuses the end of a call that it does not know, and the cancel ends with no error.
- `readTwilioBalance` reads the balance of the account. It gives each failure as a value.
- `twilioSetupProblems` checks the credentials and the number that calls, with no request. A problem names the field, and no value.

The cap of the spend of a call channel is two gates of `polite-crawler/api`, with one store, one key and one quota name:

- The two gates count the same units. The gate of `life-safety` has no reserve. Thus only `life-safety` uses the last part of the cap.
- A full cap gives `rate-limited`. A cap in its reserve gives `reserved` to a message below `life-safety`.
- A call that Twilio refused, did not authorize or limited gives its units back. Twilio made no call.
- A network fault, a time-out and a server error keep the units, because the call can have started.
- A fault of the store of a gate does not stop a call. The call goes with no count.

## The delivery promise

For `life-safety`, the system prefers a duplicate to a miss.

- Each copy of the system keeps the delivery ledger in its merge state. A copy waits for its rank times a short delay before a send, and does not send when the joined ledger already has the delivery.
- When two copies cannot reach each other, both can send. Then the person can get the alert two times. The person does not get it zero times.
- The message key is the SHA-256 of the incident report, the level, the person and the step. A channel that can drop a repeated key does so.

## The copies of the system

A copy of the system is one runtime on one computer: a cell. When one computer, its power or its link stops, a second copy still sends the alerts (AL-16). This section gives the design. Some parts of it are not in the code yet.

### The settings of a copy

Each copy loads the same `config.json` and `secrets.env`. The file `copy.json` of `ALERTS_HOME` gives the settings of one copy, and each copy has its own file:

- `format`: the text `alerts-copy/1`.
- `id`: the name of the copy, for example `home` or `cloud`. Two copies do not have the same id.
- `rank`: the order of the copy, from 0. The copy with rank 0 sends first.
- `listen`: the address and the port of the exchange. The address is the tailnet address of the computer, not all addresses.
- `peers`: the id and the URL of the exchange of each other copy.
- `pingKey`: the key of `secrets.env` that holds the ping URL of the first check of this copy. The default is `HEALTHCHECKS_PING_URL`. It is not the key of the loud check, because the copies share the loud check.

Without `copy.json`, the runtime is the only copy. It has rank 0 and no exchange. The key `COPY_TOKEN` of `secrets.env` gives the token of the exchange, the same for each copy. The check of the profile `daemon` needs it when the copy has other copies.

The runtime reads `copy.json` at its start, and the reload hook watches it with `config.json` and `secrets.env`. A change that passes the check restarts the runtime. A file with problems gives way to the last good set of the private files, and a problem holds no address and no URL.

### The rank wait

A copy waits `rank × RANK_DELAY` before each send: the knob `rank_wait` of the escalation. `RANK_DELAY` is 30 seconds, the sum of four times:

- the flight limit of one send, 20 seconds: the copy before writes its delivery in this time
- the period of the exchange, 5 seconds
- the time limit of one exchange, 3 seconds
- the limit of the difference between two clocks, 2 seconds

Thus when each copy is up, the copy after gets the delivery of the copy before, and it does not send. A late pass of the copy before can give a duplicate, and the delivery promise accepts it.

A copy with a higher rank sends first when it sees the incident `RANK_DELAY` or more before the other copies. Then the other copies get its delivery, and they do not send.

The field `rankDelay` of the configuration gives the wait of one rank for a level. With 0 for `life-safety`, each copy sends each life-safety push at once. Thus the worst alerts come once from each copy.

A phone takes one call at a time. Thus a channel with `exclusive` in its descriptor has a rank floor: the least wait of one rank before its step. The wait of a step is `rank × max(rank delay of the level, floor of the channel)`. The Twilio call channel is exclusive. The default floor `RANK_FLOOR` is 31 seconds, for the worst case:

- the copy with rank 0 sees the incident one exchange after the copy with rank 1: 5 seconds and 3 seconds
- the call of rank 0 ends in the call limit, 10 seconds
- a read in progress misses the delivery, thus two periods and one time limit bring it to rank 1: 13 seconds

The field `rankFloor` of the configuration replaces the default floor. A push channel has no floor.

### The exchange

Each copy reads the log of each other copy, and adds the shared events to its own log:

- The procedure `alerts.log.entries` gives the shared events of the log after a position, one page at a time. It also gives the time of the copy and the hash of its configuration.
- A page has the format `alerts-exchange/1`. It examines 500 entries of the log or fewer. It gives the head of the log and the position of the next page.
- Each page gives the id of the log: the id of its first event, or the id of its last event `recovered`. The salvage of a broken file gives new positions. Thus a new log and a recovered log have a new id, and the worker starts again from 0.
- The procedures host of `@procedures/peer` serves the procedure on the address `listen`. The host checks the token. The runtime has no route and no token check of its own.
- A worker of each copy reads each other copy each 5 seconds, with a time limit of 3 seconds. It keeps the read position of each copy in memory.
- The worker refuses a page that starts after its position, because the page skips entries.
- A recovery of the log of this copy clears the positions of the other copies. The salvage can lose an import and keep the position after it.
- The event `exchange` writes the position to the log with the imports of a page, or after 10,000 entries with no import. Thus a restart reads 10,000 entries again or fewer.
- At its start, a copy reads each other copy before its first delivery step, for one time limit or less. Thus a restart does not repeat the sends of another copy.

The shared events are the parts of the merge state and of the delivery ledger:

- the reports of each `fetch` event, with no fetch record and no cursor
- the events `delivery`, with no copy id, because a copy id names the tries of a send in one copy
- the events `ended`, `back`, `acknowledgment`, `cancelled` and `escalation-end`

The other events stay in their copy, because each copy has its own sources, health and channels:

- the events `started`, `observation`, `system`, `escalation`, `clock`, `recovered` and `drill`
- the events of the tries of a send: `attempt`, `settled` and `refused`

The rules of an import:

- A copy writes each shared event of another copy as an event `import`. Its field `from` holds the id of the copy that wrote the event, and its field `event` holds the event.
- An import of a step of the ledger keeps the id of its event. The log keeps one event for each id, thus the same delivery of two copies is one event.
- An import of a `fetch`, `ended` or `back` event gets the id of its copy before its id. Each copy gives its own ids to these events.
- The import checks each item of a page with the schemas of the core. A bad item gives a problem with no value of the event, and the other items go in.
- The fold of an imported event changes only the shared state. It is the merge, the cancels, the ends of the escalations and the refusals of a delivered key.
- The state keeps the own parts of the merge apart from the imported parts. The views join the two sides. The snapshot step of a source reads only the own parts.
- The health, the cursors and the counts of the deliveries of each channel stay with their copy.
- A copy also gives the events that it imported. Thus three copies agree when only two pairs of them can reach each other. A copy skips the events that it wrote.
- The instants of an imported event come from the clock of another copy. Thus a step of the clock of this copy does not move them.
- An acknowledgment goes to each copy. Each copy polls the receipts of each delivery in the ledger, thus an acknowledgment comes also when the copy of the send is down.

The exchange also checks the copies. Each of these faults is a line of system reports:

- the time of another copy differs from the time of this copy by more than 2 seconds, at the middle of the call
- another copy has a different hash of the configuration: then the copies can route an alert in two ways
- the reads of another copy fail for 60 seconds: then the two copies can both send

The worker of the exchange (`exchangeWorker` of the runtime) does the reads:

- A round reads each other copy at the same time. It reads the pages of a copy until the copy has no more entries, or for 20 pages.
- A copy with more entries gives `more`. Then the next round starts at once. Else the next round starts after 5 seconds.
- A round that imports an event or changes a stage wakes the loop of the passes.
- Each read that passes gives the watch of its copy. The time of the read is the middle of the call, on the clock of this copy.
- The skew is the time of the other copy minus the time of the read.
- A failed read, a bad answer or a page of another copy is a failure of the copy. The worker keeps its message, and the last read stays.
- A step of the wall clock moves the times of the watches, as it moves the other times of the runtime. A read with a step during its call keeps its imports, but it gives no times.
- Each pass waits for `ready` of the worker before its view. It resolves after the first round, or after one time limit.
- The transport is a parameter (`ExchangeCall`). `serveEntries` gives the output of the procedure on the side of the other copy.

The HTTP transport (`exchange-http.ts` of the runtime) carries the reads:

- The procedures host of the exchange has the base path `/exchange` on the address `listen`. The reader adds the base path to the URL of each other copy.
- The host serves only `alerts.log.entries`, and it is read-only. Its probes are off, because the probes of the service stay on the loopback.
- Each call needs the token `COPY_TOKEN` in the header `Authorization`. A call with another token or with no token gets 401, and the source reads no page.
- The token has 32 characters or more. Without it, a copy with other copies or with the address `listen` does not start.
- The host checks the input before the handler. `after` is a whole number of 0 or more, and `limit` is from 1 to 500. The input has no other field.
- The reader keeps one client of `@procedures/client` for each other copy. The worker gives the time limit and the stop as the signal of each call.
- The hash of the configuration is the SHA-256 of its canonical JSON (RFC 8785), with the scheme `alerts-config-hash/1` (`configHash` of the core). The order of the keys does not change it.
- The entry writes each problem of a page to its output. It writes a failure of the reads of a copy one time at its start, and one time at its end.

### The checks of the copies

- Each copy pings its own first check, with the URL of `pingKey`. Thus the owner gets a message when one copy stops.
- The copies share the loud check, and each copy pings it. Thus the outage call comes only when no copy pings it in its grace.
- A fail ping of one copy still makes the loud check go down. A fail comes from a channel that refuses, or from an overdue send of the joined ledger. Thus it tells of the whole system.

### The quotas and the caps

- The Pushover gate of each copy notes the count of the application from each answer of Pushover. The copies share the application, thus each gate is correct again at its next send.
- The cap of the Twilio spend counts each call of another copy at its import. A count above the cap sets the gate to the cap.
- Thus the copies keep one cap, apart from the calls that they make while they cannot reach each other.

### The host of a copy on Linux

- `install.ts` also installs the host on Linux: a systemd unit starts the supervisor at the boot, and again after a stop.
- systemd stops the supervisor with SIGTERM. The supervisor sends the message `shutdown` to the runtime, as on Windows.
- A cloud copy runs far from the places. Thus one storm or one power cut does not stop the two copies.

## The taxonomy

`TAXONOMY` of the core holds each kind code, its plain name and a summary of one sentence. A code is dotted, for example `met.flood.flash`.

- The first part is a category: the 12 categories of CAP 1.2, then `cyber`, `market`, `civic` and `system`. `categoryOf` gives it.
- The taxonomy is a tree. The parent of each code is also a code, and each category is a root. `parentKind` gives the parent.
- The taxonomy is closed. `knownKind` tells if a code is in it. The coverage codes `system.coverage.<code>` are a family of the core.
- A parent code is a group of its descendants. An adapter gives the leaf code of its event. A person, a rule or a class of the atlas can name a group.
- A code with a typo does not match the life-safety class, so it can stop a wake. Thus each adapter has a gate test, and each policy names only known codes.
- The schemas hold the same rule with `kindCodeSchema`. It covers the kinds of a source, a watch, a rule, a mute and the priors, and each `topic` id.
- The JSON Schema of a kind code is a plain string at this time. Only the parse checks the code against the taxonomy.
- A code does not leave the taxonomy by a plain removal. `taxonomy.lock.json` holds each code that the taxonomy has or had, and a test holds the lock.
- A removed code gets an entry in `KIND_ALIASES`, from the old code to its new code. The parse changes an old code to its new code before the check.
- The source atlas uses the codes as its signal classes. Its gate needs a class for each code outside `system` and `other`.
- A gap is a class with fewer than 2 adopted or planned sources with no risk. The gap count shows the research and the plans.
- The layers of the cover show the alerts that arrive. The next section tells the rule of the layers.
- The kinds go from physical events to technical outages. A new adapter adds its new codes to `TAXONOMY` in its pull request, with a class in the atlas.

## The cover rule

The owner of the project decided this rule on 2026-11-15. The target is the most redundancy at each layer, not the least that passes the gate.

- Independence is a measure of each layer. It is not a filter. A shared origin or path does not lower a plan and does not refuse a source.
- The cover of a class is a vector of layers, from the adopted sources with no risk:
  - `adopted` counts these sources.
  - `paths` counts the most of these sources with a known path and no shared part. A second path to the same origin counts in full at this layer.
  - `origins` counts the known origins of these sources that issue the class.
  - The distinct channels of delivery are a later layer.
- A parent class counts at each leaf code. A leaf code of a class is a code of the taxonomy under it with no code under it.
  - A source reaches a leaf code through the class, the leaf code or a code between them.
  - An origin counts at a leaf code when it issues the code or an ancestor of it.
  - Each layer and the gap count take the leaf code with the most. Thus two sources of two different children are not a pair.
- No layer replaces another one. Each round records two measures of each layer: the cover and the total.
- The cover of a layer counts the classes with 2 or more. The total is the sum over the classes, so it shows each gain above 2.
- The gate stops a change that makes the cover or the total of a layer fall below the measure of the latest round. A real loss needs a new round whose cause names the loss.

The origins and the paths are data:

- An origin is the body that issues a signal, for example the NWS. `origins.json` is the closed list of the origins.
- A path starts with the host that the adapter reads. Then come the CDNs, the carriers and the providers, for example `cdn:akamai` or `carrier:noaaport`. `paths.json` is the closed list of the parts.
- The id of each part that is not a host starts with its kind. The `dependsOn` of a descriptor uses the same ids. A test of the atlas checks that each adopted adapter names each CDN and carrier of its path.
- Each source names its origins and its path. The gate checks each id against its list, and each entry of a list has a source.
- An origin or a part that the research did not find has the id `unknown`. It is a gap of the research, not a gap of the cover.
- A layer does not count an unknown origin or a path with an unknown part. Each round records the two counts of unknowns (`unknownOrigins` and `unknownPaths`).

The claims of the pairs:

- A shared origin or a shared part of a path is a claim that two sources fail together. `pairClaims` gives the claim of each pair that reaches one leaf code of a class.
- A claim is data with its evidence, and it can be wrong. A later check compares each claim with the joint outages of the health log.
- Each source of a pair with a claim stays in each layer. The claim changes only the count of distinct paths or origins.

## The route and the delivery step

The core function `route` gives the escalations at a time. Each escalation is one incident, one level and one person.

- The levels of an incident and a person are the levels of its starts and its deliveries, and the assessed level.
- The assessed level counts only when it is higher than those levels and the person has a policy for it. So the level does not go down.
- Only the highest level continues. A lower level ends at the start of a higher level, so its repeats stop.
- An escalation continues until an acknowledgment, the end of the incident or the end of the person. An acknowledgment of a level also covers each lower level.
- The end of an incident is its expiry, or the time when it stops being live.
- The end of the person: a live incident no longer reaches the person (the assessed level is `none`). Each escalation of the person ends at that time, so its repeats stop. A lower level that still reaches the person does not end the escalation.

The start of an escalation is the time at which its level first applied. The runtime writes each start to its log. After a restart, each step comes at its time from the same start.

The runtime also writes each end of a person to its log (`EscalationEnd`). Each end closes an episode of the person in the incident:

- When the threat comes back to the person, a new episode starts. Its sends get new message keys, so a channel does not drop them as repeats.
- An item of the log belongs to the episode of its time. An acknowledgment before the start of a new episode does not cover it.
- An earlier episode continues only to cancel its deliveries with no cancel.

Each end has a reason (`EndReason`). The runtime sends no message for an end of either reason.

- `ended`: the threat left the person. An end with no reason is an end `ended`.
- `muted`: a mute of the person changed. The assessment gives the mute in its field `muted`.
- A mute with the effect `absent` gives the level `none`, thus the escalation of the person ends.
- A mute with the effect `silent` keeps the level and puts the episode in the silent mode. The start of a silent episode has `silent: true`.
- A change between loud and silent ends the episode at once. The next episode starts in the new mode in the same pass.
- A silent episode sends one quiet message at most. It sends its step 0 only when the person has no delivery of the incident. It does not exhaust.
- An acknowledgment before an end `muted` still covers the next episode. Thus a change of a mute does not alert the person again.

The runtime does one delivery step in each pass, after the system reports:

1. It polls each open receipt of a channel with the acknowledgment `poll`, one time in each interval. A receipt that the person acknowledged gives an acknowledgment.
2. It writes the start of each new escalation and the end of each person that the incident no longer reaches.
3. It sends each step that is due, and it cancels the repeats of each escalation that is over.
4. It writes the result of each call to the log at once, after the call.

Each call of a channel has a time limit. A failed call writes nothing, so the next step decides it again. Before it goes again, a call waits for the time that the channel tells, or for the retry time of the configuration.

A send that passes its time limit stays in flight, because the provider can accept it later:

- No second send of its key starts until the first send ends, or until the flight limit `flightLimit` ends. The flight limit is not shorter than the time limit.
- A late send that the provider accepts gets its delivery in the log at the next step. Thus its acknowledgment and its cancel work.
- After the flight limit, a second send goes. On a channel that repeats, a late first send that lands after it gets no delivery in the log, and its stop goes again. On a channel that does not repeat, it gets its delivery when the log has no delivery of the key. Else the step lists its key in `duplicates`.
- A send that the channel accepts in time, and whose write to the log fails, also gets its delivery at the next step. Thus no second send goes.

Each send of a key has a new copy id: the run id, `-` and a count. It has only letters, digits, `_` and `-` (`COPY_ID`), because a stop puts it in the path of a URL. The channel can have a copy that the log does not keep:

- A copy past its flight limit.
- A copy whose send failed with no answer: a time-out, a network failure or a server failure.
- A copy of a key that the log already has, with another receipt.

On a channel that repeats, the step stops such a copy by its copy id. The next copy goes in parallel. The step does not cancel by the delivery key here, because that cancel also stops the next copy. A failed stop goes again at a later step. A stale copy that the channel accepts later gets its stop again.

Each failed send with no answer adds a copy. Thus an outage of the channel adds a copy at each retry. The stops of a channel that is down do not grow with the copies:

- A step with a failed stop on a channel marks the channel as down. A step whose stops on the channel all end well marks it as up.
- On a channel that is down, each step sends only the first ready stop: the probe. The other stops wait. Thus an outage costs one stop at each retry.
- A failed stop goes to the end of the order. Thus the next probe is another copy, and one bad copy does not hold the others.
- After a good probe, the other stops go at the next step. The step wakes the loop, and the next step comes within one retry.
- The wait before the next probe starts at the retry. It doubles after each failed probe, up to `probeLimit` (60 seconds by default).
- A good answer of a down channel to a send, a poll or a cancel moves its next probe to the next step. Thus the stops go soon after an outage.
- A channel with `maxInFlight` in its descriptor gets no more calls in progress at the same time. Pushover sets 2, from the rules of its API.
- A call that has no free place waits for a later step. The end of a call wakes the loop.
- A call keeps its place until it ends or its flight limit passes. Thus a hung call does not hold its place for all time.

The Pushover channel tags each emergency message with its delivery key and its copy id. A cancel of a receipt goes by the delivery key. Thus it also stops the repeats of a copy whose receipt the log does not have. A crash after a send and before its write is such a case. A stop of one copy goes by its copy id.

The log keeps each copy on a channel that repeats, and its end. Thus a restart does not lose the stop of a hung copy (AL-32):

- Before each send on a channel that repeats, the step writes an `attempt` event with the delivery key, the channel and the copy id.
- The `delivery` event of an accepted send has the copy id. It ends the copy.
- A `refused` event ends the copy of a send that the channel refused in its time limit.
- A `settled` event ends a copy that needs no stop. Either the channel refused its send after its time limit, or a stop of the copy went after the end of its send.
- The state has the open copies: each try with no end. The first step after a restart stops each of them by its copy id.
- A stop of a copy whose send did not end does not end the copy. The channel can accept that copy later, and then its stop goes again.

A write of the `attempt` event that fails throws, and the send does not go.

The log also keeps each refused send. A refused send is a refusal, a bad key, a full quota or a quota in its reserve, in the time limit of the send:

- The `refused` event has the delivery key, the channel, the kind and the retry time.
- The state keeps the last refusal of each key. A delivery of the key removes it.
- A start of a run and a refusal drop each refusal whose retry is at or before their time. Thus the state keeps only the refusals that wait.
- A step writes its refusals after all of its deliveries. Each refusal keeps the count of the deliveries of its channel before it.
- After a restart, the first step keeps the wait of each refusal. Thus the quota of a channel holds across a restart.
- The heartbeat reads the refusals of the state at the start. Thus a restart does not end the fail of a refused channel.

A channel rule (`ChannelRule`) of a person keeps or removes the steps of a plan for some incidents (AL-43). The function `ruleSteps` applies the rules in `route`:

- A rule has kinds (prefixes of the taxonomy), an optional subject and channels. With `only`, only the steps on the channels stay. With `except`, those steps go.
- A rule applies only to an incident with the status `system`, `test` or `exercise` (`RULED_STATUSES`). No rule changes the plan of a real warning.
- When two rules apply, a step stays only when each rule keeps it. Thus the order of the rules has no effect.
- The route keeps the indexes of the rules that apply and of the removed steps in `Route.ruled`. A route with no rule that applies has no field `ruled`.
- The indexes are of the configuration of the pass. A reload that changes the path of a drill during a run gives other indexes for the same run.
- The rules do not change the why record of the route.
- A plan with no step sends nothing. `escalate` gives it the state `exhausted` at its end.

A recipient has no problem from `recipientProblems` before it gets alerts:

- A person who watches a place or a subject has a policy of the level `life-safety`.
- No rule keeps a life-safety kind, or the coverage of one, below `life-safety`. A rule with no kinds applies to each kind.
- Each rule names kinds of the taxonomy, and the quiet window has a good time zone and good local times.
- Each channel rule has one or more kinds of the taxonomy, and each of its channels is a channel of the instance.

The message of a send takes its text from one report of the incident. That report is the latest one with the severity and the urgency of the incident. The body has the instruction first, then the area and the description. The channel cuts the text to its limits.

One part waits:

- The exhaustion alert to the next person waits for a second person (AL-21). Until then, the repeats continue after the exhaustion, and the routes of each pass show it.
- When the exhaustion alert comes (AL-21), it skips a plan with no step, because a channel rule empties such a plan on purpose. A test of AL-21 holds this rule.

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
- The kind is in the life-safety class.
- An area of the incident contains a watched place.
- The severity is `severe`, `extreme` or `unknown`.
- The urgency is `immediate`, `expected` or `unknown`.

A kind is in the life-safety class when its warning tells the people at a place to act at once to save their lives. They take shelter, leave, or go to high ground. The class holds tornado, flash flood, extreme wind, hurricane, typhoon, storm surge, fire, tsunami, earthquake early warning, debris flow and volcanic eruption. It also holds the national emergency (EAN), evacuation, shelter in place, civil danger, civil emergency, and chemical, biological, radiological and nuclear hazards. For these kinds, an unknown value counts as high, because a miss costs more than a false alarm. A tornado watch has the urgency `future`, so it is `urgent`: a push at once that does not wake the person.

Some dangerous kinds are not in the class. Their danger comes over hours, or it is on the road or at sea. These kinds reach `urgent` at most:

- extreme heat, extreme cold, a coastal flood, a river flood, a winter storm and a blizzard.
- a dust storm and a snow squall, which are dangers to drivers.
- the marine kinds, and ashfall. The ashfall codes are children of `geo.volcano`, not of the eruption.

A severe thunderstorm with the destructive damage threat is also not in the class. The damage threat tags of the NWS and the Wireless Emergency Alert handling of the issuer are inputs of AL-31.

An earthquake has its own class. Its report tells of shaking that occurred, so its urgency is `past`. The table of the class has a window (`pastWithin`) of one hour. In that window after the onset, `past` counts as `immediate`. The reason `table` then has `recentPast`. With no onset or no time, the age is unknown, and `past` counts as `immediate`.

So an earthquake is `life-safety` when its status is `actual` and its severity is `extreme` (MMI VIII or more) or `unknown`. Its urgency must be `immediate`, `expected` or `unknown`, or `past` in the window. The severity `severe` (MMI VII) gives `urgent`. After the window, a report is a `digest`. `LIFE_SAFETY_KINDS` has the codes of both classes, because each of them can reach `life-safety`.

Each lookup only grows with the severity and with the urgency. So a more severe or more urgent incident does not get a lower level. Tests hold this order and the rule above for each value.

The level for a person is the highest level at the places of the person. A rule of the person can lower the level of some kinds at some places. For example, warnings at the places of other people can come as `urgent`. At each place, the first rule that matches applies, and a rule does not raise the level.

An incident can have lines (`Incident.lines`): one for each report that gives its values, with the areas of that report. The merge gives the lines only when their values differ. Then the table level at a place comes from the lines whose areas hold the place. It is the highest level of those lines.

For example, an earthquake has one line for each band of its shaking. A place in the outer band gets the level of that band, not the level of the center. The reason `place-table` tells the reports of the lines at the place. A rule of the person then applies to that level. A seeded gate holds the rule: the level of an incident is the highest level of each of its lines alone.

The assessment reads no clock. The caller gives the time `at`, and only a window `pastWithin` reads it. The escalation reads `now`, so it holds the night rule:

- Each person can have a quiet window (`PersonWatch.quiet`): a time zone, and a start and an end in local times, for example `22:00` to `07:00`. An equal start and end give the full day.
- In the window, each send below `life-safety` is quiet. A `life-safety` send ignores the window. It wakes the person.
- The quiet value is for the time of the send. A step that became due before the end of the window and goes out after it is not quiet.
- `inQuietWindow` is `inWindow` of `@mark1russell7/algebra/clock`. It calculates the local time in the time zone of the window. Thus the window follows the change to and from daylight saving time.
- Tests hold a window across midnight, the two days of the change, an hour that occurs two times and an hour that does not occur.
- A bad window gives no quiet send. A message that is too loud is not a miss. `quietWindowProblems` finds the bad window.
- The system does not use the Quiet Hours of Pushover. The core holds the one rule, so each channel follows the same rule.

Each assessment has its reasons: the gate that stopped it, the class, the two lookups, the places and the rules. The UI shows them.

The table becomes the calculation of AL-31. The calculation multiplies the probability that the event is real and the harm of the event. It compares the result with the cost to interrupt the person at that time. Each factor comes from a public measure, not from a value that a person sets.

The shadow score (`shadowScore`) is the first step. It operates next to the table, and it does not decide a level:

- The priors (`ScorePriors`, format `alerts-priors/1`) are data. For each prefix of a kind, they give the verified share of its warnings and the deaths and injuries of one event. For each CAP certainty value, they give a probability.
- The probability of an observed event is that of the certainty `observed`. The probability of a warning is the verified share of its kind. The measure of the warnings decides over the certainty word of the sender. Each other incident gets the probability of its certainty.
- For each field, the longest prefix of the kind with that field decides. A prefix ends at a dot, as in `hasKind`.
- Each value has its interval. The score keeps the key of the priors that gave each factor, so the UI tells the source.
- The expected harm (`expectedOf`) is the probability times the deaths, and the probability times the injuries. `mul` of `@mark1russell7/interval` rounds each interval outward. Thus the interval holds each exact product.
- Each count of the priors is from 0 to `Number.MAX_SAFE_INTEGER`. Thus each product has a finite interval.
- A factor that the priors do not give makes a score with no read. The score names each missing factor. It does not take 0 or a default value.
- `assessWithShadow` adds the score as the last reason of an assessment with a reason of the table. The level and the other reasons stay those of `assess`. A seeded gate test holds this.

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
- The API on the loopback address gives `GET /status`: the time, the wake time, the sources, the sends and the conflicts of the last pass. It also gives the reason when the loop is stuck, and the files of the start. The probes have a port of their own.
- The API also gives `GET /map`, the `MapPayload` of the last pass. The section "The map" tells its parts.
- The API also gives `GET /health`, the `HealthPayload` of each part of the system. The section "The health route" tells its parts.

The function `openInstance` makes the instance of the owner from the private configuration:

- The sources are the NWS API and IPAWS. The channels are Pushover, and the Twilio call channel when `secrets.env` has its keys.
- The keys of Twilio are `TWILIO_ACCOUNT_SID`, `TWILIO_API_KEY_SID`, `TWILIO_API_KEY_SECRET` and `TWILIO_FROM`. An API key signs each request.
- A spend entry of a provider of a channel gives the cap of the channel. The count of the cap is in `quotas.sqlite`.
- The spend entry of Twilio also gives the watch of the balance: one read each day, and its floor.
- Each source gets the watch of `sourcePlaces`. Thus a source gets the region codes, and a position only when the place shares it with that source.
- The User-Agent of each request names the project and its page. It names no person.
- The times of the delivery come from facts of the channel. A call has a limit of 10 seconds. The poll goes at the pace of the emergency repeats, 30 seconds.
- A failed call goes again after one time limit of a call. The flight limit is two time limits.
- The limits of the lateness use the quantile 0.99, at the level 0.95.

The instance does not start when it finds one of these problems:

- a missing secret, or an API token that does not have the form of a Pushover key (30 letters and digits)
- each problem of `parseConfig`: the JSON, the schema, the references and the fields of each address on its channel
- some keys of Twilio and not all, or a key of Twilio with a bad form
- a step of a policy on a channel that the instance has no sender for. Without the keys of Twilio, the call channel has no sender.
- a step on a channel with a cost, when the configuration has no spend entry for a provider of the channel
- a place that no regional source covers. Usually the place does not have a code of each level: the zone, the county, SAME, the state and the country. A source with the coverage `global`, for example the SWPC, covers each place with no code. Thus the check does not count it.

The environment gives `PORT` (8080), `PROBE_PORT` (9090) and `SERVICE_PROFILE` (`local`, `daemon` or `pod`). The folder `ALERTS_HOME` (`.alerts` in the home folder) holds the private files: `config.json`, `secrets.env`, the log `runtime.sqlite` and the outlines of the zones `shapes.sqlite`. It also holds the counts of the quotas, `quotas.sqlite`. No repository holds them. A problem of `secrets.env` names its line and its key, and no value. The output of a failed pass shows no value of `secrets.env`.

After each pass, the runtime gets the outlines of the zones of the watched states. It stops before the next fetch of the alerts. A broken file of outlines goes into quarantine, and the runtime gets the outlines again.

### Steps of the wall clock

A step changes the wall clock and not the monotonic clock, for example a correction of the system time. A change of `CLOCK_STEP_ABOVE` (2 seconds) or less is a drift, not a step. The instance gives a frame clock to the runtime, the loop and the channels. The clock is `frameClock` of `@mark1russell7/algebra/clock`, with the drift limit `CLOCK_STEP_ABOVE`:

- In a frame, the time is the wall time at the mark plus the monotonic time since the mark. Thus the time does not go back in a pass.
- At the start of each pass, the runtime reads the step since the last mark. Then it marks a new frame.
- The runtime writes each step to the log as the event `clock`, with its size. The fold of the event moves each own instant of the state by the size.
- Then the delivery step and each balance watch move their times in memory by the same size. `Pass.stepped` gives the size to the hooks, and the heartbeat moves its times.
- The mark comes after the write. Thus a failed write leaves the step to the next pass, with the same id `clock:<n>`.
- After the step `n`, each id from a time gets the tag `~<n>`: the fetches, the ends of a list and the refused sends. Thus a repeated time gives a new event.
- The rebuild of the log moves the parts of the merge before each clock event. Thus the rebuild equals the fold.

The own instants move. They are the times of the runtime:

- the receipt time of each report, and each time of a system report
- the fetches, the health, the deliveries and the end marks
- the escalations and the refusals

The instants of others do not move. They come from the clocks of the sources and the channels:

- the times of a report of a source: `sent`, `effective`, `onset`, `expires` and `ends`
- `asOf` of an end mark
- the time of an acknowledgment
- each instant of an event that another copy wrote

### The check of the log at the boot

At the boot, the instance opens the log with `openCheckedRuntimeLog`. A broken log file does not stop the runtime:

1. The function checks the file with `PRAGMA quick_check`. A new file and a log in memory get no check.
2. The check or the open finds a broken file. Then the salvage copies each event that it can read into a temporary file, in the order of the log.
3. The broken file goes into the quarantine folder `runtime.sqlite.broken-<time>` next to the log. Its companion files go with it. The time is the boot time in UTC, for example `20261116T120500Z`. Then the temporary file takes the path.
4. Then the runtime appends one event `recovered` for each quarantine folder, with the id `recovered:<folder>`. The event has the kind of the fault, the counts of the salvage, the flag `whole` and the first 10 problems.
5. The fold of the event adds a recovery to the state, and the view gives the log report of it. A later step of the wall clock moves the time of the recovery.

The flag `whole` is true only when the salvage read each part of the file with no problem and lost no position. A file that is not a database gives no lost positions, but `whole` is false.

A fault that is not a broken file goes to the caller, for example a lock or a folder at the path. Then nothing moves, and the boot fails. Fault case 12 of the testkit tests this boot. It becomes a gate when the testkit opens the log with `openCheckedRuntimeLog`.

The quarantine folder stays. Examine the disk of the computer, and keep the folder until you know the cause.

The steps 1 to 3 are `openCheckedEventLog` of `@mark1russell7/sqlite`. A record in the quarantine folder keeps the cause and the counts. A crash in a step leaves the record or the broken file, and the next boot completes the steps.

The runtime appends the events of step 4 at each boot, from `listRecoveries` of the home. An event that the log has changes nothing. Thus a crash before the append loses no report.

A WAL, SHM or journal file with no database file also goes into a quarantine folder. Its event has the fault `orphan-journal`. A quarantine folder with no record gives the fault `no-read`.

### The host on one computer

The module `host.ts` gives the host of the live instance as data. A boot task starts a supervisor, and the supervisor starts the runtime:

- `node src/install.ts install` installs the boot task, and starts it. A boot task needs an elevated shell one time. `remove` stops the supervisor and removes the task. `status` gives the state of the task, the result of one readiness probe and the times of the outside check. It exits with 1 when the runtime is not ready or the check is too short.
- After each install, and after each change of `config.json` or `secrets.env`, start `status` when the ready wait passed. A runtime that is not ready sends no alert, and only its log tells it.
- The boot task starts the supervisor at the start of the computer, before a logon. It starts the supervisor again 1 minute after a stop.
- The supervisor starts the runtime with the profile `daemon` on the ports 4750 and 4751. The runtime is ready when `/readiness` passes, in its startup budget plus one readiness interval.
- The supervisor uses `/liveness` each 10 seconds. After 3 failures in sequence, it stops the runtime and starts it again. A stuck loop fails the liveness.
- A stop goes as the message `shutdown` on the IPC channel, because a Windows process cannot catch a signal of its parent. Then the runtime drains its pass.
- The stop grace is the sum of the caps of the phases of the runtime, plus 2 seconds. After the grace, the supervisor stops the process tree. The supervisor holds the grace in its phase `tear down dependencies`.
- The host keeps its files in the folder `host` of `ALERTS_HOME`: the task file, the locks, the discovery files and the logs of the runtime.

A lock keeps one runtime on the computer. The live instance runs from a checkout of its own, not from a working copy. Thus a change of branch does not change the code that runs.

### The outside heartbeat

The runtime cannot tell the person that it stopped. A check of Healthchecks.io tells it. The module `heartbeat.ts` gives the hook `onPass` of the runtime:

- After each pass with no error, the hook pings the check. A ping of the same kind goes once in each 60 seconds. When the pings stop, Healthchecks.io alerts the owner: the process stopped, the computer stopped, or its network is down.
- A pass in which a channel gave `auth`, `refused` or `rate-limited` to a send pings `/fail`, because then the system cannot tell the person.
- A pass with an overdue send pings `/fail`, whatever the kind of its failures. An overdue send is due, and it has no delivery `overdueAfter` after its due time. A reset or a server error that lasts thus also pings `/fail`.
- `overdueLimit` gives `overdueAfter`: one pass limit and two full tries, each to its flight limit and its retry. It is 140 seconds for the instance. The due time comes from the log, thus a restart keeps it.
- A send that a channel gave `reserved` does not ping `/fail`, and it is not overdue. The channel keeps the last units of its quota for `life-safety`, thus it still tells the person of the highest level.
- The body of each ping also gives the state of the quota of each channel with a quota.
- The fail of a channel holds until a send on the channel goes, or until the pass of the retry has no refusal on it. The delivery step sends a failed call again at the first pass at or after its `retryAt`. Thus the check does not go down and up at each retry.
- The fail of a channel holds across a restart. At its first pass, the hook starts from `heldOf` of the log. It gives each refusal with a retry after that pass and with no later delivery on its channel. The order of the log decides, not the times. Thus a restart does not ping `success` while the channel refuses.
- The body of a success ping gives the state of each source. The body of a fail ping gives the channel and the kind, or the count of the overdue sends and the age of the oldest. No body holds a place, a person or the text of a failure.
- The hook starts the ping and ends at once. One ping is in flight at a time, for 10 seconds or less. A failed ping goes to the log, and its text holds no ping URL. The next pass pings again.
- The key `HEALTHCHECKS_PING_URL` of `secrets.env` gives the ping URL, with `https`. The profile `daemon` does not start without it.
- The optional key `HEALTHCHECKS_LOUD_PING_URL` gives a second check: the loud check. Its integration makes a phone call to the person, and it shares no channel with the instance.
- The heartbeat sends each ping to the two checks, with one hook for each check. A slow ping to one check does not hold the other. Without the key, nothing changes.
- The loud check has a longer grace than the first check. Thus a short stop, for example a reboot, does not make a phone call.
- `install.ts status` also reads the loud check, when `secrets.env` has its key.
- `heartbeatGap` gives the longest time between two success pings. It adds the period of the pings, two pass limits, the longest wait of the loop and the ping limit. Each failed pass adds a pass limit and a wait. The check lets one failed pass go.
- The period plus the grace of the check must be this gap or more: 430 seconds for the instance. `install.ts status` reads the check with `HEALTHCHECKS_API_KEY`, and fails when it is shorter.
- A new check alerts only after its first ping. Thus the first install checks that the check is up.

### The chain of tries

The outage call starts when the instance is down. So the escalation of the runtime cannot start it, and no timer of the instance operates. The module `chain.ts` gives the escalation of one person with no timer: the end of each try starts the next try.

- A `TryChain` is the channel of each try, in order. Each person gets a chain, for example two calls and then a text message.
- The end of a try is `acked`, `unconfirmed`, `failed` or `sent`. A call is `acked` only after a key press, so a voicemail is `unconfirmed`.
- `chainNext(chain, step, end)` gives the next state: the next try, `acked` or `exhausted`. A step that the chain does not have gives `exhausted`, so an old or false step starts no try.
- Thus a function with no state can operate the chain. The callback of each try carries its step, and the next callback gives the step and the end.
- `chainRun` is the fold of `chainNext` over the ends of the tries. A chain makes at most one try for each step. Its transitions replay against `CHAIN_MACHINE`. A gate of `chain.test.ts` holds the two rules.
- `outageAudit(outages, chains, records, within)` compares each outage with the records of the tries of the provider. The tries of an outage start in the time `within` after its down time, and before the next down time.
- Each person of each outage gets `acked`, `exhausted`, `open` or `untried`. `untried` shows a webhook or a start that failed. Each reach that is not `acked` is a fault of the outage call.

The package `@mark1russell7/alerts-channel-twilio` operates the chain on the server of Twilio, in three Functions. Its module `outage.ts` has a pure handler for each Function.

- `outageStart` gets the webhook of the outside check. It starts the first call of each person.
- `outagePress` gets the key of the person. A 1 moves the status callback of the live call to a URL with `acked=1`.
- `outageEnded` gets the status callback at the end of each call. It gives the next call by `chainNext`.
- A chain that ends with no key press sends one SMS message to the person, when the list has `textMessage` (AL-56). A chain with a key press sends no text.
- The URL of each callback holds the outage, the person, the step and the version of the list. A callback of another version starts no call.
- Twilio signs each request to the press and end Functions. Thus a person outside Twilio cannot make a step. The entry is public, and it checks its own token.
- A cap counts the calls of the Twilio number in a time window. A try above the cap makes no call.
- A monthly cap counts the calls of the number from the start of the calendar month. The month starts in the time zone of the spend entry of Twilio.
- The monthly cap is the spend cap of Twilio in whole calls of 4 cents, at most 1000. Each call of the number counts, also a call of the instance.
- Each cap counts a text as one call. The recent sends are the calls of `OUTAGE_FROM` and the texts of `OUTAGE_TEXT_FROM`.
- The SMS message has at most `OUTAGE_TEXT_LIMIT` (160) code points. That is at most 3 segments of 1.4 cents, so a text costs no more than a call.
- A failed read of the recent texts goes to the log, with no number. Then the caps count the calls only.
- The setup of the runtime refuses an outage call with no spend entry for Twilio. Each problem of the monthly cap names no count, because the spend cap is private.
- A gap stays open: the spend gate of the instance does not count the calls of the Functions. Thus one month can have more calls than the cap, by the calls of the Functions.
- The end of the gap is AL-57. The gate also reads the usage records of Twilio for the local month, in whole UTC days. It uses the larger of that amount and its own count, by the rule of `@mark1russell7/stack-spend`.
- If the move of the status callback fails, the end has no `acked=1`. Then the chain calls again. That is the safe side.
- Each handler gives the script of the call as data. The Function renders it with the TwiML builders of `@procedures/notify/twilio`.
- `outageListOf` makes the list from the field `outage` of the private configuration and the recipients of `loadConfig`. The number of each person is the contact of the person on `twilio-call`.
- The version of the list is the start of its content hash. Thus each change of the list stops the chains of the old list.
- `outageListProblems` checks the list that the deploy copies from the private configuration. Each problem names no phone number.
- A gate of `outage.test.ts` follows each sequence of call outcomes through the three handlers. The calls of a person stop at the first key press, and each step makes one call.

#### The deploy of the outage call

The module `deploy.ts` of the package puts the three Functions and the list on one service of Twilio Serverless. `twilioServerlessDeploy` of `@procedures/notify/twilio-serverless` sends the requests.

- `outageDeployPlan` gives the plan: the bundles of the Functions, the list as a private asset, the build, and the variables `OUTAGE_TOKEN` and `OUTAGE_FROM`.
- A plan with a sender of texts also sets the variable `OUTAGE_TEXT_FROM`.
- The version of the plan is the start of the content hash of the files and of the build. A second deploy of the same plan reads three lists and changes nothing.
- The variables are not in the version. A new token or a new number changes only the variables.
- `deployOutage` makes the bundles with esbuild, and then it deploys the plan. It loads esbuild only when it deploys.
- esbuild works in the folder of the package. Thus the start folder of the process does not change the bundles or the version (AL-44).
- `outageEntryUrl` gives the address of the entry. The webhook of the outside check calls it with the parameter `token`.

The runtime operates the deploy in the worker `outage` of its service (`outage.ts`), beside the worker `passes`.

- `outageSetup` reads the field `outage`, the keys of Twilio and the key `OUTAGE_TOKEN`. A missing key, a token of a bad form or a bad list stops the start.
- The key `TWILIO_TEXT_FROM` holds the registered sender of texts: a phone of a 10DLC campaign or a verified toll-free phone.
- With the key, the list has the text `OUTAGE_TEXT_MESSAGE`, and the deploy gives the number to the Functions. Without the key, the outage call sends no text.
- A value of the key that is not in E.164 form stops the start.
- The worker deploys after the startup. A change of the private files restarts the runtime, so a new list deploys at once.
- Once in each day, the worker deploys again. Thus a change on the side of Twilio heals in a day.
- A failed deploy goes again after a backoff: one minute, then double, up to one hour. The pass limit bounds one deploy, so the drain of the service holds it.
- `GET /status` gives the state of the last deploy: `pending`, `current` or `failed`, with its stage and its count of failures. The state holds no private value.

### Drills

The fakes and the fault cases of CI test the code. Only a drill tests the live path: the provider, the phone and the person (AL-43). The module `drill.ts` of the core gives the drills as data and as pure functions. The functions read no clock.

- A drill (`DrillConfig`) has an id, a person and a path. It also has the least time `every` between two starts, a window of the starts and the time `ackWithin` of the acknowledgment.
- The path is one channel of the life-safety policy of the person. A drill goes as a system report of the level `life-safety`.
- The subject of the report is `alerts.drill` (`DRILL_SUBJECT`), with the id of the drill. Only a person who watches it gets the drill.
- Thus a drill uses the route, the receipts and the escalation of a real warning. Only an acknowledgment on the channel of the path counts.
- The window is a `TimeWindow` of `@mark1russell7/algebra/clock`, with the days of the week. A drill on one day of each week has `every` of 6 days and a window on that day.
- `copies` gives the copies that start the drill. Without it, only the copy of rank 0 starts it (`drillInCopy`). Thus two copies do not send one drill at once.
- A run (`DrillRun`) is a start, with the first acknowledgment of a delivery on the channel of the path. The log of each copy holds the runs.
- `joinRuns` joins two runs of one start: the earlier acknowledgment counts. The join is idempotent, commutative and associative.
- `nextDrillAt` gives the next start: in the window, and `every` or more after the last start. A timer waits for it.
- The time of the acknowledgment from the start ends before the next quiet window of the person. Thus a drill does not wake the person at night.
- `drillVerdict` gives `pending` until the end of the time of the acknowledgment. Then it gives `passed`, or `failed` with `no-ack` or `late-ack`. A failed send gives no acknowledgment, thus it fails as `no-ack`.
- `drillProblems` finds bad times, a bad window, an unknown channel and a channel with no acknowledgment. Such a drill cannot pass.
- `drillProblems` also finds a drill with no start: its full window is in the quiet window of the person, or too near to it.
- The search for a start runs in January and in July (`DRILL_PROBES`). Two windows in two zones move by an hour at a change of an offset.
- `drillProblems` also finds an empty list of copies and a copy that the list names two times. Such a drill starts in no copy, or the list has a typo.

`loadConfig` gives the channel rules of each drill (`drillRules`, the section The route and the delivery step):

- The person of the drill gets two rules. A run goes only on the channel of the path. A failure goes on each other channel, because the path can be the broken part.
- Each other person who watches the drill gets a rule that removes each step of a run. That person still gets the failure.
- `loadConfig` checks the plans of the person of each drill with the code of the runtime. The system fold makes the reports of a drill and of its failure at the first start in `DRILL_PROBES`.
- The assessment gives the levels of the run and of the failure, and the rules keep the steps.
- A plan with no policy of its level, or with no step after the rules, is a problem. Such a drill sends nothing.

The system fold gives the drill lines (the section of the system reports). The module `drills.ts` of the runtime starts the drills of its copy:

- `copyDrills` gives the drills that the copy starts, each with the quiet window of its person. The instance gives them to `openRuntime`.
- Each pass appends an event `drill` for each due drill before its view. The id has the copy, the drill and the start.
- The fold keeps the last start of each drill. A restart reads it from the log, thus a drill does not start again in its window.
- `drillRunOf` gives the last run, with the first acknowledgment of the person on the path, of a run report after the start.
- An acknowledgment in the user interface or on another channel does not test the path, thus it does not count.
- `drillStep` gives the snapshots of the view and the next wake: the next start, or the end of the time of the acknowledgment.
- A drill with no next start gets `noStart`, and the system fold opens its line `no-start`.
- A drill whose last window ended with no run gets `missed`. A copy that stops for the full window sends this failure at its next pass.
- A stopped copy cannot send. The outage call tells of a stopped copy, and `missed` tells later that the drill did not test the path.
- The event `drill` stays in its copy, because each copy has its own drill lines.

The next steps are these:

- The map and the explanation of a route show the steps that the channel rules remove (`Route.ruled`).
- Then comes a drill of the outage call.

## People and places

The contracts carry only ids: `PersonId` and `PlaceId`. The runtime gets people, places, addresses and the night rule of each person from the private configuration.

### The private configuration

The core gives the format of the private configuration, `AlertConfig` (`alerts-config/1`). The repository holds no configuration. Each copy of the system loads the same configuration.

- `places`: the id, a label, a position, the region codes and the buffer of each place. The field `sharePosition` names the sources that get the position.
- `people`: the `PersonWatch` of each person, a label, and the escalation policies of the person.
- `contacts`: the address of a person on a channel. A value of an address is a text, or a reference `{ secret: "NAME" }` to a key of the secret store.
- `policies`: the escalation policies of each person with no policies of their own.
- `spend`: the money rules of each paid provider account. An entry has the monthly cap and its reserve in US dollars, the floor of the balance and the time zone of the month.
- `link`: the policy of the link rule of the merge (rule 3). Without it, the instance uses `DEFAULT_LINK_POLICY`.
- `outage`: the people of the outage call, each with a `TryChain`. Without it, an outage of the instance calls no person.
- `assess`: the policy of the assessment, `AssessPolicy`. It replaces the full default policy of the core. With no field, the default policy applies.
- `drills`: the drills of the live paths (the section Drills). Without them, the instance starts no drill.

The times of the delivery and the rank of a copy are not in `AlertConfig`. They are settings of each copy.

The schema `alertConfigSchema` checks the JSON of the configuration first. Then the function `loadConfig` checks the references and makes the recipient of each person. The caller gives the secret store, so the core reads no file. The runtime does not start when the load gives a problem. The load finds:

- two places or two people with one id, and a place with no region code
- a place of a person or of a rule that the configuration or the person does not have
- a contact of an unknown person, two contacts of a person on one channel, and a secret with no value
- two spend entries of one provider, and a provider that no channel depends on
- a reserve of a spend entry that is not below its cap, and a time zone that is not an IANA name
- an unknown person of the outage call, and a person two times in the call
- a chain of the call with no step, and a step on a channel with no contact of the person
- two drills with one id, a drill of an unknown person, and a drill on a channel with no contact of the person
- a drill of a person who does not watch `alerts.drill`
- a drill whose run or failure sends nothing to its person: no policy of its level, or no step after the rules
- each problem of `drillProblems`
- an interest graph of another person, and a place of the graph that the person does not watch
- a rule of the life-safety warnings at a place that the person does not watch, and rules with no interest graph
- each problem of `recipientProblems`

A problem names ids, fields and the names of secrets. It does not hold the value of a secret, a label or a position.

The function `parseConfig` reads the JSON text of the configuration. It checks the JSON, then the schema, then the references. Its result is a `Result` of `@mark1russell7/optional`: the configuration and the recipients, or the problems. The runtime starts only with an `ok` result. A problem of the JSON does not quote the text, because the text can hold a private value.

#### The parts of the configuration

Two writers of one file overwrite each other. Thus each writer of places, people and contacts can keep its own part, `ConfigPart` (`alerts-config-part/1`). A part has only the fields `places`, `people` and `contacts`. The root configuration keeps the other fields.

- The name of a part has small letters, digits and hyphens, with a letter first. It has 40 characters or fewer.
- The function `mergeParts` puts the entries of the root first. The entries of the parts come after them, in the order of the names.
- Thus the order of the reads does not change the merge or its hash. Each copy gets the same hash from the same files.
- The merge finds a bad name and two parts with one name. It also finds an entry in two files: a place, a person, or a contact of a person on one channel.
- A problem of a bad name gives the index of the part, not the name, because the name can hold any text.

`parseConfig` takes the texts of the parts as its fourth argument. It checks the JSON and the schema of the root and of each part, and gives all their problems together. Then it merges the parts and checks the references of the merge with `loadConfig`. A problem of a part starts with the name of the part. With no parts, the result is the same as before.

The runtime reads two private files in the folder `ALERTS_HOME`, or in `~/.alerts` with no variable: the configuration `config.json` and the keys `secrets.env`. A procedure that gives the configuration replaces the file later.

The function `checkTexts` checks the texts of the two files, as the start does. It reads no file. The keys go through `parseEnvFile` of `@mark1russell7/service/host`, and `envSecrets` gives them as the secret store. The keys do not go into `process.env`, because each child process gets that environment. A read error gives only its code, because the path can hold a user name.

The start keeps the last good set of the private files, and a change of the files restarts the runtime (`reload.ts`). The private files of a start are `config.json`, `secrets.env` and `copy.json`.

- When the three files pass the check, the start uses them. A ready runtime writes them as the last good set `start.good.json`. The write is atomic, with the permissions 0600, because the set holds the keys.
- The last good set is a second copy of `secrets.env`. On Windows, the permissions do nothing, and the file gets the access list of the folder, as `secrets.env` does.
- After a change of a key, the old key stays in the set until the next ready start. A start on the set uses the old keys.
- The runtime is ready when its service operates and one pass ended. Thus a start that throws, or a startup that fails, does not write the set.
- When the files have problems, the start uses the last good set and gives the problems. Thus a bad edit does not stop the alerts.
- Before a start uses the files, it writes the start marker `start.pending`. The marker holds the key of the start: the SHA-256 of the three texts and of the restart request. A ready runtime removes the marker.
- The marker counts the starts with its key that stopped before they were ready. One stop, for example a reboot or a power loss in the first pass, gives a second try of the files, with a note.
- After `STOP_LIMIT` (2) stops in a row with one key, the start uses the last good set, and it keeps the marker. Thus each later start with the same files uses the set at once, and a crash loop stops.
- A new restart request or a change of a file gives a new key. Then the next start uses the private files again.
- When the last good set has the same texts as the files, the start uses the files again. Its note tells that the fault is not in the private files, for example new code that stops at each start.
- When the files and the last good set both have problems, `startConfig` throws `ConfigRefused`, and the process does not start.
- The marker does not find a stop after the runtime is ready. A runtime that stops later gives no way back to an older set.
- `GET /status` gives the files of the start: `start.use` is `files` or `good`, with the count of the reasons. The reasons are in the output of the runtime.
- `install.ts status` reads the marker and checks the three files. A runtime on the last good set, or files with problems, give the code 1.
- In the profile `daemon`, the hook of each pass reads the three files again. A change that passes the check stops the runtime, and the supervisor starts it again.
- A change with problems gives its problems one time, and the runtime keeps the files of its start.
- A new text of the restart request `restart.request` in the folder stops the runtime with no check. Then the supervisor starts it again.
- A read error of the request gives no restart. The start reads the request too, thus the new runtime does not restart for the same request.

A deploy of new code to the live checkout does these steps, with no elevated shell:

1. Check out the new code, and install its dependencies.
2. Start `node src/install.ts restart` in the runtime package. It checks the private files with the new code. A problem stops it before the request.
3. The command writes a new request. Then it waits for a new process ID in `host/runtime.json`, for the readiness of the new runtime, and for the end of its start marker.
4. Code 0 tells that the new runtime is ready with the private files. Code 1 gives the problem, for example a new runtime on the last good set. Code 2 gives a wrong command.

The check of the profile `daemon` also needs the key `HEALTHCHECKS_PING_URL`, because the live instance needs its outside heartbeat.

A writer of the configuration does these steps, thus the live instance does not use a bad file:

1. Write the new file in the folder `ALERTS_HOME`, next to `config.json`.
2. Start `node src/check.ts <file>` in the runtime package. The check uses `checkConfig`, with the keys, the channels and the check of the profile `daemon`.
3. Rename the file to `config.json` only when the exit code is 0. Code 1 gives the problems, and code 2 gives a wrong command.

The output of the check gives the count of the places, the people, the contacts and the policies, or the problems. It holds no value and no path.

The runtime adds the codes of the zones near each place with a position (`withZoneCodes`). Thus a writer gives a position and one code of the state of the place. A `same` code of the county is better, because the IPAWS and radio alerts use it.

- At the start, the store of shapes gives the outlines of the zones of each state of the codes of the place. No request names the position.
- The function `zoneCodesNear` gives the codes of each county and forecast zone in the buffer of the place. The codes are the UGC codes, the `same` code of each county and the `state` code.
- The codes of the file stay first. The runtime only adds codes. It does not write `config.json`.
- The added codes hold the `state` code. Thus the NWS API source asks by state, not by zone.
- After a refresh with requests, when no task is due, the instance compares the codes again. A change starts `onPlaceCodes` one time. The profile `daemon` then stops, and the supervisor starts it again with the new codes.
- A place near the line of a state gets the zones of the states of its codes only. To watch a zone of the next state, give a code of that state too.
- The first start with a new state has no outlines of that state. The place uses the codes of the file until the store has the outlines and the runtime starts again.

The function `sourcePlaces` gives the places for one source, with no label, and with a position only when the place shares it with that source. The function `localPlaces` gives each position for the matching on the machine of the instance.

A person also watches subjects, other than places, in `PersonWatch.subjects`: a source of the system, a service or a cloud region. A watch with no id matches each subject of its system. A rule with places does not apply to a subject. The person who operates the system watches `{ system: "alerts.source" }` and `{ system: "alerts.channel" }`, and gets the health reports, the quota reports and the balance reports. A person with an interest graph (`PersonWatch.interests`) gets the routing by the relevance of [`RELEVANCE.md`](RELEVANCE.md).

The positions of the places do not go to a source. A source fetches by area, for example all the alerts of a state, and the core matches the places on the machine of the instance. So a `WatchedPlace` gives an adapter region codes and a buffer, and no name, no address and no position. A source that needs a position gets it only when the owner lets that source get it.

The core matches the area of a report to a place with one rule for each source. An area block is a group of areas that tell one area together. The adapter writes the key of the block in the field `block` of each area. The key is unique in the report. The merge puts the report id before the key, so the blocks of two reports stay apart.

- A block with a shape decides by its shapes for a place with a position. The place matches when the great-circle distance from its position to the nearest polygon or circle of the block is not more than its buffer. The codes of that block do not decide for that place.
- A block with no shape decides by its codes. A place matches when the codes of the block cover one of its codes.
- A place with no position matches by the codes of each block.
- `@mark1russell7/geo` can refuse a shape, for example a ring with fewer than 4 positions. When it refuses each shape of a block, the codes of that block decide. This error is on the safe side. The match has `shapeRefused: true`, and the view tells it.
- One block that matches is enough.
- The areas with no block key keep the union rule. Their codes are the floor of the match, and a shape adds a place in its buffer. A shape that geo refuses adds no place.
- A position in a shape has the distance 0. The reason `place` of the assessment has `distanceKm` when the distance is in the buffer. A match by a shape only has no codes.
- `@mark1russell7/geo` gives the distances. An edge of a polygon is a straight line in longitude and latitude, as in GeoJSON (RFC 7946).

The keys of the sources:

- An alert of the NWS API is one block with the key `feature`. Its geometry is the warned area, and its codes name each county or zone that the geometry touches.
- For a message of the NWS, the IPAWS adapter gives each CAP `area` element its path as the key, for example `info[0].area[1]`.
- In CAP, the area of an `area` element is the union of its polygons, circles and geocodes. Only the NWS is known to write the warned area as the polygon. Another sender on IPAWS can mean the union, so its areas have no key. They keep the union rule, on the safe side.
- The IEM rows have only codes, so they have no key.

A known effect of the blocks: the NWS API and IPAWS copies of one warning are two reports, so each copy has its own blocks. When one copy has only codes, those codes match a place out of the polygon of the other copy. The error is on the safe side.

Two codes match when their systems and their values are equal, or when two SAME codes name regions that meet (`regionCovers`). A SAME code `PSSCCC` has the part `P`, the state `SS` and the county `CCC`. The part `0` is the full county, the county `000` is the full state, and `000000` is the full country (47 CFR 11.31).

- A part matches the full county, and the full county matches each part. Two different parts do not match.
- A code of a state matches each county of that state. `000000` matches each SAME code.
- The rule errs on the safe side: an alert for a full state goes to each place of that state.

The area `{ type: "place" }` covers that watched place only. Only the reports of the core use it. When the areas have no code and no place, and no place of the person has a position, the assessment gives the reason `no-codes`. The first sources, the NWS and IPAWS, give codes with each area.

## The map

The function `mapView` of the core gives the view of the map from the state of one pass. It takes the incidents, the assessments, the places, the coverage and a `ShapeLookup`. The view is a pure calculation, and the order of its inputs does not change it.

- Incidents: each live incident, from the highest level, then the highest severity, then the anchor. The level is the highest level over each person.
- Status: each incident keeps its status: `actual`, `exercise`, `system`, `test` or `draft`. A renderer gives each status other than `actual` a look and a legend entry of its own. Thus a test does not look like a real alert.
- Shapes: each polygon and circle of an incident, and the shapes of each region code from the store. A code with no shape goes to `unshaped`, and the renderer lists it as text.
- Places: the label, the position and the shapes of the smallest region with a shape. Each place also has its highest level, its live incidents and its gaps of coverage.

The level of a place is an upper bound. An assessment keeps only the highest level of its places. Thus a rule that lowers the level at one place does not show on the map.

The store of shapes fetches each zone and county of a state, not one code. A fetch of the code of a place names the place to the server. The map has no tiles from an outside server, because the tiles around a place also name the place. The renderer draws the outlines of the states, the counties and the zones.

The view holds labels and positions. Only a route on the loopback address gives it, and `GET /status` does not hold it.

The route `GET /map` of the runtime gives the `MapPayload` of `mapPayload`:

- `format`: `alerts-map/1` (`MAP_FORMAT`). A change that breaks a reader gets a new name.
- `at`: the time of the last pass, or `null` before the first pass.
- `view`: the view of the last pass. The payload assesses each live incident for each person, with the policy of the delivery.
- `basemap`: the regions under the view, simplified for the view box of the page.

Thus the level on the map is the level that the delivery gives. A mute with the effect `absent` gives `none`, as in `route` (`reachedAssessment`).

The API also serves the built local page (`packages/site/dist`) on the same address. The path `/` gives `local.html`, and the page reads `GET /map` on its own origin.

- The files come after the routes. A path of no file gets 404.
- Each file gets the policy of the folder: no inline script, no inline style and no connection to another origin.
- The theme before the first paint is the classic script `theme.js`, not an inline script. The plugin `themeFile` of `packages/site/theme-file.ts` adds it to the build and to the head of each page.
- Build the page before the start of the runtime: `pnpm --filter ./packages/site build`. Without the build, the path `/` gives 404.

### The health route

The route `GET /health` of the runtime gives the `HealthPayload` of `healthPayload`. The page reads it on its own origin, next to the map. `healthPayloadSchema` checks it.

- `format`: `alerts-health/1` (`HEALTH_FORMAT`). A change that breaks a reader gets a new name.
- `at`: the time of the last pass, or `null` before the first pass. The sources, the lateness and the coverage come from that pass.
- `now`: the time of the read. The stages of the copies and of the balances are at this time.
- `sources`: the health of each source. The last failure keeps its time and its kind, and not its message, because a message can hold the address of a fetch.
- `lateness` and `coverage`: the lists of the view of the last pass.
- `copies`, `quotas` and `balances`: each watch with its stages. The stages come from `copyStages`, `quotaStages` and `balanceStages`, thus the page and the system reports agree.

The coverage holds the ids of the places. Thus only the loopback address gives the route, as for the map.

### The history

The function `historyPayload` gives the `HistoryPayload` of the route `GET /history`. A time scrubber of a page replays how each incident grew. `historyPayloadSchema` checks the payload. The runtime gives the route on the loopback address only.

The query `since` is one whole number of milliseconds since the epoch, with no sign. With no query, the route gives each incident. A bad query, or two values, get the status 400 with a `problem`.

- `format`: `alerts-history/1` (`HISTORY_FORMAT`). A change that breaks a reader gets a new name.
- `at`: the time of the last pass, or `null` before the first pass.
- `since`: the payload has each incident with a change at this time or later. The value `null` gives each incident.
- `next`: the newest time of a change or of a time edge of the merge state, or `null` with no change.
- `incidents`: the history of each incident, in the order of the anchors. Each incident has each of its changes, from the oldest.
- `regions`: the shapes of each region code of the changes, one time each. A change names its codes, and the shapes stay out of each change.

A change comes at each time of entry of a report of the incident on this copy. An end mark of a known report also gives a change.

A time edge gives a change when the view of the incident changes at that time with no new fact. The time edges are the expiry of a report, the end of the window `pastWithin` of a table and the end of a mute. They count up to `at`, or up to the newest time of entry when it is later. An import can come after the last pass. Thus the view at a time is the last change at or before that time. A reader needs no rule of its own for an expiry.

The change has the parts of the incident that the copy knew at that time:

- The change has the live parts, as the map has only live incidents. With no live part, it has each part, and `live` is false.
- The level is the highest level over each person at that time, with the policy of the delivery and the mutes.
- Two parts of an incident before their merge give one change. The change has the higher level and severity, and the areas of the two parts.
- `places` has each watched place in the areas, in the order of the input places. The level of a place is the highest level of the assessments with the place. A matched place with no assessment has the level `none`. The map uses the same rule.
- The time of entry comes from the clock of this copy. Thus a late import of a report of another copy comes after the `since` of a reader.

The input `entered` gives the time of entry of each report and each end mark (`EntryTimes`). Without it, the history uses `OWN_ENTRY_TIMES`: the time of receipt of each report and the time of each end mark. The runtime keeps an index of the times of entry next to its state:

- An import gets the time of the exchange event of its read. The runtime writes that event after the imports of the read, with the time of this copy.
- The first time stays. A later read of the same part changes nothing.
- An own part keeps its own time. A part of the two sides gets the earlier time.
- A step of the clock moves each time of the index, as it moves the own parts. A retired report loses its times.
- The index is a fold of the log. Thus a restart gives the same times. A write that fails changes no time.

A reader keeps its histories by anchor:

1. Read with no `since`. Keep `next`.
2. Read again with `since` set to the last `next`. The payload gives the incident of the newest change again, because one time can get a later report.
3. Replace the history of each incident of the payload. Drop each history whose anchor is a report of an incident of the payload, because these incidents merged.
4. When `next` is below `since`, a step of the clock moved the times back. Read again with no `since`.

The work for an incident with no change and no time edge at `since` or later is only the read of its times. The levels come from the watches of the people, thus only the loopback address gives the route.

## Relevance

The relevance of an incident for one person is a calculation over the interest graph of the person (AL-35). The types are in the section "Relevance" of `contracts.ts`.

`RELEVANCE.md` describes the model, the defaults, the three kinds of opt-out, the why record and the gates.

The why line is live for the match by places:

- `route` gives each route of a live incident the `WhyRecord` of the matched place with the first id (`placeWhy`). Thus the order of the configuration does not change it. A match by subjects alone gives no why at this time.
- The runtime makes the line of each channel with `whyLine`, from the record and the labels of `placeLabels`. The labels stay in the runtime. No record and no event of the log holds them.
- A label goes into a line only when it is plain words. A line holds no digit, no code in capitals and no colon after its prefix. Thus it holds no address, point or region code.
- The gate test "The why fits each channel" holds each limit of `WHY_LIMITS` over seeded records and labels.

The calculation over the graph is in `relevance.ts`. The routing does not read it at this time. `RELEVANCE.md` tells its functions and its gates.

## The schemas

The file `schemas.ts` of the core has one zod 4 schema for each data type of the contracts and of the configuration. A schema checks data at a trust boundary. The boundaries are the output of a map function, the event log, the private configuration and the procedure tools.

- The types stay the source of truth. The type check fails when a schema and its type are different. This includes each optional key and each readonly key.
- Each object is strict, so an unknown key fails. An optional key with the value `undefined` also fails.
- No schema has a transform, so `z.toJSONSchema` converts each one for the procedure tools.
- A refinement holds each rule of a value that a type cannot hold, for example the anchor of an incident or a known kind code.
- The function `checkWith` checks a value with a schema at a boundary. Each problem names the path and the rule, for example `places[0].bufferKm`. It does not hold the value.

## Open points

- The procedure tools take the schema of each input and output from `schemas.ts`.
- The link rule has one family, the earthquakes. Each other kind with two sources of different ids gets its family with its second source.
- The calculation of the level from probabilities and costs (AL-31), with the base rates from the event log.
- The count of misses that ends a report of a snapshot source is 2 (`SNAPSHOT_MISSES`). This value is a shortcut. A measure of the flap rate of the IEM list replaces it (AL-8).
- The merge state grows with each report. A compaction of the incidents that ended before a horizon keeps it small. It must keep the three laws.
- The frame clock does not see a step while the process is down, because the first frame starts with the process. Then a time of the log can be after the first pass.
- The park times of the hosts in `polite-crawler` do not move at a step of the wall clock.
- The quota gates read the wall clock with no frame. Their windows are civil times, thus a step changes them as it changes the calendar.
- A system report does not name its copy. With two copies, the owner cannot tell which copy has the fault.
- A copy gets `config.json` and `secrets.env` by a copy of the files over the tailnet. A sync of the files is not in the code. The check of the hash finds a difference.

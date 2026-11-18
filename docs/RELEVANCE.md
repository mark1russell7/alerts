# Relevance

The relevance tells how much one incident touches one person. It is a calculation over the interest graph of the person. The item AL-35 of the roadmap holds the work.

This file describes the model, the defaults, the three kinds of opt-out and the gates. The types are in `packages/core/src/contracts.ts`, in the section "Relevance". Their schemas are in `schemas.ts`.

## The idea

- An incident has subjects: places at each scale, topics and entities. An entity is a service, a provider, a company or a software package.
- A person has an interest graph. Its nodes are subjects and the person. Each edge has a chance that an effect passes along it.
- The relevance is the chance that an effect of the incident gets to the person on one path or more.
- Each alert carries the record of the match: the subject, the path and the origin of the interest.

A tornado warning near the home of the person gets to the person directly. A cloud outage gets to the person through the services that use that cloud region. An outage of a power utility gets to the person through the places in its service area.

## The calculation

### The entries

Each subject of the incident that is a node of the graph gives one `SubjectEntry`. The `hit` of an entry is the chance that the incident hits the subject when the event is real.

- For a place, the hit is the share of the area near the place that the incident covers.
- For a topic or a named entity, the hit is 1.

The event is a virtual source node. It has one edge to each entry, and the chance of that edge is the hit.

### The reach

Each edge is on with the chance of its weight. The edges are independent. The reach `R` is the chance that at least one path from the event to the person is fully on.

- A path has `hopCap` edges or fewer. The first value is 4.
- An edge with `on: false` is not part of a path.
- A cycle adds no path.

This is the two-terminal reliability of the graph. The exact value is a sum over the states of the edges.

### The bounds

The reach has two bounds that are fast to calculate:

- `best`: the chance of the best path. Each path is a lower bound.
- `noisyOr`: `1 - Π (1 - chance of each path)`. This is the upper bound of Esary and Proschan (1963) for the paths of a monotone system.

Thus `best ≤ R ≤ noisyOr` on each graph. When the paths share no edge, `R = noisyOr`.

### The interval

The reach is monotone in each weight and each hit. A higher weight does not lower the reach. Thus the reach at the low end of each interval is the low end of the reach. The reach at the high end of each interval is the high end of the reach.

### The exact sum

The exact sum is a Shannon expansion over the edges, in the order of their ids:

```text
R(G) = w(e) · R(G with e on) + (1 - w(e)) · R(G with e off)
```

- The order of the ids is fixed. Thus the order of a file, of the paths or of the subjects has no effect on the result, bit for bit.
- The arithmetic is a parameter: zero, one, add, sub and mul. The gates use exact rationals of `@mark1russell7/rational`. Production uses floats.
- The home of the calculation is `@mark1russell7/collections`, beside its graph code. It does not depend on `rational`.

### The importance and the next question

The Birnbaum importance of an edge is `R(edge on) - R(edge off)`.

- `weakest`: the edge with the largest importance. The alert can show it as the weak link of the path.
- `next`: of the edges with a default weight, the edge with the largest importance times the width of its interval. The page asks the person about this edge first, because the answer makes the largest change.

## The score

The personal harm of an incident is `P(event) × R × harm`. It is the factor of the person in the score of AL-31.

The relevance does not replace the other inputs. The severity, the urgency, the certainty, the action and the audience of an incident stay separate fields.

## Topics and the levels of the taxonomy

A topic node has the key `topic:<prefix of a kind code>`. The prefix is a code of `TAXONOMY`, and the schema refuses another prefix. The longest prefix of the kind code with an edge decides, as for the priors and for `LevelRule`.

Example: a person has the edges `topic:met` and `topic:met.flood`. An incident of the kind `met.flood.flash` uses the edge of `topic:met.flood`.

## The edges

| Kind | Meaning | Example |
| --- | --- | --- |
| `physical` | A supply of matter or energy. | A power utility and a home. |
| `cyber` | A supply of data. | A DNS provider and a web service. |
| `geographic` | A shared place. | A county and a place in it. |
| `logical` | A rule or a contract. | A bank and its card network. |
| `interest` | The last edge, into the person. | A place and the person. |

The first four kinds come from Rinaldi, Peerenboom and Kelly (2001).

- A common cause is one node. Two services on one DNS provider share the node of that provider. Thus the reach counts the cause once.
- A backup goes into the weight. The weight is the need times the chance that an outage lasts longer than the backup. Thus the weight stays a probability, and the reach stays monotone.
- An unknown weight gets a wide interval, not 0. An unknown part is exposure, not nothing.

## The defaults

Each edge has an `origin`. Each origin except `person` is one layer of the defaults.

| Origin | Layer | Source |
| --- | --- | --- |
| `base` | The human base. | The same for each person: the places where the person lives and is, and life safety. |
| `places` | The watched places. | The configuration of the person. |
| `services` | The services of the person. | The services that the person names. |
| `delivery` | The path of the alerts. | The services of the channels where the person has a contact. |
| `work` | The work of the person. | The tools and the services of a kind of work. |
| `data` | Public data. | For example the service areas of the power utilities. |
| `measured` | Measures. | For example the DNS providers of a domain. |
| `person` | The choice of the person. | No default replaces it. |

- Each default shows as a row that the person can see and change. The row shows its origin, its source, its date and its doubt.
- A new subject of a followed kind is in scope automatically. A new component of a service does not stay out because nobody added it.
- A graph with only edges from a place to the person, each with the weight 1, gives the routing of the first releases. This is the compatibility gate.

### The join of the layers

`composeInterests(person, layers, own)` joins the default layers and the graph of the person into one graph. It also gives a row for each edge.

- At each pair of nodes, the graph holds the edges of the strongest origin. The rank is `ORIGIN_RANK`: `person`, `measured`, `data`, `services`, `delivery`, `work`, `places`, `base`.
- Each weaker edge at that pair stays as a row, with the id of the edge that replaced it. The person can see each default.
- A person turns a default off with an edge of the origin `person` that is off. The row of the default stays.
- Two edges of one origin at one pair are two routes.
- An edge in a layer and in the graph of the person counts once. Thus a second join of a joined graph gives the same result.
- The order of the layers and of their edges has no effect.
- The mutes and the labels come from the graph of the person.

A default edge has the id `<origin>/<from>><to>`, so it has the same id at each build. Four layers have a function:

| Function | Layer | Edges |
| --- | --- | --- |
| `placesLayer(places)` | `places` | One edge from each watched place to the person, with the weight 1. |
| `workLayer(works)` | `work` | One edge from each topic of each kind of work. The table `WORK_DEFAULTS` gives the topics. |
| `servicesLayer(services)` | `services` | One edge from each entity that the person names, for example `domain:example.com`. |
| `deliveryLayer(channels)` | `delivery` | One edge from each service of the channels, with the weight 1. The source names the channels, for example `channel:push`. |

- The table of the kinds of work gives topics, not chances. Thus each edge of `work` and `services` has `UNKNOWN_WEIGHT`, the full interval.
- A topic edge reaches the person from each place on the Earth. Thus the table names only the topics that touch the work wherever they occur.
- Each alert of the person goes through each service of a channel of the person. Thus an edge of `delivery` has the weight 1, as a watched place has.
- A named service outranks the path of the alerts. Thus the weight that the person gives a service replaces the weight 1.
- The layer `base` has no function yet. Without a test of the size of an event, a topic edge of the base routes each event of the world. The shadow score of AL-31 and the indicators of AL-59 give that test.
- The layers `data` and `measured` come from adapters, for example the service areas of the power utilities.

The field `defaults` of a person in the private configuration gives the inputs of the layers: `works` (keys of `WORK_DEFAULTS`) and `services` (node keys of entities). The switch `delivery: false` turns the layer `delivery` off.

- The load joins the layer `places`, the layers of the inputs, the layer `delivery` and `PersonWatch.interests`.
- The layer `delivery` takes the field `services` of each `ChannelDescriptor` where the person has a contact. `contactChannels` finds these channels. The recipient gets the joined graph.
- The layer `places` is always in the join. A graph of work topics alone stops the routing at the places.
- A person with no field `defaults` keeps the watch. Thus the routing of a configuration without the field stays the same.
- An unknown work, a service that is not an entity or a changed default is a problem of the load. Then the person keeps the watch.

The route `GET /interests` of the runtime gives the rows of the join of each person. The panel Interests of the local page shows them. Each row has its origin, its weight and its state. A default that an edge of the person replaced stays visible.

## Less, off and mute

A person has three kinds of opt-out. Each one has a scope.

- Less: a lower weight on one edge. The reach goes down, and the alert can still come.
- Off: `on: false` on one edge. The edge stays as a row, and the reach does not use it.
- Mute: a `Mute` with kinds, subjects or both, and an optional end `until`. A mute with no subjects matches each incident of its kinds. A mute with subjects matches an incident when one of its subjects is an entry. A matched incident does not reach the person on any path.
- Cut: a mute with subjects that does not match cuts its subjects from the graph. Each edge into or out of a muted subject is off, so no path goes through it. Thus a mute of a bank also stops an outage of its DNS provider that reaches the person through the bank.

A mute with kinds and subjects has effect only on the incidents of its kinds. Thus a person can mute one kind of alert for one subject.

The mandatory class is decided: a mute makes a life-safety warning at a watched place silent, not absent. The top class of WEA and of EU-Alert works the same way. The field `mandatory` of `RelevancePolicy` holds the choice, and `DEFAULT_RELEVANCE_POLICY` gives `silent`.

Under the policy `silent`, a mute does not cut an incident of the mandatory class. Then a mute of a subject between the entry and the person has no effect, and the alert keeps its sound.

The field `muted` of the relevance goes into the assessment as `Assessment.muted`. The delivery uses each effect as follows:

- `absent`: the escalation of the person ends with the reason `muted`. Its repeats and its receipts stop, and no message tells of the end.
- `silent`: the level stays. The episode sends one quiet message at most, and only when the person has no message of the incident. Thus a mute after a loud alert sends no copy.
- An acknowledgment before a change of a mute still counts. When a mute ends before an acknowledgment, a loud episode starts again.

[`CONTRACTS.md`](CONTRACTS.md) tells the episodes and the reasons of an end.

## The why record

Each alert carries a `WhyRecord`:

- `rule`: a stable id of the reason, `reach.<subject kind>.<origin>`.
- `subject`: the subject of the incident at the start of the path.
- `via`: the first node after the subject, when two nodes or more are between the subject and the person.
- `anchor`: the last node before the person.
- `origin`: the origin of the interest edge.
- `coverage`: the reach of the shown paths alone, divided by the full reach.

The record holds only keys. The runtime gives the private labels from the configuration. The coverage keeps the why honest: a path that explains a small part of the reach does not look like the full cause. When the budget ends a sum, the reach is the ceiling, so the coverage is a floor.

The delivery puts the why in the text of each channel, with these limits:

| Channel | Limit |
| --- | --- |
| Push | 80 characters. |
| Text message | 40 characters of GSM-7. |
| Voice call | 12 words. |

No text holds an address, a point or a region code.

`WHY_LIMITS` in `why.ts` holds these values. A channel descriptor names the limit of its kind in its field `why`. The gate test "The why fits each channel" holds each limit.

## The code

The file `relevance.ts` of the core holds the calculation. `relevance-gates.test.ts` holds the gates.

- The file `interest-defaults.ts` holds the layers and their join. `interest-defaults.test.ts` holds their gates.
- `relevance(input, graph, policy)` gives the `Relevance` of one incident. The input holds the kind, the entries, the time and the mandatory class.
- `canReach(input, graph, policy)` tells if the reach at the high ends is more than 0. The routing uses it for each entry.
- `DEFAULT_RELEVANCE_POLICY` gives the hop cap 4, the top 3 paths, the mandatory class `silent` and the level `urgent` for the other entries.
- `assess` in `assess.ts` holds the routing. A fault of the relevance gives the reason `relevance-fault`, and the places decide.
- `muteOf` gives the matched mute and its effect. Of two matched mutes, the mute with the first id wins.
- The cut of the mutes is in the parts of the sum. Thus `reachOf` and `relevance` use the same parts.
- `topicEntry(kind, graph)` gives the topic entry of a kind, by the longest prefix with an edge. An edge that is off also counts, so it turns off its level only.
- `reachOf` gives the exact sum at one end of the intervals, in a given arithmetic, with the cut of the mutes. The gates use exact rationals.
- The calculation sorts the entries by node and the edges by id. Thus each order of the input gives the same result.
- The option `maxSteps` limits each sum. When the budget ends a sum, the field `bound` tells it. The reach is then the ceiling, so an alert is not lost.

## The ids

`SUBJECT_SYSTEMS` in `contracts.ts` is the one closed list of the systems of subject ids. The source records of AL-36 use the same list, and their gate imports it. A new system comes with the first source or default that gives its ids.

A `NodeKey` is `person`, or `<system>:<id>`. The id is the text after the first colon, thus an id can hold a colon.

| Kind | Systems | Example key |
| --- | --- | --- |
| place | `place`, `point`, `polygon`, `ugc`, `same`, `fips`, `state`, `iso3166`, `geonames`, `icao` | `ugc:KSC173` |
| topic | `topic`, `iptc`, `cap-category` | `topic:infra.power.outage` |
| entity | `cve`, `wikidata`, `asn`, `domain`, `provider-region`, `ticker`, `lei`, `purl` | `purl:pkg:npm/example` |

The system `place` holds the watched places of a person, by their ids in the configuration.

An id of the system `provider-region` is the provider, a slash and the id of the region of the provider: `provider-region:gcp/europe-west1` or `provider-region:aws/eu-west-1`. The ids of the regions come from the feed of the provider, not from its titles.

## The gates

| Gate | Kind | Rule |
| --- | --- | --- |
| An opt-out wins | Property | A matched mute gives 0 on each graph with each weight. The mandatory class is the only exception, and the mute makes it silent. A mute of a subject that is not an entry gives the reach of the graph with each edge of that subject off. No why or path names a muted subject. An edge that is off does not raise the reach. No why names a removed node. |
| One answer in any order | Property | A shuffle of the nodes, the edges, the subjects and the paths gives the same reach, bit for bit, with exact rationals. |
| Monotone | Property | A higher weight does not lower the reach. |
| Inside the bounds | Property | `best ≤ R ≤ noisyOr` on each generated graph. |
| Hop cap and cycles | Property | An edge that adds only a path longer than the hop cap, or only a cycle, changes nothing. |
| An honest why | Property | The coverage equals the reach of the shown paths alone, divided by the full reach. |
| Who each class reaches | Table | For each class of event and each example person, the test holds the expected reach and the expected why. The tier comes when the score of AL-31 reads the reach. |
| Compatibility | Compat | A graph with only place edges of weight 1 gives a reach of 1 when the incident hits a watched place, and 0 when it does not. The routing test holds the old levels and places of nine incidents. A replay of the recorded incidents with a configured graph is an open point. |
| The why fits each channel | Limits | Each why text keeps the limits of its channel and holds no address, point or code. |

## The routing

Step 5 routes the alerts by the relevance. `assess` uses the graph in `PersonWatch.interests`, and `AssessPolicy.relevance` gives the policy. With no graph, the routing of the first releases stays.

- The entries are the matched places (`place:<id>`), the code areas, the place areas, the subjects of a known system and the topic of the kind. Each entry has a hit of 1.
- A matched place counts only when its entry alone reaches the person: the reach at the high ends is more than 0. The cut of the mutes applies.
- An entry that is not a watched place gives the level of the table, up to `entryMax` of the policy. The default is `urgent`, because `life-safety` needs a place of the person.
- A rule of the person (`LevelRule`) with the field `through` matches only through entries of those kinds: `place`, `topic` or `entity`. Each kind of the other entries gets its own first rule, and the highest level wins.
- The reason `reach` tells the reach, the entries that count, the places of the rule and the why.

An example is the work `software`. Its topics reach the outages of each online service. These rules keep a service that the person names at `notice`, and send the other outages to the digest:

```json
[
  { "kinds": ["infra"], "through": ["topic"], "max": "digest" },
  { "kinds": ["infra"], "max": "notice" }
]
```
- `Assessment.muted` holds the matched mute. The level stays the level before the mute, and the delivery uses the effect.
- With no time, a mute with an end has no effect, so the alert is not lost.

### The rule of the life-safety warnings

`PersonWatch.mandatory` holds a rule for each place: a switch `on` and a range `rangeKm`. A place with no rule has the rule on, and its range is the buffer of the place.

- A matched place is under the rule when each of these conditions is true:
  - The switch is on.
  - The table gives `life-safety` at the place.
  - The match is in the range.
- A match by the codes or by the id of the place is in each range. A match by a shape is in the range when its distance is `rangeKm` or less.
- A place under the rule always counts, also with an edge that is off. Then the incident is of the mandatory class, and a mute has the effect `policy.mandatory`.

### The runtime configuration

The private configuration gives the graph and the rules in the `PersonWatch` of each person. The field `assess` of the configuration gives the policy.

- The load refuses a graph of another person, and a place of the graph that the person does not watch.
- The load refuses a rule at a place that the person does not watch, and rules with no graph.
- The why of a route is the why of the reach (`assessmentWhy`). With no why of the reach, the watched place with the first id gives the why.
- A why line takes the labels of the instance first, and then the labels of the graph of the person (`graphLabels`). No label goes into the log.

## The tests of step 5

These tests come with the routing:

- `relevance` throws a `RangeError` for an entry of the person, an edge from the person and two edges with one id. The schema refuses the two graph cases. An adapter can still give the entry `person`.
- When `relevance` throws for one person, the alert is not lost. The routing catches the error, sends the alert by the place routing of the first releases and records a fault.

## Privacy

- The interest graph of a real person is private configuration. The repository holds the model, the taxonomy, the defaults from public data and the adapters.
- The tests and the examples use made-up graphs.
- The why record holds keys. The labels stay in the private configuration.
- A default from public data comes from a fetch of a full area, not from a lookup of a place of the person.

## Open points

- A replay of the recorded incidents with a configured graph, before the graph goes into the configuration. It compares the levels with and without the graph.
- A fast path: when the two bounds give the same level, the exact sum is not necessary.
- The size of a real graph, and the budget of steps that it needs. A check of the configuration can give a problem before a sum ends with `bound`.
- Weights from travel time, for a place that the person visits.
- The calibration of the default weights from the event log.

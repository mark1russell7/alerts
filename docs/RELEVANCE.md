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

A topic node has the key `topic:<prefix of a kind code>`. The longest prefix of the kind code with an edge decides, as for the priors and for `LevelRule`.

Example: a person has the edges `topic:met` and `topic:met.tornado`. An incident of the kind `met.tornado.warning` uses the edge of `topic:met.tornado`.

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
| `work` | The work of the person. | The tools and the services of a kind of work. |
| `data` | Public data. | For example the service areas of the power utilities. |
| `measured` | Measures. | For example the DNS providers of a domain. |
| `person` | The choice of the person. | No default replaces it. |

- Each default shows as a row that the person can see and change. The row shows its origin, its source, its date and its doubt.
- A new subject of a followed kind is in scope automatically. A new component of a service does not stay out because nobody added it.
- A graph with only edges from a place to the person, each with the weight 1, gives the routing of the first releases. This is the compatibility gate.

## Less, off and mute

A person has three kinds of opt-out. Each one has a scope.

- Less: a lower weight on one edge. The reach goes down, and the alert can still come.
- Off: `on: false` on one edge. The edge stays as a row, and the reach does not use it.
- Mute: a `Mute` with kinds, subjects or both, and an optional end `until`. A matched incident does not reach the person on any path.

The mandatory class is an open point. The proposal: a mute makes an imminent life-safety warning at a place where the person is silent, not absent. The top class of WEA and of EU-Alert works the same way. The field `mandatory` of `RelevancePolicy` holds the choice. The repository has no default policy until the owner decides.

## The why record

Each alert carries a `WhyRecord`:

- `rule`: a stable id of the reason, `reach.<subject kind>.<origin>`.
- `subject`: the subject of the incident at the start of the path.
- `via`: the first node after the subject, when the path has more than one edge.
- `anchor`: the last node before the person.
- `origin`: the origin of the interest edge.
- `coverage`: the reach of the shown paths alone, divided by the full reach.

The record holds only keys. The runtime gives the private labels from the configuration. The coverage keeps the why honest: a path that explains a small part of the reach does not look like the full cause.

The delivery puts the why in the text of each channel, with these limits:

| Channel | Limit |
| --- | --- |
| Push | 80 characters. |
| Text message | 40 characters of GSM-7. |
| Voice call | 12 words. |

No text holds an address, a point or a region code.

`WHY_LIMITS` in `why.ts` holds these values. A channel descriptor names the limit of its kind in its field `why`. The gate test "The why fits each channel" holds each limit.

## The ids

`SUBJECT_SYSTEMS` in `contracts.ts` is the one closed list of the systems of subject ids. The source records of AL-36 use the same list, and their gate imports it. A new system comes with the first source or default that gives its ids.

A `NodeKey` is `person`, or `<system>:<id>`. The id is the text after the first colon, thus an id can hold a colon.

| Kind | Systems | Example key |
| --- | --- | --- |
| place | `place`, `point`, `polygon`, `ugc`, `same`, `fips`, `state`, `iso3166`, `geonames`, `icao` | `ugc:KSC173` |
| topic | `topic`, `iptc`, `cap-category` | `topic:infra.power.outage` |
| entity | `cve`, `wikidata`, `asn`, `domain`, `provider-region`, `ticker`, `lei`, `purl` | `purl:pkg:npm/example` |

The system `place` holds the watched places of a person, by their ids in the configuration.

## The gates

| Gate | Kind | Rule |
| --- | --- | --- |
| An opt-out wins | Property | A mute gives 0 on each graph with each weight. The mandatory class is the only exception, and the mute makes it silent. An edge that is off does not raise the reach. No why names a removed node. |
| One answer in any order | Property | A shuffle of the nodes, the edges, the subjects and the paths gives the same reach, bit for bit, with exact rationals. |
| Monotone | Property | A higher weight does not lower the reach. |
| Inside the bounds | Property | `best ≤ R ≤ noisyOr` on each generated graph. |
| Hop cap and cycles | Property | An edge that adds only a path longer than the hop cap, or only a cycle, changes nothing. |
| An honest why | Property | The coverage equals the reach of the shown paths alone, divided by the full reach. |
| Who each class reaches | Table | For each class of event and each example person, the test holds the expected tier and the expected why. |
| Compatibility | Compat | A graph with only place edges of weight 1 gives the routing of the first releases on each recorded incident. |
| The why fits each channel | Limits | Each why text keeps the limits of its channel and holds no address, point or code. |

## Privacy

- The interest graph of a real person is private configuration. The repository holds the model, the taxonomy, the defaults from public data and the adapters.
- The tests and the examples use made-up graphs.
- The why record holds keys. The labels stay in the private configuration.
- A default from public data comes from a fetch of a full area, not from a lookup of a place of the person.

## Open points

- The mandatory class, a decision of the owner.
- A fast path: when the two bounds give the same level, the exact sum is not necessary.
- A limit on the size of the exact sum, for a graph with many shared edges.
- Weights from travel time, for a place that the person visits.
- The calibration of the default weights from the event log.

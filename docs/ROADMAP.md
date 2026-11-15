# Roadmap

This file is the plan of alerts. The Status page of the site reads it, and the tracker of the project mirrors it.

The goal of phase 1: the system does not miss a life-safety warning at a watched place. Each kind of input has two or more independent sources. The delivery repeats until the person acknowledges. A watchdog and an outside heartbeat watch the system.

The repo is public. It holds the general framework only. People, places, keys and the choices of the owner stay in a private configuration.

## Phase 1: the live slice

| ID | Item | Status | Summary |
| --- | --- | --- | --- |
| AL-28 | Contracts: the event, the source and the channel | done | The TypeScript types and [`CONTRACTS.md`](CONTRACTS.md). The sources and delivery efforts start from them. |
| AL-1 | Design study | in progress | The scope, the pipeline, the formulas of the priority, the fault model, a catalog of sources by kind and the test plan. |
| AL-2 | First commit and the public repo | done | The template stamp, the public repo and the first CI runs. |
| AL-3 | The home of each part | in progress | The sending clients go to `@procedures/notify`. Geography goes to `@mark1russell7/geo`. The fetches go through `polite-crawler`. |
| AL-4 | The push and heartbeat accounts | done | The owner makes a Pushover account and a Healthchecks.io account. The keys stay outside the repo. |
| AL-5 | Event model and taxonomy | in progress | The core package: the types, the schemas, the id functions and the first taxonomy, from the SAME event codes and the NWS event names. The id functions are done. |
| AL-6 | Merge reports into incidents | done | Grow-only sets with a union join. Property tests hold the three laws: idempotent, commutative and associative. |
| AL-7 | Priority calculation | done | The first table: a policy of data, the match of places by codes and the rules of each person. The calculation from probabilities and costs is AL-31. |
| AL-8 | Weather and emergency sources | in progress | The NWS API, the NWS CAP feed and FEMA IPAWS, each a procedure package with recorded fixtures and a canary. The NWS API source is in review. |
| AL-9 | Pushover delivery with acknowledge and escalate | blocked | Emergency priority with iOS Critical Alerts. The core reads the receipt and escalates to the next step. |
| AL-10 | Source health and coverage | in progress | A health state machine for each source, and the coverage of each kind at each place. A gap is a system alert. The health machine is in review. The coverage and the system reports come next. |
| AL-11 | Operate as a service | blocked | The service runner of `@mark1russell7/service`, with an append-only event log in SQLite. |
| AL-12 | Outside heartbeat | blocked | The running system pings Healthchecks.io. When the pings stop, Healthchecks.io alerts the owner. |
| AL-13 | Fault tests of the pipeline | blocked | Fault plans from rigor: a source down, slow, duplicated, out of order or with a changed format, a channel down, a copy stopped. A gate holds each case. |
| AL-29 | A standalone weather radio | waiting | The owner sets up a SAME weather radio at the bed. It needs no internet and no part of this system. |

## Phase 2: wider and harder

| ID | Item | Status | Summary |
| --- | --- | --- | --- |
| AL-14 | More hazards | blocked | Earthquakes, floods, hurricanes, air quality, wildfire smoke, space weather and power outages, each with two or more sources. |
| AL-15 | Text and voice | blocked | Text messages and voice calls as the next step of the escalation, on a second provider. |
| AL-16 | A cloud copy | blocked | A second copy of the system on a cloud server. The merge makes the copies agree. |
| AL-17 | People and places from the private store | blocked | The system reads people and places from the private configuration at run time. |
| AL-18 | A UI with a map and overlays | blocked | Live incidents, warning areas, places and coverage on a map, with a view by criticality. |
| AL-19 | Technical outages and news | blocked | Status pages, cloud regions, internet outages and breaking news, with the same merge and priority. |
| AL-25 | Radio input through an SDR | blocked | A software-defined radio receives NOAA Weather Radio, and the system decodes its SAME headers. This input needs no internet. |

## Later

| ID | Item | Status | Summary |
| --- | --- | --- | --- |
| AL-20 | Preparedness planner | later | Hazard likelihood times exposure gives what to buy and do first, and an action plan for each hazard and each person. |
| AL-31 | Priority from probabilities and costs | blocked | The probability that the event is real, times the exposure of the people, times the harm and the urgency, against the cost to interrupt the person. The base rates come from the event log of AL-11. |
| AL-21 | Alerts for other people | later | More recipients, each with their own places, channels and night rule. |
| AL-22 | A home cluster copy | later | A third copy of the system on a home cluster. |
| AL-26 | Provider redundancy at each layer | later | Two or more providers at each layer: power, network path, DNS resolvers, hosting, push service and the APIs of each source. |
| AL-27 | Emergency radio | later | Radio for when phones and the internet fail: receivers, licensed radio and an off-grid text mesh. |
| AL-23 | Markets | later | Markets as a lens on the same signal stream. |
| AL-24 | World model | later | Hidden common causes behind separate events, correlations across domains and a general threat level. |

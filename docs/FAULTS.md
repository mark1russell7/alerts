# The fault suite

The fault suite tests the pipeline under faults: a source, a channel, the copies, the wall clock and the file of the log. Each case has arms. An arm is one fault plan, or no fault for the control arm. A gate examines the outcome of each arm.

A gate that cannot decide gives no read. A case with a failed gate or no read fails its job. The code of each case is in `packages/testkit/src`, with its arms and its gates.

## Where the cases start

- The workflow `Faults` (`.github/workflows/faults.yml`) starts cases 1 to 10 and case 13 with `node packages/testkit/scripts/fault-cases.ts`.
- These cases put a fault proxy of `@mark1russell7/rigor-proxy` between the system and a scripted server. The fault plans are data of `@mark1russell7/rigor-chaos`.
- A cut and a time limit are sensitive to time. Thus these cases start only in CI, where no other job shares the runner.
- The workflow starts on each pull request, and on each push to `main` that changes a package of the suite. A person can also start it with `workflow_dispatch`.
- Each case writes its records to `fault-records/case-<n>.json`. The job keeps the records as an artifact, and writes a table of the gates to its summary.
- Cases 11, 12 and 15 use fake clocks, thus the time of the runner does not change their outcome. The workflow `Faults` also starts case 15, and keeps its record in `fault-records/case-15.json`. They are `vitest` tests of `packages/testkit`, and the checks of CI start them.

## The cases

| Case | File | The fault | The gates |
| --- | --- | --- | --- |
| 1 | `cut-in-body.ts` | The proxy cuts the connection in the body of the main reply of the NWS source, in three framings: `length`, `chunked` and `close`. | A cut in the framings `length` and `chunked` gives a failed fetch of the kind `network`. No cut gives a complete fetch. |
| 2 | `slow-source.ts` | The main reply comes slowly: a stall longer than the time limit, a trickle of small writes, or a short stall. | A long stall and a trickle give the kind `timeout`, before the stall or the trickle ends. A short stall gives the full list with no failure. |
| 3 | `changed-format.ts` | The NWS changes the format of its replies: renamed keys, a sent time as a count of milliseconds, renamed severities and urgencies, or a new field. | Each alert keeps its level, or the health of the source is `changed` or `failing`. A new field keeps the meaning, thus each alert keeps its level and the health is not `changed` or `failing`. |
| 4 | `late-accept.ts` | The Pushover API answers late after it accepts a message, or it hangs after or before it accepts the message. | `delivered`, `single` and `stopped`: each key has one live copy, and a cancel or an acknowledgment reaches each accepted message. |
| 5 | `source-down.ts` | The host of the NWS source does not answer for a time, and then it answers again. | `detected`: the health goes down in 3 intervals of the source. `recovered`: the health comes up in the recovery limit. |
| 6 | `stale-list.ts` | The IEM snapshot source gives an old list or a repeated list. | `noFalseEnd`, `noFalseBack` and `settles`: the runtime ends only the reports whose rows left the true list. |
| 7 | `channel-down.ts` | The Pushover API takes no message for a time. | The gates of case 4, then `recovered`, `told`, `cleared`, `paced` and `probed`. A fail ping goes to the outside check during the outage. |
| 8 | `copy-late.ts` | The IPAWS copy feed of the WEA messages stops or lags. | `noFalseClear`, `oneIncident`, `settles`, `clears`, `tellsStop` and `staysLate`: the lateness of IPAWS goes late, and a message and its copy are one incident. |
| 9 | `out-of-order.ts` | The messages of one event line come from NWS and IPAWS out of order, twice, or with a gap. | `sends`, `oneKey` (law L1), `quietAway` (law L2), `episodes` (law L3) and `ends`. |
| 10 | `kill-restart.ts` | The runtime gets `SIGKILL` at one point of a delivery. A second life then opens the same log. | The gates of case 4, then `copyOnce` and `restartOnce`: a restart sends no extra page. |
| 11 | `clock-step.ts` | The wall clock steps back or forward at one point of a delivery, a retry or a fetch. | The gates of case 4, then `copyOnce`, `noThrow`, `prompt`, `stepSeen`, `oneCopy` and `noOverdue`. |
| 12 | `log-fault.ts` | A second connection holds the write lock of the log file, or the log file is broken at the boot. | The lock gates: the gates of case 4, `copyOnce`, `oneCopy`, `attempted`, `noThrow`, `noSendLocked`, `noPingLocked`, `promptAfter` and `pingAfter`. The boot gates: `bootOk`, `kept`, `salvaged`, `noPageAgain` and `lossReported`. |
| 13 | `two-copies.ts` | Two copies of the system and one phone, with faults on the exchange of the copies. | `pushed`, `calls`, `caller`, `apart`, `noThrow` and `faulted`: the copy with rank 1 does not call when its ledger has the call of the copy with rank 0. |
| 15 | `send-burst.ts` | A burst of 100 new notices and 2 life-safety alerts for one person. The arms have one copy, two copies, a split, imported incidents, a source that flaps and a rollback. | `capped`, `held`, `lifeSafety`, `settles` and `noThrow`, then `oneSend` and `flapped` in some arms: the sends of each level stay in the send limit of the person over all the copies. |

## The faults that the cases found

- Case 4 found two emergency copies after a hang. The fix gives a copy tag to each send.
- Before AL-49, a step back of the wall clock held each due action of case 11. The frame clock of AL-49 gives each step to the runtime at the start of the next pass.
- Case 12 found that the runtime opened a broken log file with no check. The fix of AL-50 checks the file at the boot.
- The design of the rollback arm of case 15 found that the send limit counted only the first delivery of an incident. Thus a rollback could send more than the limit in one window. The fix counts each delivery in the window. The second wave of the arm holds the fix.
- Case 7 in CI found that the gate `recovered` of its arm `limited` did not know the back-off of refusals of AL-72. Each try of that arm is a refusal, thus the first try after the outage comes at 630 s, 30 s after the outage. On `main`, the arm passed at 624.6 s with 0.4 s to spare, because the old back-off lost the time of each call. The gate now takes the schedule from `refusalWait` of the runtime.
- The arm `flapping` of case 15 shows that each flap of a source opens a new system incident. The send limit holds them to the limit of the person.

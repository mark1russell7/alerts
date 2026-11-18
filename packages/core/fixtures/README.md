# The fixtures of the core

- `usgs-us6000jllz-bands.json` has the four band reports of the USGS event `us6000jllz`, the earthquake of M 7.8 on 2023-02-06.
- The USGS source made these reports from the real ShakeMap of the event. It gives one report for each band of the shaking.
- Each report has one circle around the epicenter. The radius of the band `extreme` is 39.84 km, and the radius of the band `minor` is 522.36 km.
- The time `received` of each report is 10 minutes after the origin time.
- The test `earthquake-fixture.test.ts` sends these reports through the merge and the assessment.

- `burst-2026-11-18.json` has the shape of the burst of 2026-11-18: the messages to one person on one channel, for 4 hours from the first message.
- Each row is the second from the first message, the level, an incident number and an episode. The incident numbers are made up.
- The file has no id, no kind, no source, no place and no text of a message.
- The test `throttle.test.ts` replays it through the send limit and the throttle. The replay gives the default window of the throttle.

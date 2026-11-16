# The fixtures of the EMSC source

- `query-2.5_day-20261116T0528Z.json` is a real answer of the event service of EMSC (FDSN, format `json`). The service sent it at 2026-11-16 05:28:21 UTC.
- The request asked for the events of magnitude 2.5 or more of the past day, newest first: `/fdsnws/event/1/query?format=json&minmag=2.5&start=<one day before>&limit=500`.
- The answer held 183 events. The fixture keeps 53 of them, in the order of the answer, and its count is 53.
- The fixture keeps the 30 events of the USGS fixture `feed-2.5_day-20261116T0327Z.geojson` that EMSC has too. It also keeps one near miss, one event of each author and each format of the time.
- The other 130 events had no event of the USGS fixture in 10 minutes and 500 km. Their authors and time formats were in the fixture already.
- The tests use the M5.5 event `20261115_0000145` in the Philippines (author `NEIC`) and the M4.8 event `20261115_0000272` off Kamchatka (author `GSRAS`).
- The answer had a weak ETag, `cache-control: max-age=15` and no `Last-Modified`. It also set a cookie of the load balancer. The fixture and the source do not keep it.
- The data of EMSC is under the license CC BY 4.0. Credit: EMSC-CSEM SeismicPortal, https://www.seismicportal.eu.

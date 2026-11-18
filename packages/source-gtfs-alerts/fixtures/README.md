# The fixtures of the GTFS Realtime source

## `zditm-szczecin-20261118T0358Z.pb`

- This file holds the real bytes of the answer to `https://www.zditm.szczecin.pl/storage/gtfs/gtfs-rt-alerts.pb`. ZDiTM, the transit agency of Szczecin in Poland, sent it at 2026-11-18 03:58 UTC.
- The file has 2082 bytes. The header gives the version 2.0 and the time 2026-11-18 03:58:03 UTC.
- The feed has 2 alerts with texts in Polish, English, German and Ukrainian. One alert has an end. The other alert has no end.
- The answer had `Content-Type: application/octet-stream`, an `ETag` and a `Last-Modified` header.
- The catalog of the Mobility Database gives the license of the feed: CC0 1.0, a dedication to the public domain.

## `ruter-20261118T0358Z.pb`

- This file holds the real bytes of the answer to `https://api.entur.io/realtime/v1/gtfs-rt/alerts?datasource=RUT`. Entur sent it at 2026-11-18 03:58 UTC.
- The data source is Ruter, the transit agency of the Oslo region in Norway. Entur is the national service that distributes the data.
- The file has 30320 bytes. The header gives the version 1.0 and the time 2026-11-18 03:58:16 UTC.
- The feed has 59 alerts. No alert has an effect, a cause or a severity level. Most texts have no language code.
- One alert has a period for each night. One alert has 96 selectors. One alert starts after the fetch.
- The answer had `Content-Type: application/octet-stream`, and no `ETag` and no `Last-Modified` header.
- The license is the Norwegian Licence for Open Government Data (NLOD) 2.0. The credit that the license asks for: "Contains data under the Norwegian licence for Open Government data (NLOD) distributed by Entur."

## The two files

- The alerts contain the names of lines, stops, streets and stations. They contain no personal data.
- The tests give each feed a made-up URL on `transit.example.test`. The box of each network in the tests is an estimate, not a value of the feed.

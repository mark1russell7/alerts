# The fixtures of the tsunami sources

- `PAAQCAP-20261116T1134Z.xml` is the real latest CAP message of NTWC, at `https://www.tsunami.gov/events/xml/PAAQCAP.xml`. The site sent it at 2026-11-16 11:34 UTC.
- `PHEBCAP-20261116T1134Z.xml` is the real latest CAP message of PTWC, at `https://www.tsunami.gov/events/xml/PHEBCAP.xml`. The site sent it at 2026-11-16 11:34 UTC.
- Each of the two messages is a statement (`Tsunami Information`) with no VTEC and no zone. Its only area is a circle of radius 0 at the epicenter.
- The statement of NTWC tells of an M4.2 earthquake near Kodiak. The statement of PTWC tells of an M4.9 earthquake northwest of Isla Mona.
- The statement of NTWC has an `expires` time before its `sent` time. The tests keep this real fault of the center.
- `t06p1k-1.xml`, `t06p1k-2.xml` and `t06p1k-35.xml` are the bulletins 1, 2 and 35 of the NTWC event `t06p1k`, the earthquake off Kamchatka of 2025-07-29.
- The magnitude of the event went from 8.0 in bulletin 1 to 8.7 in bulletin 2 and 8.8 in bulletin 35.
- The site keeps each bulletin of a past event at `https://www.tsunami.gov/events/PAAQ/2025/07/29/t06p1k/<n>/WEAK51/PAAQCAP.xml`. The value `<n>` is the number of the bulletin.
- The list of the past events is at `https://www.tsunami.gov/php/previousEvents.php`. The site sent the three bulletins between 11:33 and 11:39 UTC on 2026-11-16.
- Bulletin 1 is an advisory. Bulletin 2 has three info blocks: a warning, an advisory and a watch, each with its own zones and VTEC.
- Bulletin 35 cancels the last advisory. It references the 34 earlier bulletins, and its only area is the circle at the epicenter.
- The server of the site is Apache. Its answers had `Content-Type: text/xml`, a `Last-Modified` time and no ETag.
- The messages of the centers are products of the US government, in the public domain. They contain no personal data.

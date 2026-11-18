# The fixtures of the SWPC source

- `alerts-20261116T1553Z.json` holds the real bytes of the list at `https://services.swpc.noaa.gov/products/alerts.json`. The site sent it at 2026-11-16 15:53:30 UTC.
- The list has 71 entries, newest first, from 2026-10-17 20:14 UTC to 2026-11-16 06:28 UTC. It ends with `"}]` and no line break.
- Each entry has three fields: `product_id`, `issue_datetime` in UTC with milliseconds, and `message`. The text of a message has CR LF line breaks.
- The answer had `Content-Type: application/json`, `ETag: "aa59-66066c55cdc1e"`, `Last-Modified: Mon, 16 Nov 2026 15:52:54 GMT` and `Cache-Control: max-age=60`.
- The list has the watches `WATA20` 1130 to 1138. Their forecast days overlap, so the tests examine the merge of the copies of a day.
- `archive-samples.json` holds 42 real messages of 33 codes from the monthly archive files of the SWPC.
- The archive files are `ftp://ftp.swpc.noaa.gov/pub/alerts/alerts_202405.html` and `ftp://ftp.swpc.noaa.gov/pub/alerts/alerts_202410.html`. The site sent them on 2026-11-16.
- May 2024 had the G5 storm of 10 and 11 May. Its messages are the only real G4 and G5 watches of the fixtures.
- An archive file is HTML, not JSON. Each tag of a sample became a line break, and the entities `&nbsp;` and `&amp;` became a space and `&`.
- The archive has no list entry, so a sample has no `product_id` and no `issue_datetime`. The tests use the issue time of the text as the time of the list.
- The messages of the SWPC are products of the US government, in the public domain. They contain no personal data.

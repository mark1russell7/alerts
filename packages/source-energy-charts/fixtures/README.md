# The fixtures of the Energy-Charts source

- `frequency-20261118T0313Z.json` holds the real bytes of the answer to `https://api.energy-charts.info/v2/frequency?region=DE-Freiburg&start=1794971249&end=1794971549`. The API sent it at 2026-11-18 03:13:30 UTC.
- That query asks for the 5 minutes from 03:07:29 UTC to 03:12:29 UTC. The answer has 263 values, one for each second from 03:07:29 UTC to 03:11:51 UTC, with no `null`.
- Thus the newest value of that answer was 99 seconds old. The minutes 03:08, 03:09 and 03:10 are complete.
- `frequency-20250428T1028Z.json` holds the real bytes of the answer to `https://api.energy-charts.info/v2/frequency?region=DE-Freiburg&start=1745836080&end=1745836680`. The API sent it at 2026-11-18 03:31:05 UTC.
- That query asks for the 10 minutes from 2025-04-28 10:28 UTC to 10:38 UTC. At 10:33 UTC, the grid of the Iberian Peninsula separated from Continental Europe and lost its power.
- In the minute of 10:33 UTC, the frequency falls to 49.844 Hz. The lowest values of the 5 minutes before are 49.9656 Hz or more.
- Each answer had `Content-Type: application/json` and ends with `}` and no line break. The answer of 2025 had no `ETag` and no `Last-Modified`.
- The answers give the license in the field `license`: CC BY 4.0. The credit that the license asks for is "energy-charts.info".
- The values are measures of the grid frequency. They contain no personal data.

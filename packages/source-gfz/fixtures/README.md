# The fixtures of the GFZ source

- `kp-20261117T0233Z.json` holds the real bytes of the answer to `https://kp.gfz.de/app/json/?start=2026-11-14T00:00:00Z&end=2026-11-17T02:59:59Z&index=Kp`. The site sent it at 2026-11-17 02:33:04 UTC.
- The answer has 25 values of Kp, from the interval of 2026-11-14 00:00 UTC to the interval of 2026-11-17 00:00 UTC. The largest value is 1.667, so no value is G1 or more. Each status is `pre`.
- The last interval had not ended. The answer gives a value for it, so the value of the current interval comes during the interval.
- `kp-20240510-20240512.json` holds the real bytes of the answer to `https://kp.gfz.de/app/json/?start=2024-05-10T00:00:00Z&end=2024-05-12T23:59:59Z&index=Kp`. The site sent it at 2026-11-17 02:33:04 UTC.
- These are the 24 intervals of the G5 storm of 10 to 12 May 2024. The values go up to 9, and each status is `def`.
- Each answer ends with `]}` and a line break. The answers had `Content-Type: application/json` and no `ETag` and no `Last-Modified`.
- The answers give the license in the field `meta.license`: `CC BY 4.0`. The credit that GFZ asks for is "GFZ German Research Centre for Geosciences".
- The values are measures of the magnetic field of the Earth. They contain no personal data.

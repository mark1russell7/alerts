# The fixtures of the sources of Cloudflare Radar

- `outages-20261118.json` comes from the real answer to `/annotations/outages?dateRange=1d&limit=100&format=json` on 2026-11-18. The fixture keeps the whole answer with no change.
- That answer had one outage with no end: the outage 1749 of the platform Microsoft 365, with 80 origins of Microsoft Azure.
- `anomalies-20261118.json` comes from the real answer to `/traffic_anomalies?dateRange=1d&limit=100&format=json` on 2026-11-18. The fixture keeps the whole answer with no change.
- That answer had one anomaly with no end: a drop of the traffic of the network AS10030 with the status `TP`.
- `outages-chosen-20261118.json` and `anomalies-chosen-20261118.json` keep 5 real records each from the answers of the last 12 weeks, with no change. The records show 3 of the 4 scopes, and each type and each status of an anomaly.
- The chosen outages are an outage of a network, a regional outage with only a GeoNames id and an outage that an authority ordered.
- The other two chosen outages are an outage of a cloud region and an outage with no description.
- The chosen anomalies are the anomalies of 2 cloud regions, 2 networks and 1 country. Two anomalies name an outage of the outage center.

## The answers

- Each answer had the content type `application/json;charset=UTF-8`, a `Last-Modified` date and no `ETag`.
- The header `Cache-Control` was `public, max-age=31536000`, and the header `Age` was present. The fetch does not use the cache time.
- The header `ratelimit-policy` was `q=1200;w=300`. A poll each 10 minutes for each list is far below that limit.
- An unknown token gives the status 401 with the error code 10000. No token gives the status 400 with the error code 9106.

## Facts for the map

- The outage 1749 started on 2026-11-12 and had no end on 2026-11-18. An outage of the outage center can stay open for many days. The map keeps it as Radar gives it.
- Radar names a region of Azure by its service tag, for example `centralfrance`. The map changes it to the name of the region, for example `francecentral`.
- The outage 1744 names only a region by its GeoNames id. Its report has only that area, and no place has a GeoNames code yet. So that report goes to no place.

## License

- The data of Cloudflare Radar is under the license CC BY-NC 4.0. Each report gives the credit in its parameters.
- The records contain no personal data.

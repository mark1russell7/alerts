# The fixtures of the store of shapes

- All the fixtures are real answers of the zone service of the NWS API (`https://api.weather.gov`), from 2026-11-15.
- `zones-KS-county.json` is the answer of `/zones?area=KS&type=county`. The fixture keeps only three rows: `KSC015`, `KSC079` and `KSC173`.
- `zones-KS-forecast.json` is the answer of `/zones?area=KS&type=forecast`. The fixture keeps only three rows: `KSZ069`, `KSZ070` and `KSZ083`.
- The rows of a list have no geometry. The service gives all the zones of a state in one page, with no next page.
- `zone-county-KSC173.json` is the full answer of `/zones/county/KSC173`, the county of Sedgwick. Its outline is one polygon.
- `zone-forecast-KSZ083.json` is the full answer of `/zones/forecast/KSZ083`, the forecast zone of Sedgwick.
- `zone-county-TXC167-parts.json` is the answer of `/zones/county/TXC167`, the county of Galveston, with three parts of its outline.
- The full outline of `TXC167` is a multipolygon with 31 parts and 469 KB. The fixture keeps the three smallest parts: the parts 10, 11 and 20.
- The tests make the other zones of the store from the outline of Sedgwick, with a different code and name.

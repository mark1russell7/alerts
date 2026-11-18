# The fixtures of the EIA-930 source

- `region-data-20261118T1851Z.json` holds the real bytes of one answer of the API of EIA. The API sent it at 2026-11-18 18:51:01 UTC.
- The query asks for the demand (`D`) and the day-ahead forecast (`DF`) of 10 respondents, for the periods `2026-11-18T12` to `2026-11-18T18`.
- The respondents are `CISO`, `ERCO`, `LGEE`, `MISO`, `PJM`, `PNM`, `PSCO`, `SCEG`, `TEX` and `US48`. `TEX` and `US48` are sums of balancing authorities.
- The query is the URL below, with the key removed. The source sends the key in the field `api_key` of the query.

```text
https://api.eia.gov/v2/electricity/rto/region-data/data/?frequency=hourly&data[0]=value&facets[type][]=D&facets[type][]=DF&facets[respondent][]=CISO&facets[respondent][]=ERCO&facets[respondent][]=LGEE&facets[respondent][]=MISO&facets[respondent][]=PJM&facets[respondent][]=PNM&facets[respondent][]=PSCO&facets[respondent][]=SCEG&facets[respondent][]=TEX&facets[respondent][]=US48&start=2026-11-18T12&end=2026-11-18T18&sort[0][column]=period&sort[0][direction]=asc&sort[1][column]=respondent&sort[1][direction]=asc&sort[2][column]=type&sort[2][direction]=asc&offset=0&length=5000
```

## What the answer shows

- The answer has 133 rows. `SCEG` gives no forecast, so its 7 rows of `DF` are not in the answer.
- Each period names the end of its hour in UTC. The period `2026-11-18T18` is the hour from 17:00 to 18:00 UTC.
- Six rows of the demand have the value 0. They are `LGEE` for the periods `T16`, `T17` and `T18`, `PSCO` for `T16` and `T18`, and `PNM` for `T18`. A 0 is an hour that the balancing authority did not send yet.
- In the period `T18`, the demand of `CISO`, `ERCO`, `MISO` and `TEX` equals its forecast. This equality is a placeholder of an hour that is not sent yet.
- The fetch of the tests gives 56 hours of the 8 balancing authorities. The map gives 47 readings and 9 notes: the 6 zeros and the 3 placeholders of balancing authorities.

## Terms

- The values are public data of the U.S. Energy Information Administration. They contain no personal data.
- The reuse policy of EIA asks for a credit with the date of the data. The credit of this fixture is "Source: U.S. Energy Information Administration (Nov 2026)".
- The package changes no value of the answer. The map gives each value as EIA gives it.

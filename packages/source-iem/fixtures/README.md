# The fixtures of the IEM source

- `county-zone-20261108T1930Z.json` is a real answer of the IEM list of the VTEC events in effect, at `valid=2026-11-08T19:30:00Z`.
- `county-zone-20261115T1320Z.json` is a real answer of the same list at 2026-11-15 13:20 UTC, with no `valid` time.
- The requests asked for the national list, with no filter by office or state. The fixtures keep only the rows of Texas and Kansas.
- For a past time, IEM gives the last values of each row. Thus the end of a row can be later than the end in the first message.
- The first list holds the rows of one flash flood warning of a Texas office. The NWS API copies and the IPAWS copies of the same warning are in `../../format-cap/fixtures/pairs/`.

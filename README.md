# FlowPureApp-Maps

Mirror of open postcode-polygon datasets used by the FlowPure mobile app to
draw water-quality maps. Every feature uses a uniform `properties.name`
(the postcode / area code) so the app has one code path across all
countries.

## Countries

| Country | Folder | Files | Count | Source |
|---|---|---|---|---|
| 🇬🇧 United Kingdom | `gb/` | 120 (per area, e.g. `SE.geojson`) | 124 areas | [missinglink/uk-postcode-polygons](https://github.com/missinglink/uk-postcode-polygons) |
| 🇦🇺 Australia | `au/` | 9 (per first digit, e.g. `2.geojson`) | 2,644 POAs | [Offbeatmammal/AU_Postcode_Map](https://github.com/Offbeatmammal/AU_Postcode_Map) — derived from ABS POA 2021 |
| 🇩🇪 Germany | `de/` | 10 (per first digit, e.g. `1.geojson`) | 8,176 PLZ | [yetzt/postleitzahlen](https://github.com/yetzt/postleitzahlen) — derived from OpenStreetMap |
| 🇺🇸 United States | `us/` | 10 (per first digit, e.g. `9.geojson`) | 33,000+ ZCTAs | [OpenDataDE/State-zip-code-GeoJSON](https://github.com/OpenDataDE/State-zip-code-GeoJSON) — derived from US Census TIGER |
| 🇳🇱 Netherlands | `nl/` | 1 (`pc4.geojson`) | 4,068 PC4 | [Opendatasoft georef Netherlands PC4](https://public.opendatasoft.com/explore/dataset/georef-netherlands-postcode-pc4/) — derived from CBS + Kadaster |
| 🇩🇰 Denmark | `dk/` | 1 (`postnumre.geojson`) | 805 postnumre | [Neogeografen/dagi](https://github.com/Neogeografen/dagi) — Danish government open data |

## URL pattern

Raw files live under the `main` branch:

```
https://raw.githubusercontent.com/danielmanusw-svg/FlowPureApp-Maps/main/<country>/<file>.geojson
```

Examples:
- UK SE10 → `…/gb/SE.geojson`
- AU 2000 → `…/au/2.geojson`
- DE 10115 → `…/de/1.geojson`
- US 90210 → `…/us/9.geojson`
- NL 1011 → `…/nl/pc4.geojson`
- DK 2800 → `…/dk/postnumre.geojson`

## Geometry simplification

Every country except GB has its geometry simplified with
[@turf/simplify](https://turfjs.org/docs/#simplify) (tolerance 0.0005° ≈
55 m at the equator) and coordinates rounded to 5 decimal places. The
polygons are still a sharp match for phone-screen display while being
10–50× smaller than the raw sources. GB is mirrored byte-for-byte from
missinglink so the existing map stays visually identical.

## License + attribution

This repository re-packages open datasets. Each source's license carries
through to the data in that folder:

- **GB** — [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/). Contains OS data © Crown copyright and database right.
- **AU** — [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/). © Commonwealth of Australia (Australian Bureau of Statistics) 2021.
- **DE** — [Open Database License (ODbL) 1.0](https://opendatacommons.org/licenses/odbl/1-0/). © OpenStreetMap contributors.
- **US** — Public domain. Source: US Census Bureau TIGER/Line.
- **NL** — [Creative Commons Attribution 4.0 International](https://creativecommons.org/licenses/by/4.0/). © Centraal Bureau voor de Statistiek (CBS) & Basisregistratie Kadaster.
- **DK** — Public open data from the Danish Geodata Agency (Geodatastyrelsen).

If you use this repository directly, please preserve the source links
above.

## Rebuilding

To refresh from the original sources:

```sh
npm install
node scripts/build.mjs all
# or a single country:
node scripts/build.mjs de
```

Requires Node.js 18+.
# Research snapshot

Captured and retrieved on 2026-08-29. This note explains the provenance of the
machine-readable records in
[`data/records/records-2026-08-29.json`](../data/records/records-2026-08-29.json).
The JSON file is the detailed record: each fact carries its value, unit, source
URLs, retrieval date, and provenance label.

## Source register

| Source                                                      | Use in this snapshot                                                                                        | Provenance                                                  |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| https://www.intamin.com/project/spitfire-six-flags-qiddiya/ | Spitfire maximum height, final launch speed, opening date, and the source-scoped inverted-top-hat wording   | `SOURCE_VERIFIED`                                           |
| https://www.sixflagsqiddiyacity.com/en/rides/falcons-flight | Falcons Flight metric facts in metric units                                                                 | `SOURCE_VERIFIED`                                           |
| https://www.intamin.com/category/innovation/                | Intamin corroboration for Falcons Flight and Spitfire facts                                                 | `SOURCE_VERIFIED`                                           |
| https://www.intamin.com/company/about-us/                   | Intamin corroboration for Falcons Flight metric facts                                                       | `SOURCE_VERIFIED`                                           |
| https://sixflagsqiddiyacity.com/en/explore/rides/spitfire   | Official Six Flags Spitfire ride page recorded as corroborating/related context; no metric facts attributed | `SOURCE_VERIFIED` (related source)                          |
| https://rcdb.com/21313.htm                                  | RCDB Spitfire entry recorded as corroborating/related context; no numeric facts copied into this snapshot   | `SOURCE_VERIFIED` (related source)                          |
| https://rcdb.com/21315.htm                                  | Falcons Flight source-native imperial length, height, and speed                                             | `SOURCE_VERIFIED`                                           |
| https://store.astm.org/f2291-26.html                        | ASTM F2291-26 public catalog metadata only                                                                  | `SOURCE_VERIFIED` metadata; `UNKNOWN_UNCONFIGURED` criteria |
| https://nodejs.org/en/about/previous-releases               | Node.js 24 Krypton LTS and LTS production guidance                                                          | `SOURCE_VERIFIED`                                           |

## Interpretation rules

- Spitfire is recorded with 73 m maximum height, 127 km/h final launch speed,
  and 2025-12-31 opening date. The inverted-top-hat record wording remains
  scoped to the cited Intamin page.
- The official Six Flags Spitfire page and RCDB entry are retained as related
  sources; no metric facts are attributed to the park page or copied from RCDB
  into this snapshot.
- Falcons Flight is recorded as 195 m high, 250 km/h, and 4,325 m long in the
  cited metric sources. Its RCDB values remain source-native at 534.8 ft,
  155.3 mph, and 13,943.6 ft. No conversion is asserted in the snapshot.
- The project's 80 m inversion is a `DESIGN_TARGET`. Subtracting the verified
  73 m Spitfire height produces a `DERIVED` 7 m difference. This does not
  validate any generated result or establish a safety or record claim.
- ASTM F2291-26 is represented by active catalog metadata, the 2026-07-15
  update date, and DOI `10.1520/F2291-26`. No proprietary thresholds or
  compliance criteria are stored.

## Related engineering profiles

The project diagnostic values in
[`engineering-limits-v1.json`](../data/profiles/engineering-limits-v1.json)
are editable project limits. The values in
[`train-lsm-v1.json`](../data/profiles/train-lsm-v1.json) are default train
design assumptions. Neither file is a licensed safety standard.

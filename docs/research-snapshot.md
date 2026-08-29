# Research snapshot

Captured and retrieved on 2026-08-29. This note explains the provenance of the
machine-readable records in
[`data/records/records-2026-08-29.json`](../data/records/records-2026-08-29.json).
The JSON file is the detailed record: each fact carries its value, unit, source
URLs, retrieval date, and provenance label. `sourceUrls` is reserved for
sources that actually support the stated value; nearby `relatedSourceUrls`
with a concise note provides context-only URLs without claiming corroboration
or conversion.

## Source register

| Source                                                      | Use in this snapshot                                                                                                                     | Provenance                                                  |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| https://www.intamin.com/project/spitfire-six-flags-qiddiya/ | Spitfire maximum height, final launch speed, opening date, and the source-scoped inverted-top-hat wording                                | `SOURCE_VERIFIED`                                           |
| https://www.sixflagsqiddiyacity.com/en/rides/falcons-flight | Falcons Flight metric facts in metric units                                                                                              | `SOURCE_VERIFIED`                                           |
| https://www.intamin.com/category/innovation/                | Intamin corroboration for Falcons Flight and Spitfire facts                                                                              | `SOURCE_VERIFIED`                                           |
| https://www.intamin.com/company/about-us/                   | Intamin corroboration for Falcons Flight metric facts                                                                                    | `SOURCE_VERIFIED`                                           |
| https://sixflagsqiddiyacity.com/en/explore/rides/spitfire   | Official Six Flags Spitfire ride page recorded as corroborating/related context; no metric facts attributed                              | `SOURCE_VERIFIED` (related source)                          |
| https://rcdb.com/21313.htm                                  | Spitfire RCDB entry shown as `relatedSourceUrls` beside each Spitfire metric fact; no value asserted there                               | `SOURCE_VERIFIED` (related context)                         |
| https://rcdb.com/21315.htm                                  | Falcons Flight RCDB entry shown as `relatedSourceUrls` beside official metric facts and as `sourceUrls` for source-native imperial facts | `SOURCE_VERIFIED`                                           |
| https://store.astm.org/standards/f2291                      | ASTM F2291-26 public catalog metadata only                                                                                               | `SOURCE_VERIFIED` metadata; `UNKNOWN_UNCONFIGURED` criteria |
| https://nodejs.org/en/about/previous-releases               | Node.js 24 Krypton LTS and LTS production guidance                                                                                       | `SOURCE_VERIFIED`                                           |

## Interpretation rules

- Spitfire is recorded with 73 m maximum height, 127 km/h final launch speed,
  and 2025-12-31 opening date. The inverted-top-hat record wording remains
  scoped to the cited Intamin page. Each Spitfire metric fact lists its
  official `sourceUrls` and a nearby `relatedSourceUrls: ["https://rcdb.com/21313.htm"]`
  with a note that no value is asserted from RCDB there.
- Falcons Flight is recorded as 195 m high, 250 km/h, and 4,325 m long in the
  cited metric sources. Each official metric fact lists its official
  `sourceUrls` and a nearby `relatedSourceUrls: ["https://rcdb.com/21315.htm"]`
  with a note that RCDB source-native values are recorded separately and no
  conversion is asserted. RCDB source-native facts invert the pattern: they
  list `sourceUrls: ["https://rcdb.com/21315.htm"]` with nearby official
  `relatedSourceUrls` and the same no-conversion note, plus the stored
  imperial `note`.
- The official Six Flags Spitfire page is retained as `relatedSources` context
  at the record level; no metric facts are attributed to it.
- The project's 80 m inversion is a `DESIGN_TARGET`. Subtracting the verified
  73 m Spitfire height produces a `DERIVED` 7 m difference. This does not
  validate any generated result or establish a safety or record claim.
- ASTM F2291-26 is represented by active catalog metadata, the 2026-07-15
  update date, and DOI `10.1520/F2291-26` at
  `https://store.astm.org/standards/f2291`. No proprietary thresholds or
  compliance criteria are stored. The repository-wide
  `provenanceVocabulary` is
  `SOURCE_VERIFIED, DERIVED, DESIGN_TARGET, PROJECT_ENGINEERING_LIMIT, DESIGN_ASSUMPTION, UNKNOWN_UNCONFIGURED`.

## Related engineering profiles

The project diagnostic values in
[`engineering-limits-v1.json`](../data/profiles/engineering-limits-v1.json)
are editable project limits (`PROJECT_ENGINEERING_LIMIT`). The values in
[`train-lsm-v1.json`](../data/profiles/train-lsm-v1.json) are default train
design assumptions (`DESIGN_ASSUMPTION`). Neither file is a licensed safety
standard.

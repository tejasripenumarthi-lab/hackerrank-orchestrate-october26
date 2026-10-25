# Evaluation report

## Public sample benchmark

The public reference set contains 32 cases and is in `dataset/sample_output.csv`. A measured run of the final source recorded:

| Metric | Measured result |
| --- | ---: |
| Case-level deletion-status accuracy | 21/32 (65.63%) |
| Exact step-sequence accuracy | 2/32 (6.25%) |
| Exact step accuracy at matching positions | 52/193 (26.94%) |
| Field accuracy across the compared steps | 505/1,358 (37.19%) |

The sample benchmark remains limited; these figures should not be taken as evidence that the hidden evaluation score is high. The full-dataset output was generated and structurally checked, but no hidden evaluation labels are available.

## Additional participant-created cases

`code/evaluation/tests.js` adds deterministic checks for:

1. A data-access request is not a deletion authorization.
2. A correction request is not a deletion authorization.
3. Direct deletion requests in English, Spanish, and Japanese are recognized.
4. A message explicitly declining deletion remains non-deletion even if it mentions account deletion.
5. CSV fields with commas and escaped quotes are parsed without losing content.

The suite also checks that the generated submission has 518 sorted rows, valid JSON step arrays, consecutive step numbers, allowed phases, and exactly the required step fields.

## Failures found and improvements made

- The original Python entry point was empty. A dependency-free Node.js entry point and CSV reader were added, with deterministic JSON output and configurable input/output paths.
- Initial public-sample comparison exposed missed deletion verb forms, Japanese deletion language, and unreliable substring matching for identifiers. Intent matching and delimiter-aware identity matching were tightened.
- SQL evidence may store the underlying resource as a JSON payload inside a snapshot row. The SQL reader now parses JSON payload columns and evaluates their resource fields.
- Evidence captured after a case's `audit_at` is excluded. Identity resolution combines current identity rows with historical email, phone, and hash changes.
- The public benchmark still misses expected sample rows and step details. Re-run after further evidence extraction improvements and do not treat sample accuracy as hidden-set accuracy.

## Known limitations

The implementation reads JSON, SQL text, logs, and other text evidence. It does not extract content from image or PDF evidence because no OCR/PDF dependency is installed.

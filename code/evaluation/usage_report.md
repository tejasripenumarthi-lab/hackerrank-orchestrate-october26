# Model and token usage report

The full-dataset prediction pipeline in `code/main.js` is deterministic and uses local Node.js processing only. It makes no model-provider calls.

| Model/provider | Calls | Input tokens | Output tokens | Total tokens | Estimated cost |
| --- | ---: | ---: | ---: | ---: | ---: |
| None (local deterministic processing) | 0 | 0 | 0 | 0 | $0.00 |
| **Overall** | **0** | **0** | **0** | **0** | **$0.00** |

- Requests in the dataset: 518.
- Average tokens per request: 0.
- Estimated average model cost per request: $0.00.
- Model-call token usage and model cost are zero because no model is used; this does not include local CPU time.
- The prediction command was run locally to generate `output.csv`. A later post-edit validation rerun was blocked before execution, so these usage figures describe the code path (which contains no model client), not independently audited provider telemetry.

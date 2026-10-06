# Inference Providers

Configure dedicated application credentials in the ignored `.env` file. Do not
copy personal OpenClaw or Codex credentials. Restart `pnpm dev` after changes.

```dotenv
# Choose one:
OPENAI_API_KEY=
ANTHROPIC_API_KEY=

# Required only when both providers have keys:
PLATFORM_INFERENCE_PROVIDER=

# Optional override; a custom model requires both explicit prices below:
PLATFORM_INFERENCE_MODEL=
PLATFORM_INFERENCE_INPUT_MICRO_USD_PER_MILLION=
PLATFORM_INFERENCE_OUTPUT_MICRO_USD_PER_MILLION=
```

A single non-empty key selects its provider. Empty template entries are ignored.
With both keys, an explicit provider selection is required; there is no automatic
cross-provider content forwarding or failure fallback. The existing
`PLATFORM_OPENAI_API_KEY` / `PLATFORM_ANTHROPIC_API_KEY` aliases are supported and
take precedence over the corresponding standard key names.

Defaults verified against official documentation on 2026-10-06:

| Provider | Pinned model | Input USD / million tokens | Output USD / million tokens |
|---|---|---|---|
| OpenAI | `gpt-4.1-mini-2025-04-14` | 0.40 | 1.60 |
| Anthropic | `claude-haiku-4-5-20251001` | 1.00 | 5.00 |

Sources: [OpenAI model documentation](https://developers.openai.com/api/docs/models/gpt-4.1-mini)
and [Anthropic model documentation](https://platform.claude.com/docs/en/models/haiku-4-5/overview).
These are economical compatibility defaults, not a claim that they are the latest
models. Provider access and future retirement/pricing must be checked by the
operator. Prices can be overridden without code changes. Values in the env price
variables are micro-USD per million tokens: USD 0.40 is `400000`.

The adapters use OpenAI Responses and native Anthropic Messages, respectively,
including tool results, validated structured outputs, bounded retries, explicit
budget reservations, timeout/error normalization and no secrets in public DTOs.
An unavailable or rejected key never turns into a fabricated successful result.
No provider API request is needed merely to read the configuration.

For local troubleshooting, `PLATFORM_INFERENCE_DEBUG=true` enables additional
request/response-shape diagnostics and emits a strong startup warning. It is
rejected outside explicit development/test, including staging and any production
flag. Prompts, response bodies, schema content, tool names/arguments and secrets
are fully redacted; only IDs, byte/count totals and safe failure codes are logged.
Keep this disabled for shared data. A logging failure cannot alter settlement or
trigger another provider request. Normal inference audit records include safe
conversation/orchestration references and the successful tool-call count.

Platform inference is distinct from seller execution. Seller credentials stay in
the Worker's encrypted local store and require explicit configuration, consent
and health validation. Adding a platform key does not silently grant a seller
capability access to it or publish a capability.

Credential-backed acceptance remains pending until the operator supplies keys.
Deterministic transport tests validate the adapters but do not prove real account
access, model availability or provider billing.

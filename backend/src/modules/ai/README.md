# `modules/ai/`

**Owner:** W0 · **Status:** implemented

## Responsibility

Provider-agnostic text and structured generation for our own product features. OpenAI,
Azure OpenAI and Gemini sit behind one `AiProvider` interface.

## Boundaries

- **Callers name a `purpose`, not a prompt.** Prompts live in `prompts.ts`, in source,
  reviewable in a pull request. The prototype forwarded any string a client sent straight
  to OpenAI — an unbounded spend surface and an unbounded content surface.
- **No image or video generation.** Satori renders images deterministically from a
  template (ADR-0002). `generateImage`/`generateVideo` are gone, along with the DALL·E
  calls and the two methods that only ever threw.
- **These are platform credentials, not client ones.** Our OpenAI key, for our features.
  BYO client credentials (ADR-0009) are `modules/publish/`'s problem.
- Structured output goes through a Zod schema. Callers get parsed data or an error, never
  a string to hand-parse.

## Files

| File | What it owns |
|------|--------------|
| `types.ts` | `AiProvider`, `AiPurpose`, request and result shapes |
| `prompts.ts` | One template per purpose, with required-input validation |
| `parse.ts` | Code-fence stripping, JSON parsing, schema validation |
| `openai.provider.ts` | OpenAI and Azure OpenAI |
| `gemini.provider.ts` | Google Gemini |
| `index.ts` | Provider selection, caching, `generateText` / `generateStructured` |

## Notes

**Azure routes by URL.** The deployment name is in the `baseURL`, so `model` must be
omitted from the request body. One class covers both because only the routing differs.

**Gemini gets a real system instruction.** The prototype concatenated context into the
user message, which puts user-supplied text at the same level as the instructions — the
shape prompt injection needs. It now uses `systemInstruction`.

**Provider errors are not exposed.** Upstream error bodies echo the request, and the
request carries brand content. `ExternalServiceError` logs the cause and tells the client
nothing.

## Adding a purpose

Add the case to `AiPurpose`, add the template to `PROMPTS` with its required inputs, and
add a test asserting the prompt renders and that missing input is rejected. The compiler
will find the `PROMPTS` record for you — it is exhaustive by type.

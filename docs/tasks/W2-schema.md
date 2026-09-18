# W2 — Schema, migration, seed

**Depends on:** W1 · **Blocks:** W3, W4, W6, W7, W9

**Read first:** [02 — Data model](../02-data-model.md), [ADR-0008](../adr/0008-brand-first-class.md)

> **You own `schema.prisma`.** No other workstream edits it. Later schema changes are
> requested through this workstream's owner.

## Goal

The complete v1 domain model, one init migration, and a seed rich enough that every other
workstream can develop against real data.

## Scope

### Schema

Implement every entity in [02](../02-data-model.md):

- Identity: `User`, `Workspace`, `Membership`, `Role`
- Taxonomy: `BusinessCategory` (self-referencing tree, `priors` JSON)
- Brand: `Brand`, `PersonaLayer`, `Asset`
- Social: `SocialAccount` (incl. `credentialId`), `Platform`, `AccountStatus`
- Credentials: `PlatformCredential`, `CredentialAccessLog`, `CredentialStatus` — full
  definition in [10](../10-credentials-and-security.md)
- Templates: `Template`, `TemplateCategoryTag`, `TemplateKind`, `TemplateStatus`, `AspectRatio`
- Trends: `Trend`, `TrendSignal`, `TrendCategoryScore`
- Posts: `Post`, `PostTarget`, `Rendition`, `PostStatus`, `TargetStatus`, `MediaType`,
  `ScheduleSource`
- Outcomes: `ShortLink`, `LinkClick`, `PostMetric`
- Telemetry: `AiGeneration`

Follow the conventions section: UUID keys, `@@map` snake_case, indexes as specified.

### Token and secret encryption

Wire W0's crypto module into Prisma (client extension or middleware) so
`SocialAccount.accessToken`, `refreshToken`, `tokenSecret`, and
`PlatformCredential.appSecret` / `systemUserToken` are **encrypted at rest and
transparently decrypted on read.** Plaintext must never reach the database.

W6 extends this to envelope encryption with per-workspace DEKs
([10](../10-credentials-and-security.md)); leave the ciphertext format versioned so that
upgrade is incremental rather than a rewrite.

### Zod schemas

For every JSON column — `voiceGuide`, `palette`, `typography`, `goals`, `slotSchema`,
`layout`, `platformMeta`, `priors`, `metrics` — colocated with its module and exported.
These are the contracts other workstreams code against.

### Migration

Single `0001_init`.

### Seed (`prisma/seed.ts`)

This is not optional polish — it's how every other agent works without hand-building fixtures.

1. **Business category taxonomy** — ~8 parents, ~40–60 leaves, small-business oriented
   (see [Q8](../09-open-questions.md)), with hand-written `priors`.
2. **8–12 templates** across the archetypes in [05](../05-template-engine.md), with valid
   `slotSchema` and `layout` JSON and category tags. Coordinate the `layout` shape with W4.
3. **Two workspaces — Rise & Shore and TaxDedux** ([ADR-0010](../adr/0010-workspace-per-client.md)),
   each with its own brand, palette, typography, voice guide, and `timezone`. Not two
   brands in one workspace.
4. **Sample posts with metrics and clicks** — needed so W7/W8 can build analytics and
   scoring before real publishing exists. Make the two brands' histories *different* so
   recommendation differences are visible, and **spread posts across dayparts and
   weekday/weekend** so send-time learning has something to score.

Seed must be idempotent and re-runnable.

## Acceptance criteria

- [ ] `prisma migrate dev` applies cleanly from an empty database
- [ ] `npm run db:seed` is idempotent
- [ ] Encryption round-trips; the raw DB column is unreadable ciphertext
- [ ] Zod schemas exported and unit-tested for every JSON column
- [ ] Templates and trends carry no `workspaceId` (global); everything user-owned does
- [ ] `docs/02-data-model.md` updated to match anything that changed during implementation

## Notes

Deviations from the doc are fine if justified — but update the doc in the same PR. It's
the contract other workstreams read.

# Agent task briefs

One brief per workstream from the [phase 1 roadmap](../04-phase-1-roadmap.md). Each is
sized for a single agent session.

## How to use these

1. Read [`docs/README.md`](../README.md) and the docs listed under **Read first** in your brief.
2. Check the brief's **Depends on** — do not start if a dependency is unmerged.
3. Work only inside your brief's **Files you own**. If you need to change a file owned by
   another workstream, stop and flag it.
4. Update the relevant doc in the same PR as the code.
5. Tick the brief's acceptance criteria in the PR description.

## Ground rules

- **`schema.prisma` is owned by W2 only.** Schema changes serialize through that owner —
  never edit it from two sessions. W2 is complete;
  [W10](./W10-usage-metering.md) holds this ownership for its migration, and no other
  session may edit the file while W10 is open.
- **W0 and W1 must merge before anything else.** Everything downstream assumes the new
  structure.
- Tests are part of done, not a follow-up.
- Never commit secrets. Add env vars to `.env.example` with a description, never a value.
- Don't invent success metric targets — the spec is explicit about this.

## Index

| Brief | Workstream | Depends on |
|-------|-----------|------------|
| [W0](./W0-foundation.md) | Foundation & hygiene | — |
| [W1](./W1-teardown.md) | Teardown | — |
| [W2](./W2-schema.md) | Schema, migration, seed | W1 |
| [W3](./W3-identity-brand.md) | Identity, tenancy, brand kit | W2 |
| [W4](./W4-template-engine.md) | Template engine & rendering | W2 |
| [W5](./W5-composer-ui.md) | Composer UI | W3, W4 |
| [W6](./W6-publishing.md) | Platform integrations & publishing | W2, W3 |
| [W7](./W7-outcome-spine.md) | Outcome spine | W2, W6 |
| [W8](./W8-feedback-loop.md) | Feedback loop v0 | W4, W7 |
| [W9](./W9-trend-engine.md) | Trend engine v0 | W2 |
| [W10](./W10-usage-metering.md) | Usage metering & AI spend fuse | W2, W3 |

# ADR-0005 — v1 publishing targets: Instagram, Facebook, Threads, X

**Date:** 2026-09-17 · **Status:** Accepted

## Context

The spec lists TaxDedux on Instagram, TikTok, LinkedIn, and X, with Rise & Shore's list
unconfirmed. Its P0 requires publishing to the platforms those accounts use, while P1
confusingly lists TikTok and LinkedIn publishing again.

Approval friction differs sharply: Meta requires business verification and app review;
TikTok requires its own review; LinkedIn is comparatively light; X requires no review but
has real API cost. The prototype already publishes to X and LinkedIn.

## Decision

v1 targets **Instagram, Facebook, Threads, and X.** LinkedIn and TikTok move to P1 behind
the same `PlatformAdapter` interface.

Implementation order: X first (no approval gate), then Facebook, Instagram, Threads.

Export/download is P0 for all platforms, supported or not.

## Rationale

- Instagram, Facebook, and Threads share Meta developer infrastructure — **two approval
  tracks instead of four.**
- X ships first and proves the adapter interface end to end while Meta review is pending.
- Export/download keeps the product valuable throughout the approval wait, and de-risks
  the entire integration track.
- The adapter interface makes LinkedIn and TikTok additive: a new file, not a pipeline
  change.

## Consequences

- **Meta app review is the critical path.** The developer account and business
  verification must start in week 1, before any integration code.
- Instagram publishing requires Business/Creator accounts linked to a Facebook Page —
  an onboarding pre-flight check is needed, not a connect-time surprise.
- The X API tier is an unresolved budget decision ([Q3](../09-open-questions.md)).
- If Rise & Shore depends on TikTok or LinkedIn ([Q1](../09-open-questions.md)), scope
  changes and a third approval track opens.
- Instagram's caption link behavior weakens the click-tracking spine there
  ([Q5](../09-open-questions.md)).

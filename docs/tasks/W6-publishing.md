# W6 — Credentials, platform integrations & publishing

**Depends on:** W2, W3 · **Blocks:** W7

**Read first:** [10 — Credentials & security](../10-credentials-and-security.md),
[08 — Platform integrations](../08-platform-integrations.md),
[ADR-0009](../adr/0009-byo-platform-credentials.md), [ADR-0005](../adr/0005-v1-platform-targets.md)

> ## ⚠️ Read ADR-0009 before writing a single adapter
> **Clients bring their own platform app credentials.** Every `PlatformAdapter` method
> takes a `ResolvedCredential`; nothing reads app credentials from the environment.
> Retrofitting this means touching every signature and every call site — get it right in
> step 2.

> **Also start in parallel, no code needed:** the minimal **Buzzalicious read-only app**
> for trend collection (W9 step 7). Light scopes, easier review, blocks nothing.

## Goal

Onboard and validate a client's own platform credentials, then publish and schedule to X,
Instagram, Facebook, and Threads behind one adapter interface, with durable jobs and honest
partial-failure handling.

## Build order

1. **Credential foundation** ([10](../10-credentials-and-security.md))
   - `PlatformCredential` + `CredentialAccessLog` (migration coordinated with W2)
   - Envelope encryption: per-workspace DEK wrapped by a KEK, extending W0's crypto module
   - `CredentialResolver` — brand → workspace → `PLATFORM_APP`. **The only path to
     credentials.**
2. `PlatformAdapter` interface + `PlatformSpec` registry, **taking `ResolvedCredential`**
3. **Credential onboarding UI** — write-only secret fields, masked display, and the
   capability pre-flight report in plain language
4. **X adapter** — `introspect`, OAuth connect, media upload, publish, metrics. No approval
   gate, so it proves the interface end to end. Reshape the prototype's `twitter.service.ts`.
5. pg-boss publish pipeline: **one job per `PostTarget`**, retry with backoff, and the
   error taxonomy from [08](../08-platform-integrations.md)
6. Proactive token refresh cron and daily `validate()` sweep, keyed by `credentialId`
7. Export/download fallback (coordinate with W5 — don't duplicate)
8. Meta adapters: **Facebook first** (simplest), then Instagram, then Threads
9. Scheduling UI and calendar — schedule, reschedule, cancel
10. Quota, credential health, and account health in the UI
11. Rotation / revocation / offboarding runbooks

## Critical details

- **Signed OAuth `state` carrying `credentialId`.** The callback cannot know which app
  secret to use for the code exchange without it. Unsigned state is a CSRF vector that now
  also selects whose secret gets used.
- **`SocialAccount.credentialId` is load-bearing.** A token is only refreshable by the app
  that minted it.
- **Jobs carry `credentialId`, never a secret.** Resolve and decrypt at execution time.
- **Capability pre-flight is the highest-value UX here.** A client's app may be approved
  for narrower permissions than we need; without introspection that surfaces as a
  mysterious publish failure weeks later.
- **Per-target jobs.** One platform failing must never block the others. With four
  targets, partial failure is the common case — hence `PARTIALLY_PUBLISHED`.
- **Idempotency.** A retry must never double-post. Check for an existing `externalPostId`
  before re-attempting.
- **Instagram pre-flight.** Publishing requires a Business/Creator account linked to a
  Facebook Page. Detect and explain this during onboarding, not at connect time.
- **Media URLs.** Meta fetches media by URL — renditions need signed, time-limited public
  URLs from W0's storage driver.
- **`connect()` returns an array.** One Meta authorization can yield several destinations.
- **Typed errors.** Distinguish credential-level from account-level failures: one client
  action can fix many broken accounts at once.
- **The AI spend ceiling must never gate delivery.** W10's fuse
  ([ADR-0011](../adr/0011-usage-metering-spine.md)) refuses *generation* when a workspace is
  over its monthly AI budget. A post that already exists has already been paid for, so a
  publish job must not consult the budget — do not call `assertAiBudgetAvailable` anywhere
  in the publish path, and do not let a `BudgetExceededError` from an unrelated layer fail a
  target. Emit `POST_PUBLISHED` through `emitUsage` with an **attempt-independent**
  idempotency key (`publish:{postTargetId}`, never `:{attempt}`) so a retry that finally
  succeeds counts as one billable post. W10 could only test this as a seam because W6 did
  not exist; this is the line that makes it real.

## Acceptance criteria

PR 1 (the spine: schema, credentials, OAuth, X, pipeline, jobs) — landed:

- [x] A credential is stored encrypted; **no API path returns the secret**, and no log line
      contains it (test this explicitly)
- [x] Pre-flight produces an accurate capability report, including the `INSUFFICIENT` case
- [x] OAuth connect completes using a client's app credentials, with signed state
- [x] A post publishes to X with media and records `externalPostId` + URL
- [x] Scheduling works; a scheduled post publishes at the right time after a restart —
      verified structurally rather than by restarting a dyno: there is no in-memory timer,
      so due-ness is recomputed from `scheduledFor`/`nextAttemptAt` in Postgres by a sweep
      that runs on every boot, and pg-boss's queue is Postgres-backed too
- [x] A forced failure on one target leaves others published and the post `PARTIALLY_PUBLISHED`
- [x] Retry does not double-post (integration test)
- [x] A scheduled post for a workspace **over its AI ceiling** still publishes, end to end —
      the case W10 could only assert at the seam

PR 2 (Meta family, health sweeps, Settings → Connections):

- [ ] Expired tokens are refreshed via the correct credential; revoked accounts surface as
      `REVOKED` — the adapter `refresh`/`validate` contract and the `REVOKED` → `BLOCKED`
      publish path exist and are tested; the periodic sweep that calls them does not yet
- [ ] Revoking a credential halts its jobs and marks dependent accounts
- [ ] Meta adapters are complete and tested against faked responses

## Notes

Verify every platform-specific claim against current official docs — the docs here
intentionally avoid pinning volatile details. Meta **system user** token behavior and each
platform's terms on third parties holding app secrets ([Q16](../09-open-questions.md)) both
need confirming.

Build against faked adapter responses so Meta work is testable without live credentials.

# Runbook — client offboarding

**Trigger:** a client is leaving and their credentials and tokens must be removed.

Offboarding is the only procedure here that **destroys data**. Work through it in order and
confirm each step, because several of them cannot be undone and one of them (step 4) cannot
be done at all once the earlier ones have run.

## Blast radius

Everything the client connected stops working. Published posts remain published — we cannot
and should not remove them. Historical metrics and click data are addressed in step 5.

## Steps

1. **Confirm the request in writing**, from someone authorised on the client's side. An
   offboarding triggered by a forwarded email is a support incident waiting to happen.

2. **Take the audit export first.** `CredentialAccessLog` is what answers "who used this
   credential and when", and it is the artifact an incident review or a dispute needs. Once
   the credential rows are gone, the log is much harder to interpret. Export before you
   delete, not after.

3. **Revoke every credential** in the workspace, following
   [credential-revocation.md](./credential-revocation.md). This halts jobs and blocks queued
   posts cleanly, rather than leaving them to fail one at a time against a dead token.

4. **Attempt platform-side token revocation.** Do this *before* deleting the stored tokens —
   revoking at the platform requires presenting the token, so once it is deleted the option
   is gone. Best-effort: some platforms do not offer it, and a failure here is recorded but
   not blocking.

5. **Delete credentials and tokens.** Stored secrets and every `SocialAccount` token column.
   Retain the access log for the agreed audit window — see
   [10 — Credentials & security](../10-credentials-and-security.md). The retention period is
   still an open item in that document; until it is settled, retain and ask.

6. **Confirm deletion to the client in writing**, naming what was deleted and what was
   retained and why. This is a contractual expectation under a data processing agreement,
   not a courtesy.

## Verify

- No `PlatformCredential` rows remain for the workspace.
- No `SocialAccount` row in the workspace holds a non-null token column.
- The access log export exists somewhere outside the application database.

## Known gap

There is no one-click offboarding action, and deliberately so: an irreversible cascade
across a whole workspace behind a single button is the kind of thing that gets clicked by
accident. Steps 4 and 5 are currently performed by an engineer with database access. If
offboarding becomes routine, build it as an explicit, typed-confirmation flow rather than a
button next to the ordinary settings.

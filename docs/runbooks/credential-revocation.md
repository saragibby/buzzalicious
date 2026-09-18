# Runbook — credential revocation

**Trigger:** a platform app credential must stop working immediately. Usually a leaked
secret, a client dispute, or a platform telling us the app has been restricted.

## Blast radius — read this before you act

Revoking is **workspace-scoped in authority and brand-scoped in effect**. One credential
can mint accounts across several brands, so revoking it stops publishing for all of them at
once.

Three things happen, in this order:

1. The `PlatformCredential` moves to `REVOKED` and records the reason.
2. Every `SocialAccount` minted from it moves to `REVOKED`.
3. Every `PostTarget` queued against those accounts moves to **`BLOCKED`**, not `FAILED`.

Step 3 is the one people get wrong. `BLOCKED` means *the post is fine, the route is not* —
it does not consume a retry, it is not counted as a publishing failure, and it comes back
when the account is reconnected. Marking them `FAILED` would burn the retry budget and
present a user with a wall of errors about posts that were never attempted.

**Nothing already published is touched.** Revocation does not delete posts and cannot
un-publish anything. If content needs removing from a platform, that is done at the
platform, by the client.

## Steps

1. **Settings → Connections**, in the affected workspace.
2. Find the app under **Platform apps**. Click **Revoke**. Read the confirmation panel: it
   names how many accounts and queued posts this will stop. If that number is a surprise,
   stop and find out why before continuing.
3. Confirm. The page reports what it actually stopped.

Equivalently, for a support engineer without UI access:

```
POST /api/workspaces/:workspaceId/credentials/:credentialId/revoke
{ "reason": "Secret disclosed in a support ticket, 2026-03-04" }
```

Requires workspace **ADMIN**. The `reason` is shown to the client in the UI, so write it
for them, not for us.

4. **Revoke at the platform as well.** This is a separate act and the product cannot do it
   for you. Marking a credential `REVOKED` here stops *us* using it; it does nothing to a
   secret someone else now has. For a leaked secret, rotate or delete the app credentials
   in the Meta App Dashboard / X developer portal immediately.

## Verify

- Settings → Connections shows the credential as **Revoked** and each dependent account as
  **Access revoked**.
- The response body's `accountsMarked` and `targetsBlocked` are non-zero if you expected
  them to be. `accountsMarked: 0` on a credential that visibly has accounts means the
  revocation did not reach them — escalate rather than retrying, because a retry will
  report zero again.
- Scheduled posts for those accounts show as blocked, not failed.

## Recovery

There is no un-revoke. The path back is to register a fresh app credential and reconnect
each account through OAuth — `Settings → Connections`, then connect per platform. The
previously blocked targets do **not** resume automatically; they must be rescheduled, which
is deliberate: a post written for last Tuesday should not silently go out on Friday.

## Known gap

Revocation is not currently exposed for the shared Buzzalicious platform app, because a
credential row does not exist for it. Disabling the platform app is a configuration change
and a deploy, not a runbook step.

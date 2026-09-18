# Runbook — credential rotation

**Trigger:** a client rotated their platform app secret on schedule, or a secret was
exposed and must be replaced without an outage.

Rotation is the *calm* version of [revocation](./credential-revocation.md). If the old
secret is known to be compromised and you need it dead this minute, revoke first and rotate
afterwards; the cost is an outage until accounts reconnect.

## What actually breaks when a secret changes

This is the part that surprises people, and it is why the order below matters.

**Existing access tokens usually keep working.** An OAuth access token is already minted;
the app secret is not re-checked on every publish. So posting continues after a rotation
and everything looks fine.

**Refresh is what breaks.** The refresh exchange presents the app secret. With a stale
secret stored, refresh fails silently in the background, and the account dies whenever its
current token happens to expire — up to sixty days later for a long-lived Meta token, with
no deploy or config change to correlate it against.

So: **never conclude a rotation worked because publishing still works.** Validate.

## Steps

1. Get the new secret from the client through their preferred secure channel. Do not accept
   it in an email or a ticket body; if it arrives that way, treat the rotation as a leak
   and rotate again afterwards.
2. **Settings → Connections → Platform apps**, or
   `PATCH /api/workspaces/:workspaceId/credentials/:credentialId` with the new secret.
   Secret fields are write-only: the UI never displays the stored value, and the API never
   returns it. You cannot check your work by reading it back, by design.
3. **Re-run pre-flight.**
   `POST /api/workspaces/:workspaceId/credentials/:credentialId/preflight`. This exercises
   the new secret against the platform and returns a plain-language capability report. A
   green pre-flight is the evidence that the rotation landed.
4. **Force a health check** rather than waiting up to an hour for the sweep. Restarting the
   worker runs the sweep at the next hour boundary; to check immediately, use the Connections
   page and confirm each dependent account's **Last checked** timestamp moves.

## Verify

- Pre-flight reports the capabilities you expect, including `publish_*`.
- Every dependent account still shows **Connected** after the next health sweep.
- No account has moved to **Token expired** or **Not working**.

If an account shows `INSUFFICIENT` after rotation, the new app registration is missing a
permission the old one had — most often a `publish_*` scope. Missing *insights* scopes do
not produce `INSUFFICIENT`; Meta reviews `read_insights` on a separate and slower track, and
an account that can post but cannot read metrics is degraded, not broken.

## If the client rotated without telling us

The symptom is refresh failures with an otherwise healthy-looking account, typically
surfacing as a Meta error code 190 or an X `invalid_client`. The Connections page shows
**Token expired** and the hourly sweep keeps failing to fix it. Ask the client whether they
rotated, then follow the steps above.

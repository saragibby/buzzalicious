# Runbook — account health and the hourly sweep

**Trigger:** connected accounts are failing, or you suspect the health sweep is not running.

## What the sweep is for

A platform token has a lifetime. A Meta long-lived page token is roughly sixty days; an X
OAuth2 token is hours. Nothing about a healthy-looking system tells you a token is about to
die, which makes this the classic failure that presents as *everything stopped at once, and
we changed nothing*.

The sweep runs hourly (`account.health`, cron `0 * * * *`) and, for each due account:

- **refreshes** it if `expiresAt` is inside the next **7 days**, or
- **validates** it if it has not been checked for **24 hours**.

Hourly against a seven-day window means roughly 168 chances to refresh before expiry, which
survives the worker being down for a day.

`REVOKED` accounts are excluded. They cannot be refreshed, and retrying them hourly forever
would be a steady stream of guaranteed-failing platform calls.

## Design properties worth knowing before you debug it

**`validate()` returns a verdict, it does not throw.** An unhealthy account is a normal
result. If validation threw, the first bad account would abandon the rest of the sweep —
which is exactly the failure that makes one dead account look like a total outage.

**Failures are caught per account.** One platform being down does not stop the others.

**The sweep is idempotent.** Every write it makes is a status or a timestamp, never an
increment, so re-running it is always safe. If in doubt, run it again.

**Reads are cross-tenant, writes are not.** The sweep is the only thing in the system that
reads accounts across every workspace, and it does so through a deliberately narrow reader
that returns identifiers and status only. Before it writes anything it re-scopes to the
owning brand. That is the property to preserve if you ever change this file.

## Diagnosing "posts stopped going out"

1. **Settings → Connections** for the affected brand. The banner at the top names how many
   accounts cannot publish.
2. Read the **status**, not just the colour. The four cases need different actions:
   - **Token expired** — the sweep should fix this. Check **Last checked**: if it is older
     than an hour, the sweep is not running (go to the next section). If it is recent and
     the account is still expired, refresh is failing — usually a stale app secret, so see
     [credential-rotation.md](./credential-rotation.md).
   - **Access revoked** — someone removed the app at the platform end. Only a reconnect
     fixes it; the sweep will never recover it and does not try.
   - **Not working** — read the recorded error. Meta codes are decoded in
     `meta.errors.ts`; the common ones are 190 (token invalid), 200 (missing permission),
     368 (policy block) and 100 (bad parameter). They all arrive as HTTP 400, which is why
     we classify on the Graph code and not the status.
   - **Disconnected** — never completed a connect, or was disconnected deliberately.
3. If a whole group of accounts died together, look at **Using** on the cards. A shared app
   registration is almost always the single cause behind several simultaneous failures.

## Checking the sweep is actually running

The handler logs at `info` on **every** run, including when nothing was due:

```
Account health sweep complete  { checked, refreshed, revoked, failed }
```

That is deliberate. "The sweep ran and found nothing" and "the sweep has not run since
Tuesday" are the two states worth distinguishing, and silence cannot tell them apart. So:

- **No log line in the last hour** → the worker dyno is not running, or pg-boss did not
  schedule. On Heroku confirm the worker dyno is up and **not sleeping** (ADR: the worker
  must not sleep).
- **Log line present, `failed` high** → platform-side. Check the recorded `lastError` on the
  affected accounts.
- **Log line present, `checked: 0` repeatedly** → nothing is due, which is normal on a small
  install. Cross-check against an account's **Last checked** in the UI; if any is older than
  24 hours, the due query is wrong and this is a bug, not an operational issue.

## Forcing a check

There is no manual "check now" button. Restarting the worker dyno causes the sweep to run at
the next hour boundary. This is a known gap: a per-account **Check now** control on the
Connections page would be the right fix and is not built.

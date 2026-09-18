# Runbooks

Operational procedures for things that go wrong in production, written to be followed by
someone who did not build the system and is reading them at an unsociable hour.

Each one states the **trigger**, the **blast radius**, the **steps**, and how to **verify**
it worked. Where a step cannot yet be done from the UI, the runbook says so explicitly
rather than describing a button that does not exist.

| Runbook | When you need it |
|---------|------------------|
| [`credential-rotation.md`](./credential-rotation.md) | A client rotated their platform app secret, or one leaked |
| [`credential-revocation.md`](./credential-revocation.md) | A credential must stop working now |
| [`offboarding.md`](./offboarding.md) | A client is leaving |
| [`account-health.md`](./account-health.md) | Accounts are failing, or the hourly sweep is not running |
| [`caption-limits.md`](./caption-limits.md) | A caption was rejected, or a limit needs changing |

## The one rule that applies to all of them

**Never paste a credential value into a ticket, a chat message, a log line, or a shell
history.** Every procedure here is written to avoid ever having the plaintext in hand. If a
step seems to require it, the step is wrong — see
[10 — Credentials & security](../10-credentials-and-security.md).

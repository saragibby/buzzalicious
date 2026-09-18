# Runbook — caption limits

**Trigger:** a user says a caption was rejected that should have fitted, or a platform limit
needs changing.

## The single source of truth

`backend/src/modules/template/platform-spec.ts`. `PLATFORM_SPECS` holds the limit and the
counting unit; `measureCaption` does the counting. **Nothing else may compare a caption
against a limit.** Adapters call the shared helper; they do not implement their own check.

This rule exists because ignoring it caused a real, ordinary-case bug. The X adapter once
gated on `input.caption.length` while the composer counted X's way. A 314-character caption
containing a link **weighs 233** to X, because every URL bills a flat 23 characters through
`t.co` regardless of its real length. The composer said "233/280, fits", the user scheduled
it, and the publisher rejected the identical text when the job ran. It fired on the most
ordinary post this product makes — one with a link in it.

The four platforms each count differently, so reimplementing locally reproduces that bug
rather than avoiding it:

| Platform | Limit | Unit | Verified? |
|---|---|---|---|
| X | 280 | X-weighted (URLs bill a flat 23) | yes |
| Instagram | 2,200 | code points (an emoji is 1) | yes |
| Threads | 500 | **UTF-8 bytes** (an emoji is 4) | yes |
| Facebook | 5,000 | code points | **no — see below** |

## Where the check happens

**Two places, on purpose.**

1. **Pre-flight, at schedule time** (`caption-gate.ts`, called from `scheduleTargets`). This
   is the one users experience. Rejecting at schedule time means the person who wrote the
   caption is still looking at it.
2. **Inside the adapter, at publish time.** A backstop. It should never fire; if it does,
   something reached the publisher without going through scheduling.

If a user reports an over-length failure appearing in their *calendar* rather than in the
composer, the pre-flight gate was bypassed — that is a bug, not a limit problem.

The gate measures the **effective** caption: the per-target override if there is one, the
base caption otherwise. An override of `null` inherits the base; an override of `''`
deliberately does not — it is an empty caption and gates as empty.

## Facebook's 5,000 is ours, not Facebook's

This is the one number in the table that is not a platform limit, and the error message says
so rather than attributing it to Facebook.

Facebook's real `message` limit is widely cited as 63,206 characters, but that figure is
**absent from the v23.0 Page Feed documentation**, so it is not something we can point at.
5,000 is a deliberate conservative floor: long enough that no realistic social caption hits
it, short enough that a runaway template or a bad generation is caught here rather than
becoming a Graph API error at publish time.

The row carries `captionLimitVerified: false` so the value is visibly a guess.

### Raising it

If a real user legitimately needs more than 5,000 characters:

1. Find a **current, official** source for the true limit — Graph API reference for the
   endpoint in use, not a blog post and not a Stack Overflow answer.
2. Update `captionMaxLength` in `PLATFORM_SPECS` and set `captionLimitVerified: true`,
   citing the source in the comment beside it as the other rows do.
3. Update the table above.
4. Nothing else changes. The limit has one home, which is the entire point of this runbook.

If no official source can be found, raise the number but leave `captionLimitVerified: false`
and record why in the comment. An honest guess that is labelled a guess is fine; a guess
wearing the authority of a verified limit is not.

## Changing a counting unit

Don't, unless the platform changed. The units were each established from a platform
statement — Threads' documentation says in terms "Emojis are counted as the number of UTF-8
bytes", X publishes its weighting rules. A unit change alters what fits for every existing
user, so it needs the same evidence bar as step 1 above, plus a regression test pinned **in
the gap** between the old and new counts. A test that is simply over both limits passes
under either implementation and proves nothing.

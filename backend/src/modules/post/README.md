# `modules/post/`

**Owner:** W5 · **Status:** built (M3)

## Responsibility

The thing the composer is editing: a draft post, its slot values, its captions, and the
export bundle a user downloads when no platform is connected.

## Why this module exists

The plan's module table did not name one. It was written before it was clear where a
`Post` comes from — `publish/` owns getting a finished post *onto* a network, and
`template/` owns what a template *is*, but neither owns the half-finished row a user is
typing into. M3 ships the entire loop with no platform API involved, so that row has to
exist and be owned before any adapter does.

## Boundaries

- **Nothing here decides anything about publishing.** It writes `PostTarget` rows in
  `DRAFT` because that is where a per-platform caption lives, and it never sets a status
  beyond `DRAFT`, never touches `socialAccountId`, and never resolves a credential. W6
  owns everything past that point and should consume these rows rather than create its own.
- **Export is here, not in `publish/`.** W6's brief lists "export/download fallback" as
  step 7 with a note to coordinate with W5 — `streamExportBundle` is that, and W6 should
  call it rather than build a second one.
- Every function takes a `ScopedDb`. The one exception is `streamExportBundle`, which also
  takes the unscoped client because `renderPost` needs it; the scope check runs first and
  throws before the unscoped client is reached. See the comment on that function.
- Caption generation goes through `ai/metered`, never `ai/` directly, so the workspace's
  spend ceiling applies (ADR-0011).

## Files

| File | Owns |
|------|------|
| `post.schemas.ts` | Request contracts, and the `{{link}}` marker's spelling |
| `post.service.ts` | Draft CRUD, target selection, caption overrides, readiness |
| `caption.service.ts` | Metered AI caption drafting from the brand voice + slot `aiHint`s |
| `export.service.ts` | The streamed zip: renditions, captions, and a README |

## The `{{link}}` marker

`LINK_MARKER` in `post.schemas.ts` is the single definition. A user places it in copy and
W7 replaces it with a tracked short link at publish time. It matters that the composer,
the AI prompt, the export README and eventually W7 all agree on the exact spelling — a
prompt that emits `{link}` against a UI looking for `{{link}}` fails silently, and the
failure is invisible until nobody's clicks are attributed.

`enforceLinkMarker` normalises the variants models reach for and collapses duplicates,
because two markers in one caption would split one post's clicks across two short links.

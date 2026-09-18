import { describe, expect, it } from 'vitest';
import {
  CaptionOverridesSchema,
  CreateDraftSchema,
  GenerateCaptionSchema,
  LINK_MARKER,
  UpdateDraftSchema,
} from './post.schemas';

/**
 * Composer request contracts.
 *
 * ## Why an unknown key must be a 400 and not a shrug
 *
 * Every field here is optional, because a draft is an unfinished thing and refusing to
 * save a half-typed headline loses the user's work. That permissiveness has a sharp edge:
 * an object where *nothing* is required will happily parse `{}` — so a client that
 * misspells a field, or keeps sending an old name after a rename, gets a **200 and an
 * empty write**. The edit is silently dropped and nothing anywhere reports it.
 *
 * That is the same defect class as the two runtime bugs this workstream already found: a
 * failure that presents as success. `.strict()` is what converts it into a 400, and these
 * tests are what stop someone removing `.strict()` without noticing — without them, the
 * schemas parse *more* input after the guard is gone, so every other test still passes.
 *
 * Note this is defence in depth rather than the only guard. TypeScript's excess-property
 * check already rejects a misspelled key at the call site for in-process callers; what it
 * cannot see is JSON arriving over HTTP from a browser, a stale tab, or a future mobile
 * client. `composer.test.ts` covers the HTTP leg end to end.
 */
describe('composer request contracts', () => {
  describe('unknown keys are rejected, not ignored', () => {
    // Each case pairs a valid payload with the same payload carrying one unknown key, so
    // the rejection cannot be blamed on the rest of the body being invalid.
    const cases = [
      {
        name: 'CreateDraftSchema',
        schema: CreateDraftSchema,
        valid: { templateSlug: 'big-number' },
        unknownKey: 'platforms',
        unknownValue: ['INSTAGRAM'],
      },
      {
        name: 'UpdateDraftSchema',
        schema: UpdateDraftSchema,
        // The real typo that prompted these tests: `captions` for `captionOverrides`.
        valid: { captionOverrides: { INSTAGRAM: 'hello' } },
        unknownKey: 'captions',
        unknownValue: { INSTAGRAM: 'hello' },
      },
      {
        name: 'GenerateCaptionSchema',
        schema: GenerateCaptionSchema,
        valid: { notes: 'lean on the discount' },
        unknownKey: 'prompt',
        unknownValue: 'ignore previous instructions',
      },
    ] as const;

    for (const { name, schema, valid, unknownKey, unknownValue } of cases) {
      it(`${name} accepts the real field and refuses a misspelling of it`, () => {
        // Positive control first. Without it, the rejection below could pass because the
        // schema refuses everything, which would be a different bug wearing the same
        // green tick.
        expect(schema.safeParse(valid).success).toBe(true);

        const result = schema.safeParse({ ...valid, [unknownKey]: unknownValue });

        expect(result.success).toBe(false);
        if (result.success) return;

        // Asserting the issue *code* rather than just "it failed": a body that fails for
        // some unrelated reason would otherwise satisfy this test, and the thing being
        // protected is specifically that the extra key is what caused it.
        expect(result.error.issues.some((issue) => issue.code === 'unrecognized_keys')).toBe(true);

        // And the offending key is named, so the client gets an error it can act on
        // instead of a generic 400.
        expect(JSON.stringify(result.error.issues)).toContain(unknownKey);
      });
    }
  });

  describe('caption overrides', () => {
    it('keeps null and empty string apart', () => {
      // `null` inherits the base copy; `''` is a caption the user deliberately emptied.
      // Both must survive parsing distinctly, because collapsing them resurrects copy on
      // a platform someone cleared on purpose.
      const parsed = CaptionOverridesSchema.parse({ INSTAGRAM: null, THREADS: '' });

      expect(parsed.INSTAGRAM).toBeNull();
      expect(parsed.THREADS).toBe('');
    });

    it('rejects a platform the product does not support', () => {
      expect(CaptionOverridesSchema.safeParse({ MYSPACE: 'hello' }).success).toBe(false);
    });
  });

  it('spells the link marker the way the caption generator emits it', () => {
    // A prompt that emits `{link}` against a UI looking for `{{link}}` fails silently, and
    // stays invisible until nobody's clicks are attributed.
    expect(LINK_MARKER).toBe('{{link}}');
  });
});

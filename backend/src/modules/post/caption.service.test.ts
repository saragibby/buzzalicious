import { describe, expect, it } from 'vitest';
import { describeSlots, describeVoice, enforceLinkMarker } from './caption.service';
import { LINK_MARKER } from './post.schemas';

/**
 * The pure parts of caption generation.
 *
 * `generateCaption` itself needs a database and a metered AI call, so it is exercised in
 * `tests/db/composer.test.ts` with a stubbed provider. Nothing in this file may reach an
 * AI provider — see the note in `docs/12-testing.md` about the suite that was making live
 * billable calls.
 */

describe('enforceLinkMarker', () => {
  it('normalises the shapes a model reaches for', () => {
    // A marker W7 cannot find is a post published with literal braces in it, or a post
    // whose clicks are silently never attributed.
    expect(enforceLinkMarker('Book now: {link}', true)).toBe(`Book now: ${LINK_MARKER}`);
    expect(enforceLinkMarker('Book now: [link]', true)).toBe(`Book now: ${LINK_MARKER}`);
    expect(enforceLinkMarker('Book now: {{ link }}', true)).toBe(`Book now: ${LINK_MARKER}`);
  });

  it('appends a marker when one was wanted and none was written', () => {
    expect(enforceLinkMarker('Book now', true)).toBe(`Book now\n\n${LINK_MARKER}`);
  });

  it('keeps exactly one marker when the model writes several', () => {
    // Two tracked links in one caption would split a single post's clicks across two
    // short links, which quietly halves every number in the insights screen.
    const result = enforceLinkMarker(`See ${LINK_MARKER} or ${LINK_MARKER}`, true);
    expect(result.split(LINK_MARKER)).toHaveLength(2);
    expect(result).toBe(`See ${LINK_MARKER} or `);
  });

  it('still normalises spelling when no marker was asked for', () => {
    // The user may have typed `{link}` themselves. Leaving a variant spelling in place
    // because generation did not request one is how the two spellings diverge.
    expect(enforceLinkMarker('Book now: {link}', false)).toBe(`Book now: ${LINK_MARKER}`);
  });

  it('does not invent a marker when none was asked for', () => {
    expect(enforceLinkMarker('Book now', false)).toBe('Book now');
  });
});

describe('describeSlots', () => {
  const schema = {
    headline: {
      type: 'text' as const,
      required: true,
      maxLength: 60,
      aiHint: 'the promise being made',
    },
    stat: { type: 'text' as const, required: false, maxLength: 20, label: 'Statistic' },
    plain: { type: 'text' as const, required: false, maxLength: 20 },
    photo: { type: 'image' as const, required: false },
  };

  it('labels values with the aiHint when the template author wrote one', () => {
    // "the promise being made: 20% off" tells a model far more than "headline: 20% off",
    // and the hint is the only place that context exists.
    const described = describeSlots(schema, { headline: '20% off' });
    expect(described).toBe('the promise being made: 20% off');
  });

  it('falls back to the label, then the slot name', () => {
    expect(describeSlots(schema, { stat: '40%' })).toBe('Statistic: 40%');
    expect(describeSlots(schema, { plain: 'x' })).toBe('plain: x');
  });

  it('skips empty slots and image slots', () => {
    // An image URL in a text prompt is noise the model will try to make sense of.
    const described = describeSlots(schema, { headline: '', photo: 'https://example.com/a.png' });
    expect(described).toBe('');
  });
});

describe('describeVoice', () => {
  const guide = {
    summary: 'Warm and direct',
    toneAttributes: ['friendly'],
    doSay: ['neighbourly'],
    dontSay: ['synergy'],
    vocabulary: ['porch'],
    sampleCopy: ['Come on over'],
    readingLevel: 'standard' as const,
    emojiPolicy: 'sparing' as const,
    bannedOpeners: ['In today’s world'],
  };

  it('carries the prohibitions, not just the preferences', () => {
    // A voice guide that only lists what to say produces copy that sounds generic in
    // exactly the ways the brand said it must not.
    const described = describeVoice(guide);
    expect(described).toContain('Never say: synergy');
    expect(described).toContain('Never open with: In today’s world');
  });

  it('omits sections the brand left empty rather than emitting empty labels', () => {
    const described = describeVoice({ ...guide, dontSay: [], bannedOpeners: [] });
    expect(described).not.toContain('Never say');
    expect(described).not.toContain('Never open with');
    expect(described).toContain('Warm and direct');
  });
});

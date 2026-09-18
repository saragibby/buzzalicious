import { describe, expect, it } from 'vitest';
import { PLATFORM_SPECS, countCaption } from '../template/platform-spec';
import { describeOverLength, effectiveCaption, measureFor } from './caption-gate';

/**
 * A caption that is over the limit by `.length` and under it by X's own weighting.
 *
 * This shape is the entire point of the suite. A test that simply exceeds 280 passes
 * under a `.length` gate *and* a `measureCaption` gate, so it proves nothing about which
 * one is wired up. Only a caption in the gap between the two counts can tell them apart,
 * and the gap is where the shipped bug lived: a long tracked URL bills a flat 23 to X, so
 * the composer said "fits" and the publisher said "too long" about identical text.
 */
const LONG_URL = `https://buzzalicious.example.com/r/${'a'.repeat(200)}`;
const X_GAP_CAPTION = `Booking up fast for spring — here is everything you need to know. ${LONG_URL}`;

describe('the X gap caption is genuinely in the gap', () => {
  // Asserting the premise rather than assuming it. If this fixture ever stops straddling
  // the limit, every test below becomes vacuous while still passing, which is precisely
  // the failure mode this repo keeps hitting.
  it('is over the limit counted naively and under it counted as X counts', () => {
    expect(X_GAP_CAPTION.length).toBeGreaterThan(PLATFORM_SPECS.X.captionMaxLength);
    expect(countCaption('X', X_GAP_CAPTION)).toBeLessThan(PLATFORM_SPECS.X.captionMaxLength);
  });
});

describe('measureFor', () => {
  it('does not reject a caption X would accept', () => {
    const measurement = measureFor('X', X_GAP_CAPTION);

    expect(measurement.over).toBe(false);
    expect(measurement.used).toBeLessThan(measurement.limit);
  });

  it('rejects a caption that is over once its links are weighted', () => {
    // Same URL, but the prose alone already exceeds 280, so the weighting cannot save it.
    const measurement = measureFor('X', `${'x'.repeat(280)} ${LONG_URL}`);

    expect(measurement.over).toBe(true);
  });

  it('counts Threads in UTF-8 bytes, so an emoji costs more than one', () => {
    const plain = measureFor('THREADS', 'a'.repeat(10));
    const emoji = measureFor('THREADS', '🎉'.repeat(10));

    expect(plain.used).toBe(10);
    expect(emoji.used).toBe(40);
  });

  it('counts Instagram in code points, so an emoji costs exactly one', () => {
    const measurement = measureFor('INSTAGRAM', '🎉'.repeat(10));

    // `.length` would say 20 here: an emoji is a surrogate pair in UTF-16.
    expect(measurement.used).toBe(10);
  });

  it('reports whether the limit it used is a documented one', () => {
    expect(measureFor('X', 'hi').limitVerified).toBe(true);
    expect(measureFor('FACEBOOK', 'hi').limitVerified).toBe(false);
  });
});

describe('effectiveCaption', () => {
  it('inherits the base copy when the override is null', () => {
    expect(effectiveCaption(null, 'base copy')).toBe('base copy');
  });

  it('does NOT inherit when the override is an empty string', () => {
    // `''` means the user deliberately cleared this platform's caption. Falling back here
    // would resurrect copy they removed on purpose and then publish it.
    expect(effectiveCaption('', 'base copy')).toBe('');
  });

  it('prefers the override over the base copy', () => {
    expect(effectiveCaption('override', 'base copy')).toBe('override');
  });

  it('is an empty string when neither exists', () => {
    expect(effectiveCaption(null, null)).toBe('');
  });
});

describe('describeOverLength', () => {
  it('names the platform, the count and the limit', () => {
    const message = describeOverLength(measureFor('X', `${'x'.repeat(400)}`));

    expect(message).toContain('X');
    expect(message).toContain('280');
    expect(message).toContain('23');
  });

  it('says a Threads caption is counted in bytes', () => {
    const message = describeOverLength(measureFor('THREADS', '🎉'.repeat(400)));

    expect(message).toContain('bytes');
    expect(message).toContain('500');
  });

  it('admits that our Facebook limit is ours and not Facebook’s', () => {
    const message = describeOverLength(measureFor('FACEBOOK', 'x'.repeat(6000)));

    // Facebook publishes no official `message` limit, so claiming 5,000 *is* their rule
    // would assert a fact we do not have. The honesty marker has to reach the user, not
    // just sit in a comment.
    expect(message).toContain('no official limit');
    expect(message).toContain('conservative');
  });

  it('does not add the conservative caveat where the limit is documented', () => {
    const message = describeOverLength(measureFor('INSTAGRAM', 'x'.repeat(3000)));

    expect(message).not.toContain('conservative');
    expect(message).toContain('2200');
  });
});

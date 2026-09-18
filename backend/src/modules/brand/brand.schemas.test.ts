import { describe, expect, it } from 'vitest';
import {
  BrandGoalsSchema,
  BrandPaletteSchema,
  BrandTypographySchema,
  BrandVoiceGuideSchema,
  HexColorSchema,
} from './brand.schemas';
import { PersonaModifiersSchema } from './persona.schemas';
import {
  CategoryPriorsSchema,
  SEND_TIME_SLOTS,
  daypartForHour,
  parseSendTimeSlot,
} from './category.schemas';

const palette = {
  primary: '#1b4332',
  secondary: '#2d6a4f',
  accent: '#d4a373',
  neutral: '#e9edc9',
  background: '#fefae0',
  text: '#1b1b1b',
};

describe('BrandPaletteSchema', () => {
  it('accepts a complete six-colour palette', () => {
    expect(BrandPaletteSchema.parse(palette)).toEqual(palette);
  });

  it('rejects a named CSS colour', () => {
    // Satori resolves hex, not names. A named colour renders as nothing, and a blank
    // region in a published image is the failure this catches.
    expect(HexColorSchema.safeParse('rebeccapurple').success).toBe(false);
  });

  it('rejects a palette missing a role the layouts bind to', () => {
    const { background: _background, ...incomplete } = palette;
    expect(BrandPaletteSchema.safeParse(incomplete).success).toBe(false);
  });

  it('rejects unknown keys so a typo is not silently stored', () => {
    expect(BrandPaletteSchema.safeParse({ ...palette, primaryy: '#000000' }).success).toBe(false);
  });
});

describe('BrandTypographySchema', () => {
  it('defaults weights and transform', () => {
    const parsed = BrandTypographySchema.parse({
      headingFamily: 'Inter',
      bodyFamily: 'Inter',
    });
    expect(parsed).toMatchObject({ headingWeight: 700, bodyWeight: 400, headingTransform: 'none' });
  });

  it('rejects a non-numeric weight', () => {
    // Satori takes numeric weights; "bold" is not resolved and falls back silently.
    const result = BrandTypographySchema.safeParse({
      headingFamily: 'Inter',
      bodyFamily: 'Inter',
      headingWeight: 'bold',
    });
    expect(result.success).toBe(false);
  });
});

describe('BrandVoiceGuideSchema', () => {
  it('fills the list fields so callers never branch on undefined', () => {
    const parsed = BrandVoiceGuideSchema.parse({
      summary: 'Warm, local, specific.',
      toneAttributes: ['warm'],
    });
    expect(parsed.doSay).toEqual([]);
    expect(parsed.bannedOpeners).toEqual([]);
    expect(parsed.emojiPolicy).toBe('sparing');
    expect(parsed.readingLevel).toBe('standard');
  });

  it('requires at least one tone attribute', () => {
    const result = BrandVoiceGuideSchema.safeParse({ summary: 'Hi', toneAttributes: [] });
    expect(result.success).toBe(false);
  });

  it('rejects an emoji policy outside the three we act on', () => {
    const result = BrandVoiceGuideSchema.safeParse({
      summary: 'Hi',
      toneAttributes: ['warm'],
      emojiPolicy: 'lots',
    });
    expect(result.success).toBe(false);
  });
});

describe('BrandGoalsSchema', () => {
  it('accepts a goal the recommender knows how to optimise for', () => {
    const parsed = BrandGoalsSchema.parse({
      primaryGoal: 'leads',
      targetAudience: 'Homeowners on the SC coast',
    });
    expect(parsed.callsToAction).toEqual([]);
  });

  it('rejects a free-text goal', () => {
    expect(
      BrandGoalsSchema.safeParse({ primaryGoal: 'vibes', targetAudience: 'everyone' }).success,
    ).toBe(false);
  });
});

describe('PersonaModifiersSchema', () => {
  it('is a delta, defaulting to an empty one at half intensity', () => {
    const parsed = PersonaModifiersSchema.parse({});
    expect(parsed).toEqual({
      toneAttributes: [],
      suppressToneAttributes: [],
      addDoSay: [],
      addDontSay: [],
      intensity: 0.5,
    });
  });

  it('rejects an intensity outside 0..1', () => {
    expect(PersonaModifiersSchema.safeParse({ intensity: 1.5 }).success).toBe(false);
  });
});

describe('CategoryPriorsSchema', () => {
  it('accepts archetype and send-time priors', () => {
    const parsed = CategoryPriorsSchema.parse({
      archetypes: { 'tip-list': 0.8, 'stat-callout': 0.6 },
      sendTimeSlots: { 'weekday:midday': 0.7 },
      platforms: ['INSTAGRAM'],
    });
    expect(parsed.source).toBe('seed');
  });

  it('rejects an archetype that no template implements', () => {
    // A prior for a non-existent archetype can never be scored against, so it is dead
    // weight that looks like tuning.
    expect(CategoryPriorsSchema.safeParse({ archetypes: { 'meme-dump': 0.9 } }).success).toBe(
      false,
    );
  });

  it('rejects a weight outside 0..1', () => {
    expect(CategoryPriorsSchema.safeParse({ archetypes: { 'tip-list': 4 } }).success).toBe(false);
  });

  it('rejects a send-time slot outside the eight buckets', () => {
    expect(
      CategoryPriorsSchema.safeParse({ sendTimeSlots: { 'weekday:overnight': 0.5 } }).success,
    ).toBe(false);
  });
});

describe('send-time slots', () => {
  it('is exactly the eight buckets docs/06 specifies', () => {
    expect(SEND_TIME_SLOTS).toHaveLength(8);
    expect(SEND_TIME_SLOTS).toContain('weekend:evening');
  });

  it('parses a slot key into its parts', () => {
    expect(parseSendTimeSlot('weekday:midday')).toEqual({ dayType: 'weekday', daypart: 'midday' });
    expect(parseSendTimeSlot('weekday:teatime')).toBeNull();
  });

  it('maps hours to dayparts on the documented boundaries', () => {
    expect(daypartForHour(5)).toBe('early');
    expect(daypartForHour(8)).toBe('early');
    expect(daypartForHour(9)).toBe('midday');
    expect(daypartForHour(13)).toBe('midday');
    expect(daypartForHour(14)).toBe('afternoon');
    expect(daypartForHour(18)).toBe('evening');
    expect(daypartForHour(22)).toBe('evening');
  });

  it('gives overnight hours no bucket at all', () => {
    // docs/06 forbids auto-scheduling overnight without opt-in. Folding 23:00–05:00 into
    // `evening` would let the scheduler pick 3am from a bucket that scored well at 7pm.
    expect(daypartForHour(23)).toBeNull();
    expect(daypartForHour(3)).toBeNull();
    expect(daypartForHour(4)).toBeNull();
  });
});

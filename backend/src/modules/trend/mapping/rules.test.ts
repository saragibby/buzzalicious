import { describe, expect, it } from 'vitest';
import { CATEGORY_RULES, applyRules, explainMatch, normalizeForMatching } from './rules';

describe('applyRules', () => {
  it('maps a tax trend to tax categories and not to unrelated ones', () => {
    const matches = applyRules({
      title: 'Quarterly estimate reminders',
      description: 'Deadline-anchored reminders for self-employed filers.',
    });

    const slugs = matches.map((m) => m.categorySlug);
    expect(slugs).toContain('tax-prep');
    expect(slugs).toContain('professional-services');
    expect(slugs).not.toContain('vacation-rental');
  });

  it('maps a hospitality trend to hospitality categories and not to tax', () => {
    // The acceptance criterion behind "feeds for brands in different categories differ
    // substantially" starts here: if mapping does not separate these, nothing downstream can.
    const matches = applyRules({
      title: 'Shoulder-season value posts',
      description: 'Off-peak pricing framed as "same place, half the people".',
    });

    const slugs = matches.map((m) => m.categorySlug);
    expect(slugs).toContain('hospitality-and-travel');
    expect(slugs).toContain('vacation-rental');
    expect(slugs).not.toContain('tax-prep');
  });

  it('matches inside a hashtag with no word boundaries', () => {
    // HASHTAG is the most common trend kind, and `#smallbusinesssaturday` has no spaces.
    // Without normalization the single most common shape of trend never matches a rule.
    const matches = applyRules({ title: '#SmallBusinessSaturday' });

    expect(matches.map((m) => m.categorySlug)).toContain('retail-and-ecommerce');
  });

  it('does not fire a rule on a word that merely contains the term', () => {
    // "bar" inside "barbershop" would map a barber trend to bars and breweries — the kind
    // of confidently wrong mapping that makes a user distrust the whole feed.
    const matches = applyRules({ title: 'Barbershop fade tutorials' });
    const slugs = matches.map((m) => m.categorySlug);

    expect(slugs).toContain('barbershop');
    expect(slugs).not.toContain('bar-brewery');
  });

  it('returns nothing for a trend outside the taxonomy rather than guessing', () => {
    // An empty result is what routes the trend to layer 2 and then to human review. A
    // rules table that always returns something would silently skip both.
    expect(applyRules({ title: 'Quarterly earnings of a semiconductor foundry' })).toEqual([]);
  });

  it('keeps the strongest score when several rules name one category', () => {
    // Summing would let a pile of incidental word matches accumulate a confident-looking
    // score, which is exactly the false confidence the review flag exists to catch.
    const matches = applyRules({
      title: 'Coffee, espresso and cold brew for the bakery crowd',
    });

    for (const match of matches) {
      expect(match.score).toBeLessThanOrEqual(1);
    }
    expect(matches[0]!.score).toBe(0.95);
  });

  it('sorts the strongest category first', () => {
    const matches = applyRules({ title: 'Vacation rental check-in tips' });

    expect(matches[0]!.categorySlug).toBe('vacation-rental');
  });

  it('reports the terms that caused the match', () => {
    // This string becomes "why this fits you" in the feed. A mapping that cannot say why
    // it matched is one the user has no reason to believe.
    const matches = applyRules({ title: 'Houseplant propagation in winter' });

    expect(explainMatch(matches[0]!)).toContain('propagation');
  });
});

describe('normalizeForMatching', () => {
  it('splits camel case and strips the hash', () => {
    expect(normalizeForMatching('#SmallBusinessSaturday')).toContain('small business saturday');
  });
});

describe('CATEGORY_RULES', () => {
  it('never references TikTok, whose ToS position is unresolved', () => {
    // Q6 is open. Not touching TikTok includes not building it into the vocabulary, so
    // nothing downstream can start targeting it by accident.
    const serialized = JSON.stringify(CATEGORY_RULES).toLowerCase();
    expect(serialized).not.toContain('tiktok');
  });

  it('keeps every score within 0..1 so mapping confidence stays interpretable', () => {
    for (const rule of CATEGORY_RULES) {
      for (const score of Object.values(rule.categories)) {
        expect(score).toBeGreaterThan(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    }
  });

  it('uses lowercase terms, which is what the matcher assumes', () => {
    for (const rule of CATEGORY_RULES) {
      for (const term of rule.terms) {
        expect(term).toBe(term.toLowerCase());
      }
    }
  });
});

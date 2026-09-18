/**
 * Category mapping, layer 1: deterministic keyword and entity rules.
 *
 * docs/07 orders the layers cheapest first, and this one is free, offline, instant and —
 * the property that matters most — **explainable**. Every match produces the terms that
 * caused it, and those terms become the "why this fits you" line in the feed. A mapping
 * that cannot say why it matched is one the user has no reason to believe.
 *
 * Rules are matched against a trend's title and description. They are deliberately biased
 * toward small-business vocabulary rather than general topic coverage: docs/07 reframes
 * the problem as "what's trending for a business like mine", and modest coverage with high
 * category relevance is a far cheaper and more useful target than breadth.
 *
 * Category slugs are W2's taxonomy (`prisma/seed/taxonomy.ts`). A rule naming a slug that
 * does not exist is dropped at resolution time rather than failing the run, so the
 * taxonomy can be pruned without breaking collection.
 *
 * **No TikTok anywhere in here.** Q6 (TikTok ToS) is unresolved; the platform is not
 * referenced, targeted or matched by any rule.
 */

/** Bumped whenever the rules change, so cached mappings invalidate. See `mappingInputHash`. */
/**
 * Bumped when the rules change, because it is part of `mappingInputHash`: an old cached
 * mapping made under different rules must not be reused as if it were current.
 */
export const RULES_VERSION = 2;

export interface CategoryRule {
  /** Lowercase terms. Matched on word boundaries, so "bar" does not match "barbershop". */
  terms: string[];
  /** Category slug → contribution, 0..1. Several rules may hit the same category. */
  categories: Record<string, number>;
}

export const CATEGORY_RULES: CategoryRule[] = [
  {
    terms: ['pumpkin spice', 'latte', 'espresso', 'cold brew', 'coffee', 'barista'],
    categories: { 'coffee-shop': 0.95, 'food-and-drink': 0.7, bakery: 0.45 },
  },
  {
    terms: ['sourdough', 'pastry', 'croissant', 'cake', 'bakery', 'baking'],
    categories: { bakery: 0.95, 'food-and-drink': 0.7, catering: 0.4 },
  },
  {
    terms: ['menu', 'chef', 'dish', 'plating', 'restaurant', 'dinner service', 'prix fixe'],
    categories: { restaurant: 0.9, 'food-and-drink': 0.75, catering: 0.5 },
  },
  {
    terms: ['food truck', 'street food'],
    categories: { 'food-truck': 0.95, 'food-and-drink': 0.7 },
  },
  {
    terms: ['brewery', 'craft beer', 'cocktail', 'happy hour', 'mocktail', 'natural wine'],
    categories: { 'bar-brewery': 0.92, 'food-and-drink': 0.7, restaurant: 0.5 },
  },
  {
    terms: ['smoothie', 'juice cleanse', 'acai'],
    categories: { 'juice-smoothie-bar': 0.9, 'food-and-drink': 0.65, nutritionist: 0.4 },
  },
  {
    terms: ['farmers market', 'local produce', 'small batch', 'specialty grocer'],
    categories: { 'specialty-grocer': 0.85, 'food-and-drink': 0.6, 'food-truck': 0.35 },
  },

  {
    terms: ['renovation', 'remodel', 'contractor', 'punch list', 'job site'],
    categories: { 'general-contractor': 0.92, 'home-and-trades': 0.75, painter: 0.4 },
  },
  {
    terms: ['plumbing', 'plumber', 'water heater', 'burst pipe', 'leak'],
    categories: { plumber: 0.95, 'home-and-trades': 0.7 },
  },
  {
    terms: ['electrician', 'wiring', 'panel upgrade', 'ev charger'],
    categories: { electrician: 0.95, 'home-and-trades': 0.7 },
  },
  {
    terms: ['hvac', 'furnace', 'air conditioning', 'heat pump', 'ductwork'],
    categories: { hvac: 0.95, 'home-and-trades': 0.7 },
  },
  {
    terms: ['landscaping', 'lawn care', 'native plants', 'xeriscape', 'hardscape'],
    categories: { landscaping: 0.93, 'home-and-trades': 0.7, 'plant-shop': 0.4 },
  },
  {
    terms: ['roofing', 'shingle', 'storm damage', 'gutter'],
    categories: { roofing: 0.95, 'home-and-trades': 0.7 },
  },
  {
    terms: ['paint color', 'color of the year', 'accent wall', 'repaint'],
    categories: { painter: 0.88, 'home-and-trades': 0.65, 'home-goods': 0.45 },
  },
  {
    terms: ['deep clean', 'cleaning hack', 'move out clean', 'cleaning service'],
    categories: { 'cleaning-service': 0.92, 'home-and-trades': 0.65 },
  },

  {
    terms: ['workout', 'strength training', 'pr attempt', 'gym', 'deadlift', 'zone 2'],
    categories: {
      'gym-fitness-studio': 0.92,
      'personal-trainer': 0.75,
      'health-and-wellness': 0.7,
    },
  },
  {
    terms: ['yoga', 'pilates', 'reformer', 'mobility', 'breathwork'],
    categories: { 'yoga-pilates': 0.94, 'health-and-wellness': 0.7, 'massage-therapy': 0.35 },
  },
  {
    terms: ['back pain', 'posture', 'adjustment', 'chiropractic'],
    categories: { chiropractor: 0.92, 'health-and-wellness': 0.65, 'massage-therapy': 0.5 },
  },
  {
    terms: ['whitening', 'invisalign', 'dentist', 'oral health', 'cavity'],
    categories: { 'dental-practice': 0.94, 'health-and-wellness': 0.6 },
  },
  {
    terms: ['massage', 'deep tissue', 'recovery day'],
    categories: { 'massage-therapy': 0.92, 'health-and-wellness': 0.65 },
  },
  {
    terms: ['therapy', 'burnout', 'anxiety', 'mental health', 'nervous system'],
    categories: { 'mental-health-practice': 0.9, 'health-and-wellness': 0.65 },
  },
  {
    terms: ['protein', 'macros', 'meal prep', 'gut health', 'nutritionist'],
    categories: { nutritionist: 0.9, 'health-and-wellness': 0.65, 'juice-smoothie-bar': 0.4 },
  },

  {
    terms: ['balayage', 'blowout', 'haircut', 'hair color', 'curtain bangs'],
    categories: { 'hair-salon': 0.94, 'beauty-and-personal-care': 0.75, barbershop: 0.45 },
  },
  {
    terms: ['fade', 'beard trim', 'barber'],
    categories: { barbershop: 0.94, 'beauty-and-personal-care': 0.7 },
  },
  {
    terms: ['nail art', 'manicure', 'gel x', 'pedicure'],
    categories: { 'nail-salon': 0.94, 'beauty-and-personal-care': 0.7 },
  },
  {
    terms: ['botox', 'filler', 'med spa', 'microneedling'],
    categories: { 'med-spa': 0.93, 'beauty-and-personal-care': 0.7, esthetician: 0.55 },
  },
  {
    terms: ['facial', 'skin barrier', 'skincare routine', 'esthetician'],
    categories: { esthetician: 0.92, 'beauty-and-personal-care': 0.72, 'med-spa': 0.5 },
  },
  {
    terms: ['tattoo', 'flash sheet', 'fine line'],
    categories: { 'tattoo-studio': 0.94, 'beauty-and-personal-care': 0.6 },
  },
  {
    terms: ['lash extensions', 'brow lamination', 'lash lift'],
    categories: { 'lash-brow-studio': 0.94, 'beauty-and-personal-care': 0.7 },
  },

  {
    terms: [
      'tax season',
      'tax deadline',
      'quarterly estimate',
      'quarterly estimates',
      'estimated taxes',
      'deduction',
      'deductions',
      'write off',
      'irs',
      'filing',
      'filer',
      'filers',
      'self-employed',
      'self employed',
      '1099',
      'w-2',
    ],
    categories: { 'tax-prep': 0.96, bookkeeping: 0.72, 'professional-services': 0.6 },
  },
  {
    terms: ['bookkeeping', 'reconciliation', 'chart of accounts', 'cash flow', 'invoicing'],
    categories: { bookkeeping: 0.94, 'professional-services': 0.6, 'tax-prep': 0.55 },
  },
  {
    terms: ['retirement', 'roth', 'index fund', 'financial planning', 'portfolio'],
    categories: { 'financial-advisor': 0.93, 'professional-services': 0.6, bookkeeping: 0.4 },
  },
  {
    terms: ['estate planning', 'contract review', 'attorney', 'legal advice', 'llc formation'],
    categories: { 'law-practice': 0.92, 'professional-services': 0.62 },
  },
  {
    terms: ['insurance', 'coverage gap', 'deductible', 'claim'],
    categories: { 'insurance-agency': 0.92, 'professional-services': 0.6 },
  },
  {
    terms: ['ad spend', 'campaign', 'brand refresh', 'marketing agency', 'seo'],
    categories: { 'marketing-agency': 0.92, 'professional-services': 0.6, 'it-consulting': 0.35 },
  },
  {
    terms: ['managed it', 'cybersecurity', 'phishing', 'backup', 'help desk'],
    categories: { 'it-consulting': 0.92, 'professional-services': 0.6 },
  },
  {
    terms: ['listing', 'open house', 'closing costs', 'mortgage rate', 'curb appeal'],
    categories: {
      'real-estate-agent': 0.93,
      'professional-services': 0.55,
      'home-and-trades': 0.4,
    },
  },

  {
    terms: ['capsule wardrobe', 'outfit', 'new arrivals', 'try on', 'boutique'],
    categories: { 'boutique-clothing': 0.92, 'retail-and-ecommerce': 0.7, jewelry: 0.4 },
  },
  {
    terms: ['home decor', 'interior styling', 'shelfie', 'organizing'],
    categories: { 'home-goods': 0.9, 'retail-and-ecommerce': 0.65, 'gift-shop': 0.45 },
  },
  {
    terms: ['gift guide', 'stocking stuffer', 'gift shop'],
    categories: { 'gift-shop': 0.92, 'retail-and-ecommerce': 0.68, jewelry: 0.4 },
  },
  {
    terms: ['book recommendation', 'reading list', 'bookstore', 'booktok'],
    categories: { bookstore: 0.92, 'retail-and-ecommerce': 0.6 },
  },
  {
    terms: ['houseplant', 'plant care', 'propagation', 'repotting'],
    categories: { 'plant-shop': 0.94, 'retail-and-ecommerce': 0.6, landscaping: 0.4 },
  },
  {
    terms: ['pet', 'dog', 'cat', 'puppy', 'adoption'],
    categories: { 'pet-supply': 0.88, 'retail-and-ecommerce': 0.55 },
  },
  {
    terms: ['jewelry', 'engagement ring', 'stacking rings', 'gemstone'],
    categories: { jewelry: 0.93, 'retail-and-ecommerce': 0.62 },
  },
  {
    terms: ['black friday', 'small business saturday', 'flash sale', 'restock', 'shop small'],
    categories: { 'retail-and-ecommerce': 0.85, 'online-store': 0.75, 'boutique-clothing': 0.6 },
  },

  {
    terms: [
      'vacation rental',
      'airbnb',
      'short term rental',
      'guest book',
      'check in',
      'checkout',
      'booking window',
      'guest',
      'guests',
      'host',
      'amenity',
      'amenities',
      'cabin',
      'cottage',
      'beach house',
      'lake house',
      'coastal',
      'nightly rate',
    ],
    categories: { 'vacation-rental': 0.95, 'hospitality-and-travel': 0.75 },
  },
  {
    /**
     * Presentation vocabulary — how a stay or space is shown rather than what it is.
     *
     * Added after running the rules against W2's seed, where "Quiet coastal styling" and
     * "Golden-hour walkthroughs" matched nothing and were withheld from every feed. Both
     * are unmistakably short-term-rental content; the rules table simply had no words for
     * how this industry actually talks about its own posts.
     */
    terms: [
      'styling',
      'staging',
      'walkthrough',
      'walk through',
      'room tour',
      'property tour',
      'golden hour',
      'before and after',
      'reset',
      'turnover',
    ],
    categories: {
      'vacation-rental': 0.78,
      'hospitality-and-travel': 0.66,
      'boutique-hotel': 0.6,
      'home-goods': 0.55,
    },
  },
  {
    terms: ['boutique hotel', 'suite', 'hotel lobby', 'turndown'],
    categories: { 'boutique-hotel': 0.93, 'hospitality-and-travel': 0.72 },
  },
  {
    terms: ['bed and breakfast', 'innkeeper', 'breakfast spread'],
    categories: { 'bed-and-breakfast': 0.93, 'hospitality-and-travel': 0.7 },
  },
  {
    terms: ['guided tour', 'day trip', 'excursion', 'itinerary'],
    categories: { 'tour-operator': 0.92, 'hospitality-and-travel': 0.7 },
  },
  {
    terms: ['event venue', 'reception', 'floor plan', 'venue tour'],
    categories: { 'event-venue': 0.92, 'hospitality-and-travel': 0.65, 'wedding-planner': 0.6 },
  },
  {
    terms: ['wedding', 'bridal', 'engagement season', 'tablescape'],
    categories: { 'wedding-planner': 0.92, 'event-venue': 0.68, 'hospitality-and-travel': 0.55 },
  },
  {
    terms: ['campground', 'rv park', 'camping', 'glamping'],
    categories: { 'campground-rv-park': 0.94, 'hospitality-and-travel': 0.7 },
  },
  {
    terms: ['shoulder season', 'off peak', 'peak season', 'last minute availability'],
    categories: {
      'hospitality-and-travel': 0.82,
      'vacation-rental': 0.8,
      'campground-rv-park': 0.6,
      'tour-operator': 0.55,
    },
  },

  {
    terms: ['tutoring', 'study tips', 'exam prep', 'sat'],
    categories: { tutoring: 0.93, 'education-and-community': 0.7 },
  },
  {
    terms: ['music lesson', 'piano', 'guitar', 'practice routine'],
    categories: { 'music-lessons': 0.93, 'education-and-community': 0.68 },
  },
  {
    terms: ['preschool', 'childcare', 'daycare', 'toddler'],
    categories: { 'childcare-preschool': 0.93, 'education-and-community': 0.68 },
  },
  {
    terms: ['driving lesson', 'permit test', 'driving school'],
    categories: { 'driving-school': 0.94, 'education-and-community': 0.65 },
  },
  {
    terms: ['donation', 'fundraiser', 'volunteer', 'nonprofit', 'giving tuesday'],
    categories: { nonprofit: 0.93, 'education-and-community': 0.7 },
  },
  {
    terms: ['sermon', 'congregation', 'faith community', 'service times'],
    categories: { 'church-faith-community': 0.93, 'education-and-community': 0.65 },
  },
  {
    terms: ['coworking', 'hot desk', 'remote work', 'work from anywhere'],
    categories: { 'coworking-space': 0.92, 'education-and-community': 0.55, 'it-consulting': 0.35 },
  },
];

export interface RuleMatch {
  categorySlug: string;
  score: number;
  /** The terms that fired, verbatim. This is what the feed explanation is built from. */
  matchedTerms: string[];
}

/**
 * Word-boundary match, so "bar" does not fire on "barbershop" and "irs" does not fire on
 * "first". Multi-word terms are matched as phrases. Escaped because a term may contain
 * regex metacharacters — a rule author should not have to know that.
 */
function containsTerm(haystack: string, term: string): boolean {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, 'i').test(haystack);
}

/**
 * Normalizes text for matching.
 *
 * Hashtags are the reason this exists: `#smallbusinesssaturday` has no word boundaries,
 * so the raw title never matches "small business saturday". Splitting camel case and
 * stripping the hash recovers most of them, which matters because `HASHTAG` is the single
 * most common trend kind.
 */
export function normalizeForMatching(text: string): string {
  return text
    .replace(/#/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .toLowerCase();
}

export interface RuleInput {
  title: string;
  description?: string | null;
}

/**
 * Runs every rule and merges the results.
 *
 * Where several rules name the same category the strongest wins rather than the sum: two
 * weak signals pointing the same way are not strong evidence, and summing them would let a
 * trend accumulate a confident-looking score from a pile of incidental word matches.
 */
export function applyRules({ title, description }: RuleInput): RuleMatch[] {
  const haystack = normalizeForMatching(`${title} ${description ?? ''}`);
  const best = new Map<string, RuleMatch>();

  for (const rule of CATEGORY_RULES) {
    const matched = rule.terms.filter((term) => containsTerm(haystack, term));
    if (matched.length === 0) continue;

    for (const [categorySlug, score] of Object.entries(rule.categories)) {
      const existing = best.get(categorySlug);

      if (!existing || score > existing.score) {
        best.set(categorySlug, { categorySlug, score, matchedTerms: matched });
      } else if (existing.score === score) {
        existing.matchedTerms = [...new Set([...existing.matchedTerms, ...matched])];
      }
    }
  }

  return [...best.values()].sort((a, b) => b.score - a.score);
}

/** A one-line reason, for the mapping evidence and the feed explanation. */
export function explainMatch(match: RuleMatch): string {
  const terms = match.matchedTerms
    .slice(0, 3)
    .map((t) => `"${t}"`)
    .join(', ');
  return `mentions ${terms}`;
}

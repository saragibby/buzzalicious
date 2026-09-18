import type { Db } from '../../src/platform/db';
import {
  CategoryPriorsSchema,
  type CategoryPriors,
} from '../../src/modules/brand/category.schemas';
import { seedId } from './deterministic';

/**
 * The global business-category taxonomy (ADR-0010: no `workspaceId` — categories are
 * shared platform-wide).
 *
 * This is the spine of the cold-start story. A brand that has published nothing still gets
 * a defensible template and send-time suggestion because its category carries hand-written
 * priors, which docs/06 then blends with the brand's own outcomes as those accumulate.
 * Two levels: a broad parent the user recognises, and a leaf specific enough that "what
 * works for a plumber" is not averaged with "what works for a yoga studio".
 *
 * The priors here are informed guesses, not measurements — `source: 'seed'` says so
 * explicitly, so the aggregation job in W9 knows exactly which rows it may overwrite.
 */

interface CategorySpec {
  slug: string;
  name: string;
  priors: CategoryPriors;
  children: { slug: string; name: string }[];
}

/** Every archetype gets a weight; omitting one means "no opinion", which reads as a bug. */
function priors(
  archetypes: CategoryPriors['archetypes'],
  sendTimeSlots: CategoryPriors['sendTimeSlots'],
  platforms: string[],
): CategoryPriors {
  return CategoryPriorsSchema.parse({ archetypes, sendTimeSlots, platforms, source: 'seed' });
}

export const CATEGORY_TREE: CategorySpec[] = [
  {
    slug: 'food-and-drink',
    name: 'Food & Drink',
    // Visual, impulse-driven, and read on a phone just before a meal decision.
    priors: priors(
      {
        'product-feature': 0.9,
        'behind-the-scenes': 0.8,
        announcement: 0.7,
        'question-hook': 0.5,
        testimonial: 0.5,
        'stat-callout': 0.2,
        'tip-list': 0.3,
        'before-after': 0.3,
      },
      {
        'weekday:early': 0.6,
        'weekday:midday': 0.8,
        'weekday:afternoon': 0.5,
        'weekday:evening': 0.6,
        'weekend:early': 0.5,
        'weekend:midday': 0.9,
        'weekend:afternoon': 0.6,
        'weekend:evening': 0.5,
      },
      ['INSTAGRAM', 'FACEBOOK', 'THREADS'],
    ),
    children: [
      { slug: 'coffee-shop', name: 'Coffee Shop' },
      { slug: 'bakery', name: 'Bakery' },
      { slug: 'restaurant', name: 'Restaurant' },
      { slug: 'food-truck', name: 'Food Truck' },
      { slug: 'bar-brewery', name: 'Bar or Brewery' },
      { slug: 'catering', name: 'Catering' },
      { slug: 'juice-smoothie-bar', name: 'Juice & Smoothie Bar' },
      { slug: 'specialty-grocer', name: 'Specialty Grocer' },
    ],
  },
  {
    slug: 'home-and-trades',
    name: 'Home & Trades',
    // The work is the proof: before/after outperforms anything written.
    priors: priors(
      {
        'before-after': 0.95,
        testimonial: 0.8,
        'tip-list': 0.7,
        'question-hook': 0.5,
        'stat-callout': 0.4,
        'behind-the-scenes': 0.5,
        announcement: 0.3,
        'product-feature': 0.3,
      },
      {
        'weekday:early': 0.7,
        'weekday:midday': 0.6,
        'weekday:afternoon': 0.5,
        'weekday:evening': 0.7,
        'weekend:early': 0.4,
        'weekend:midday': 0.6,
        'weekend:afternoon': 0.5,
        'weekend:evening': 0.4,
      },
      ['FACEBOOK', 'INSTAGRAM'],
    ),
    children: [
      { slug: 'general-contractor', name: 'General Contractor' },
      { slug: 'plumber', name: 'Plumber' },
      { slug: 'electrician', name: 'Electrician' },
      { slug: 'hvac', name: 'HVAC' },
      { slug: 'landscaping', name: 'Landscaping' },
      { slug: 'roofing', name: 'Roofing' },
      { slug: 'painter', name: 'Painter' },
      { slug: 'cleaning-service', name: 'Cleaning Service' },
    ],
  },
  {
    slug: 'health-and-wellness',
    name: 'Health & Wellness',
    priors: priors(
      {
        'tip-list': 0.85,
        testimonial: 0.8,
        'before-after': 0.7,
        'question-hook': 0.6,
        'stat-callout': 0.6,
        'behind-the-scenes': 0.4,
        announcement: 0.4,
        'product-feature': 0.3,
      },
      {
        'weekday:early': 0.9,
        'weekday:midday': 0.5,
        'weekday:afternoon': 0.4,
        'weekday:evening': 0.7,
        'weekend:early': 0.7,
        'weekend:midday': 0.6,
        'weekend:afternoon': 0.4,
        'weekend:evening': 0.5,
      },
      ['INSTAGRAM', 'FACEBOOK'],
    ),
    children: [
      { slug: 'gym-fitness-studio', name: 'Gym or Fitness Studio' },
      { slug: 'yoga-pilates', name: 'Yoga & Pilates' },
      { slug: 'personal-trainer', name: 'Personal Trainer' },
      { slug: 'chiropractor', name: 'Chiropractor' },
      { slug: 'dental-practice', name: 'Dental Practice' },
      { slug: 'massage-therapy', name: 'Massage Therapy' },
      { slug: 'mental-health-practice', name: 'Mental Health Practice' },
      { slug: 'nutritionist', name: 'Nutritionist' },
    ],
  },
  {
    slug: 'beauty-and-personal-care',
    name: 'Beauty & Personal Care',
    priors: priors(
      {
        'before-after': 0.95,
        'product-feature': 0.7,
        testimonial: 0.7,
        'behind-the-scenes': 0.6,
        announcement: 0.5,
        'question-hook': 0.4,
        'tip-list': 0.5,
        'stat-callout': 0.2,
      },
      {
        'weekday:early': 0.4,
        'weekday:midday': 0.6,
        'weekday:afternoon': 0.6,
        'weekday:evening': 0.8,
        'weekend:early': 0.4,
        'weekend:midday': 0.7,
        'weekend:afternoon': 0.6,
        'weekend:evening': 0.6,
      },
      ['INSTAGRAM', 'THREADS'],
    ),
    children: [
      { slug: 'hair-salon', name: 'Hair Salon' },
      { slug: 'barbershop', name: 'Barbershop' },
      { slug: 'nail-salon', name: 'Nail Salon' },
      { slug: 'med-spa', name: 'Med Spa' },
      { slug: 'esthetician', name: 'Esthetician' },
      { slug: 'tattoo-studio', name: 'Tattoo Studio' },
      { slug: 'lash-brow-studio', name: 'Lash & Brow Studio' },
    ],
  },
  {
    slug: 'professional-services',
    name: 'Professional Services',
    // Credibility-led: numbers and explanations, read during the working day.
    priors: priors(
      {
        'stat-callout': 0.9,
        'tip-list': 0.85,
        'question-hook': 0.7,
        testimonial: 0.6,
        announcement: 0.5,
        'behind-the-scenes': 0.4,
        'before-after': 0.3,
        'product-feature': 0.2,
      },
      {
        'weekday:early': 0.6,
        'weekday:midday': 0.9,
        'weekday:afternoon': 0.7,
        'weekday:evening': 0.4,
        'weekend:early': 0.2,
        'weekend:midday': 0.3,
        'weekend:afternoon': 0.3,
        'weekend:evening': 0.2,
      },
      ['X', 'FACEBOOK', 'THREADS'],
    ),
    children: [
      { slug: 'tax-prep', name: 'Tax Preparation' },
      { slug: 'bookkeeping', name: 'Bookkeeping' },
      { slug: 'financial-advisor', name: 'Financial Advisor' },
      { slug: 'law-practice', name: 'Law Practice' },
      { slug: 'insurance-agency', name: 'Insurance Agency' },
      { slug: 'marketing-agency', name: 'Marketing Agency' },
      { slug: 'it-consulting', name: 'IT Consulting' },
      { slug: 'real-estate-agent', name: 'Real Estate Agent' },
    ],
  },
  {
    slug: 'retail-and-ecommerce',
    name: 'Retail & E-commerce',
    priors: priors(
      {
        'product-feature': 0.95,
        announcement: 0.8,
        'behind-the-scenes': 0.6,
        testimonial: 0.6,
        'question-hook': 0.4,
        'tip-list': 0.4,
        'before-after': 0.3,
        'stat-callout': 0.3,
      },
      {
        'weekday:early': 0.3,
        'weekday:midday': 0.6,
        'weekday:afternoon': 0.6,
        'weekday:evening': 0.85,
        'weekend:early': 0.3,
        'weekend:midday': 0.7,
        'weekend:afternoon': 0.7,
        'weekend:evening': 0.6,
      },
      ['INSTAGRAM', 'FACEBOOK', 'THREADS'],
    ),
    children: [
      { slug: 'boutique-clothing', name: 'Clothing Boutique' },
      { slug: 'home-goods', name: 'Home Goods' },
      { slug: 'gift-shop', name: 'Gift Shop' },
      { slug: 'bookstore', name: 'Bookstore' },
      { slug: 'plant-shop', name: 'Plant Shop' },
      { slug: 'pet-supply', name: 'Pet Supply' },
      { slug: 'jewelry', name: 'Jewelry' },
      { slug: 'online-store', name: 'Online Store' },
    ],
  },
  {
    slug: 'hospitality-and-travel',
    name: 'Hospitality & Travel',
    // Planning happens on weekends and after work; the product is the place.
    priors: priors(
      {
        'product-feature': 0.85,
        'behind-the-scenes': 0.75,
        testimonial: 0.7,
        announcement: 0.65,
        'question-hook': 0.55,
        'tip-list': 0.6,
        'stat-callout': 0.3,
        'before-after': 0.4,
      },
      {
        'weekday:early': 0.4,
        'weekday:midday': 0.5,
        'weekday:afternoon': 0.6,
        'weekday:evening': 0.8,
        'weekend:early': 0.5,
        'weekend:midday': 0.75,
        'weekend:afternoon': 0.7,
        'weekend:evening': 0.65,
      },
      ['INSTAGRAM', 'FACEBOOK', 'THREADS'],
    ),
    children: [
      { slug: 'vacation-rental', name: 'Vacation Rental' },
      { slug: 'boutique-hotel', name: 'Boutique Hotel' },
      { slug: 'bed-and-breakfast', name: 'Bed & Breakfast' },
      { slug: 'tour-operator', name: 'Tour Operator' },
      { slug: 'event-venue', name: 'Event Venue' },
      { slug: 'wedding-planner', name: 'Wedding Planner' },
      { slug: 'campground-rv-park', name: 'Campground & RV Park' },
    ],
  },
  {
    slug: 'education-and-community',
    name: 'Education & Community',
    priors: priors(
      {
        'tip-list': 0.8,
        announcement: 0.8,
        testimonial: 0.7,
        'question-hook': 0.6,
        'behind-the-scenes': 0.6,
        'stat-callout': 0.5,
        'before-after': 0.3,
        'product-feature': 0.2,
      },
      {
        'weekday:early': 0.6,
        'weekday:midday': 0.6,
        'weekday:afternoon': 0.7,
        'weekday:evening': 0.6,
        'weekend:early': 0.3,
        'weekend:midday': 0.5,
        'weekend:afternoon': 0.4,
        'weekend:evening': 0.4,
      },
      ['FACEBOOK', 'INSTAGRAM'],
    ),
    children: [
      { slug: 'tutoring', name: 'Tutoring' },
      { slug: 'music-lessons', name: 'Music Lessons' },
      { slug: 'childcare-preschool', name: 'Childcare & Preschool' },
      { slug: 'driving-school', name: 'Driving School' },
      { slug: 'nonprofit', name: 'Nonprofit' },
      { slug: 'church-faith-community', name: 'Church & Faith Community' },
      { slug: 'coworking-space', name: 'Coworking Space' },
    ],
  },
];

export function categoryId(slug: string): string {
  return seedId('business-category', slug);
}

export async function seedCategories(db: Db): Promise<number> {
  let count = 0;

  for (const parent of CATEGORY_TREE) {
    const id = categoryId(parent.slug);
    const data = {
      slug: parent.slug,
      name: parent.name,
      parentId: null,
      priors: parent.priors,
    };
    await db.businessCategory.upsert({ where: { id }, create: { id, ...data }, update: data });
    count += 1;

    for (const child of parent.children) {
      const childId = categoryId(child.slug);
      // Leaves inherit the parent's priors verbatim. A leaf-specific guess would be a
      // fabricated distinction; the feedback loop will differentiate them with real data.
      const childData = {
        slug: child.slug,
        name: child.name,
        parentId: id,
        priors: parent.priors,
      };
      await db.businessCategory.upsert({
        where: { id: childId },
        create: { id: childId, ...childData },
        update: childData,
      });
      count += 1;
    }
  }

  return count;
}

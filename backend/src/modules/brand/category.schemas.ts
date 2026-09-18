import { z } from 'zod';
import { TEMPLATE_ARCHETYPES } from '../template/template.schemas';

/**
 * JSON column contract for `BusinessCategory.priors`.
 *
 * Cold-start priors: what we believe works for a category before that category has any
 * outcome data of its own. They are the `prior(category(b), s)` term in the scoring
 * formula in docs/06, which is what lets a brand with zero posts still get a defensible
 * suggestion on day one.
 *
 * Hand-seeded now, overwritten by aggregate data once the feedback loop has volume — so
 * `source` and `updatedAt` are part of the shape. A prior that cannot say whether it was
 * a guess or a measurement is one nobody can safely overwrite.
 */

/** 0..1 weight per archetype. Absent means "no opinion", which is not the same as 0. */
export const ArchetypePriorsSchema = z.record(
  z.enum(TEMPLATE_ARCHETYPES),
  z.number().min(0).max(1),
);

export const DAY_TYPES = ['weekday', 'weekend'] as const;
export const DAYPARTS = ['early', 'midday', 'afternoon', 'evening'] as const;

/**
 * The eight send-time buckets from docs/06 — day type × daypart. Deliberately not
 * day-of-week × hour: 168 buckets are far too sparse for a brand posting daily to ever
 * fill.
 */
export const SEND_TIME_SLOTS = DAY_TYPES.flatMap((dayType) =>
  DAYPARTS.map((daypart) => `${dayType}:${daypart}` as const),
);

export type SendTimeSlot = (typeof SEND_TIME_SLOTS)[number];

export const SendTimeSlotSchema = z.enum(
  SEND_TIME_SLOTS as unknown as [SendTimeSlot, ...SendTimeSlot[]],
);

export const SlotPriorsSchema = z.record(SendTimeSlotSchema, z.number().min(0).max(1));

export const CategoryPriorsSchema = z
  .object({
    archetypes: ArchetypePriorsSchema.default({}),
    sendTimeSlots: SlotPriorsSchema.default({}),
    /** Platforms this kind of business typically gets traction on. */
    platforms: z.array(z.string().min(1)).default([]),
    source: z.enum(['seed', 'aggregate']).default('seed'),
    /** ISO-8601. When the priors were last recomputed, for staleness checks. */
    updatedAt: z.string().datetime().optional(),
  })
  .strict();

export type CategoryPriors = z.infer<typeof CategoryPriorsSchema>;

/** Parse a `scheduleSlot` key back into its parts, for scoring and display. */
export function parseSendTimeSlot(slot: string): { dayType: string; daypart: string } | null {
  const result = SendTimeSlotSchema.safeParse(slot);
  if (!result.success) return null;
  const [dayType, daypart] = result.data.split(':');
  return { dayType: dayType as string, daypart: daypart as string };
}

/**
 * The daypart an hour falls in, per the bucket boundaries in docs/06:
 * early 5–9, midday 9–14, afternoon 14–18, evening 18–23.
 *
 * Hours 23–5 are quiet hours: docs/06 forbids auto-scheduling overnight in the audience's
 * timezone without opt-in, so they deliberately have no bucket rather than being folded
 * into `evening` where the scheduler could pick them.
 */
export function daypartForHour(hour: number): (typeof DAYPARTS)[number] | null {
  if (hour >= 5 && hour < 9) return 'early';
  if (hour >= 9 && hour < 14) return 'midday';
  if (hour >= 14 && hour < 18) return 'afternoon';
  if (hour >= 18 && hour < 23) return 'evening';
  return null;
}

import {
  AspectRatio,
  MediaType,
  Platform,
  PostStatus,
  ScheduleSource,
  TargetStatus,
} from '@prisma/client';
import type { Db } from '../../src/platform/db';
import { daypartForHour } from '../../src/modules/brand/category.schemas';
import { isWeekendInZone, utcToZonedTime, zonedTimeToUtc } from '../../src/platform/time';
import { createRng, jitter, randomInt, seedId } from './deterministic';
import { templateId } from './templates';
import { trendId } from './trends';
import { assetId, brandId, personaId, socialAccountId, type WorkspaceSpec } from './workspaces';

/**
 * Twelve months of posting history for each seeded brand.
 *
 * This is the part of the seed the rest of the plan leans on hardest. Send-time learning
 * (docs/06) scores eight buckets — day type × daypart — and a brand whose history sits in
 * three of them produces a recommender that looks broken when it is merely starving. So
 * every brand here covers all eight, with genuinely different shapes: Rise & Shore peaks
 * on weekend mornings and summer evenings, TaxDedux is a weekday-midday business whose
 * volume triples between January and April and nearly stops in the autumn.
 *
 * Two pairs of posts sit either side of a US DST transition at the same local time, which
 * is the case that silently breaks anything storing only a UTC instant.
 *
 * Metrics are snapshots rather than totals, and link clicks are individual rows including
 * bot hits, because that is the shape the outcome pipeline actually consumes.
 */

type SlotValueSpec = string | { asset: string };

interface PostSpec {
  key: string;
  templateSlug: string | null;
  trendKey?: string;
  personaKey?: string;
  title: string;
  slots: Record<string, SlotValueSpec>;
  baseCopy: string;
  mediaType?: MediaType;
  /** Zoneless local wall time in the brand's timezone. */
  localTime: string;
  scheduleSource?: ScheduleSource;
  /** Social account keys this post went out to. */
  accounts: string[];
  ratios?: AspectRatio[];
  /** Present if the post carried a tracked link. */
  destination?: string;
  /** Drives the scale of the generated metrics. */
  performance: 'low' | 'mid' | 'high';
}

/** Posts still ahead of `now`, expressed as an offset so they stay in the future. */
interface UpcomingPostSpec extends Omit<PostSpec, 'localTime'> {
  inDays: number;
  atLocalTime: string;
  status: PostStatus;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

// ─── Rise & Shore ────────────────────────────────────────────────────────────────

const RISE_AND_SHORE_POSTS: PostSpec[] = [
  {
    key: 'porch-morning',
    templateSlug: 'behind-the-scenes',
    title: 'Porch, 7am',
    slots: {
      photo: { asset: 'porch-morning' },
      caption: 'The porch gets about an hour of this before the heat finds it.',
    },
    baseCopy:
      'The porch gets about an hour of this before the heat finds it. Coffee tastes better ' +
      'out here and we have never been able to explain why.',
    localTime: '2025-10-07T07:15',
    accounts: ['instagram', 'facebook'],
    performance: 'mid',
  },
  {
    key: 'shoulder-season',
    templateSlug: 'big-number',
    trendKey: 'shoulder-season-value',
    title: 'October rates',
    slots: { stat: '-38%', context: 'Same house, same beach, 38% fewer people. October is ours.' },
    baseCopy:
      'Same house, same beach, 38% fewer people. October is the month locals keep for ' +
      'themselves. Rates drop the first week.',
    localTime: '2025-10-15T11:30',
    accounts: ['instagram', 'facebook', 'threads'],
    destination: 'https://riseandshore.example/october',
    performance: 'high',
  },
  {
    key: 'marsh-sunset-guide',
    templateSlug: 'stat-with-photo',
    trendKey: 'quiet-luxury-coastal',
    personaKey: 'local-friend',
    title: 'Marsh side sunsets',
    slots: {
      background: { asset: 'marsh-sunset' },
      stat: '18 min',
      context: 'From the back steps to the best sunset view on the island.',
    },
    baseCopy:
      'Eighteen minutes from the back steps, past the second dock. Nobody believes the ' +
      'marsh side is better until October proves it.',
    localTime: '2025-11-12T15:45',
    accounts: ['instagram', 'threads'],
    performance: 'high',
  },
  {
    key: 'fall-booking-window',
    templateSlug: 'question-hook',
    title: 'How far ahead do you book?',
    slots: {
      question: 'How far ahead do you actually book a beach week?',
      prompt: 'Tell us below',
    },
    baseCopy:
      'How far ahead do you actually book a beach week? We are trying to settle an argument.',
    localTime: '2025-09-25T19:00',
    accounts: ['threads', 'facebook'],
    performance: 'mid',
  },
  {
    key: 'dst-saturday',
    templateSlug: 'behind-the-scenes',
    title: 'Last of the long evenings',
    slots: {
      photo: { asset: 'marsh-sunset' },
      caption: 'Last Saturday before the clocks go back. Sunset at 6:12.',
    },
    baseCopy:
      'Last Saturday before the clocks go back. Sunset at 6:12 and then it is winter hours.',
    // 9am EDT. Paired with the Monday below at the same wall time under EST — the case
    // that breaks anything storing only the instant.
    localTime: '2025-11-01T09:00',
    accounts: ['instagram', 'facebook'],
    performance: 'mid',
  },
  {
    key: 'dst-monday',
    templateSlug: 'three-tip-list',
    title: 'Winter hours',
    slots: {
      heading: 'What changes in winter',
      tipOne: 'The outdoor shower goes off in December.',
      tipTwo: 'Ferry runs drop to three a day.',
      tipThree: 'The good oyster place opens Thursday through Sunday.',
    },
    baseCopy: 'Three things that change on the island once the clocks go back.',
    localTime: '2025-11-03T09:00',
    accounts: ['facebook', 'threads'],
    performance: 'low',
  },
  {
    key: 'holiday-gap',
    templateSlug: 'announcement-card',
    title: 'One week open at Christmas',
    slots: {
      eyebrow: 'ONE WEEK OPEN',
      headline: 'December 20–27',
      detail: 'A cancellation opened the Christmas week. It has not been open in four years.',
    },
    baseCopy:
      'A cancellation opened Christmas week, December 20 to 27. It has not been available in ' +
      'four years and it will not last.',
    localTime: '2025-12-04T18:30',
    accounts: ['instagram', 'facebook', 'threads'],
    destination: 'https://riseandshore.example/december',
    performance: 'high',
  },
  {
    key: 'january-quiet',
    templateSlug: 'question-hook',
    title: 'Off-season regulars',
    slots: {
      question: 'Is a beach town in January a treat or a mistake?',
      prompt: 'Genuinely asking',
    },
    baseCopy:
      'Is a beach town in January a treat or a mistake? We have opinions but we want yours.',
    localTime: '2026-01-14T12:00',
    accounts: ['threads'],
    performance: 'low',
  },
  {
    key: 'turnover-reality',
    templateSlug: 'behind-the-scenes',
    personaKey: 'local-friend',
    title: 'Turnover day',
    slots: {
      photo: { asset: 'kitchen-reset' },
      caption: 'Four hours between one family leaving and the next arriving.',
    },
    baseCopy:
      'Four hours between one family leaving and the next arriving. This is the part nobody ' +
      'photographs.',
    localTime: '2026-02-21T16:00',
    accounts: ['instagram', 'threads'],
    performance: 'mid',
  },
  {
    key: 'spring-dst-saturday',
    templateSlug: 'announcement-card',
    title: 'Spring dates open',
    slots: {
      eyebrow: 'SPRING DATES',
      headline: 'April and May are open',
      detail: 'Water is cold, the town is empty, and the porch is perfect. Our favourite months.',
    },
    baseCopy:
      'April and May are open. Cold water, empty town, perfect porch. Our favourite months.',
    // 6:30pm EST, the evening before the clocks go forward.
    localTime: '2026-03-07T18:30',
    accounts: ['instagram', 'facebook'],
    destination: 'https://riseandshore.example/spring',
    performance: 'mid',
  },
  {
    key: 'spring-dst-monday',
    templateSlug: 'three-tip-list',
    title: 'Packing for a cold-water week',
    slots: {
      heading: 'Packing for April',
      tipOne: 'A wind layer matters more than a swimsuit.',
      tipTwo: 'The outdoor shower is on from March 15.',
      tipThree: 'Bikes are in the shed, tyres are not our department.',
    },
    baseCopy: 'Three things worth packing for an April week that nobody expects.',
    // 6:30pm EDT, the Monday after. Same wall time, one hour earlier in UTC.
    localTime: '2026-03-09T18:30',
    accounts: ['facebook', 'threads'],
    performance: 'low',
  },
  {
    key: 'guest-quote-spring',
    templateSlug: 'testimonial-quote',
    title: 'A quote from the book',
    slots: {
      quote:
        'We came for the beach and spent most of the week on the porch. Nobody is sorry about it.',
      attribution: 'The Ferraro family, May',
    },
    baseCopy:
      '"We came for the beach and spent most of the week on the porch." From the guest book, ' +
      'which we read more than we admit.',
    localTime: '2026-04-18T10:30',
    accounts: ['instagram', 'facebook'],
    performance: 'high',
  },
  {
    key: 'saturday-early',
    templateSlug: 'behind-the-scenes',
    title: 'Low tide, 8am',
    slots: {
      photo: { asset: 'porch-morning' },
      caption: 'Low tide at 8:04. The flat sand runs almost to the pier.',
    },
    baseCopy: 'Low tide at 8:04 this morning. The flat sand runs almost all the way to the pier.',
    localTime: '2026-05-16T08:00',
    scheduleSource: ScheduleSource.SUGGESTED,
    accounts: ['instagram', 'threads'],
    performance: 'high',
  },
  {
    key: 'bunk-room-families',
    templateSlug: 'product-feature',
    title: 'The bunk room',
    slots: {
      productImage: { asset: 'bunk-room' },
      name: 'The bunk room',
      pitch: 'Four built-in beds, one door, and a rule about who gets the top left.',
    },
    baseCopy:
      'Four built-in beds, one door, and an unwritten rule about who gets the top left. It is ' +
      'the reason most families rebook.',
    localTime: '2026-06-13T11:00',
    scheduleSource: ScheduleSource.SUGGESTED,
    accounts: ['instagram', 'facebook', 'threads'],
    destination: 'https://riseandshore.example/the-house',
    performance: 'high',
  },
  {
    key: 'july-afternoon',
    templateSlug: 'big-number',
    title: 'Six minutes',
    slots: {
      stat: '6 min',
      context: 'Front door to the pier on foot. Less if the sand is packed.',
    },
    baseCopy: 'Six minutes, front door to the pier, on foot. Less if the sand is packed.',
    localTime: '2026-07-11T16:30',
    accounts: ['instagram', 'facebook'],
    performance: 'mid',
  },
  {
    key: 'august-sunday-evening',
    templateSlug: 'testimonial-quote',
    personaKey: 'local-friend',
    title: 'Sunday evening quote',
    slots: {
      quote: 'The kids asked if we could stay an extra night. We are not that kind of family.',
      attribution: 'A guest, August',
    },
    baseCopy:
      '"The kids asked if we could stay an extra night." Reader, they did stay the extra night.',
    localTime: '2026-08-09T20:00',
    accounts: ['instagram', 'threads'],
    performance: 'mid',
  },
  {
    key: 'weekday-early-summer',
    templateSlug: 'question-hook',
    title: 'Early risers',
    slots: {
      question: 'Beach at 7am or beach at 7pm? There is only one right answer.',
      prompt: 'Settle it',
    },
    baseCopy: 'Beach at 7am or beach at 7pm? There is only one right answer and we will wait.',
    localTime: '2026-06-23T06:45',
    scheduleSource: ScheduleSource.EXPLORATION,
    accounts: ['threads', 'x'],
    performance: 'low',
  },
  {
    key: 'weekend-early-shoulder',
    templateSlug: 'stat-with-photo',
    trendKey: 'quiet-luxury-coastal',
    title: 'Saturday, before anyone',
    slots: {
      background: { asset: 'marsh-sunset' },
      stat: '7:40',
      context: 'Sunrise. You will have the sand to yourself for about an hour.',
    },
    baseCopy: 'Sunrise at 7:40. You will have the sand to yourself for about an hour after that.',
    localTime: '2026-04-25T07:30',
    accounts: ['instagram'],
    performance: 'mid',
  },
  {
    key: 'text-only-thanks',
    templateSlug: 'plain-text-take',
    title: 'Thank you note',
    slots: {
      body:
        'Twelve families rebooked for next summer before leaving this one. We are not going to ' +
        'pretend that is normal. Thank you.',
    },
    baseCopy:
      'Twelve families rebooked for next summer before leaving this one. We are not going to ' +
      'pretend that is normal. Thank you.',
    mediaType: MediaType.TEXT,
    localTime: '2026-08-26T13:15',
    accounts: ['threads', 'x'],
    performance: 'mid',
  },
  {
    key: 'weekend-afternoon-winter',
    templateSlug: 'three-tip-list',
    personaKey: 'local-friend',
    title: 'A rainy day list',
    slots: {
      heading: 'When it rains all week',
      tipOne: 'The aquarium is better on a weekday.',
      tipTwo: 'The bookshop on Center has a back room nobody finds.',
      tipThree: 'Oysters are indoor food. This is our position.',
    },
    baseCopy: 'Three things to do when the forecast ruins the plan. We have tested all of them.',
    localTime: '2026-02-07T14:30',
    accounts: ['facebook', 'threads'],
    performance: 'low',
  },
];

const RISE_AND_SHORE_UPCOMING: UpcomingPostSpec[] = [
  {
    key: 'upcoming-fall-rates',
    templateSlug: 'announcement-card',
    trendKey: 'shoulder-season-value',
    title: 'Autumn rates drop',
    slots: {
      eyebrow: 'AUTUMN RATES',
      headline: 'Rates drop October 1',
      detail: 'Same house, fewer people, and the water is still warm through the month.',
    },
    baseCopy: 'Rates drop October 1. Same house, fewer people, water still warm.',
    inDays: 3,
    atLocalTime: '09:30',
    scheduleSource: ScheduleSource.SUGGESTED,
    accounts: ['instagram', 'facebook', 'threads'],
    destination: 'https://riseandshore.example/autumn',
    status: PostStatus.SCHEDULED,
    performance: 'mid',
  },
  {
    key: 'draft-winter-idea',
    templateSlug: 'question-hook',
    title: 'Winter idea (draft)',
    slots: { question: 'Would you spend New Year at the beach?', prompt: 'Be honest' },
    baseCopy: 'Would you spend New Year at the beach? Drafting this one, no date yet.',
    inDays: 0,
    atLocalTime: '12:00',
    accounts: [],
    status: PostStatus.DRAFT,
    performance: 'low',
  },
];

// ─── TaxDedux ────────────────────────────────────────────────────────────────────

const TAXDEDUX_POSTS: PostSpec[] = [
  {
    key: 'q3-estimate',
    templateSlug: 'big-number',
    trendKey: 'quarterly-estimates-panic',
    personaKey: 'deadline-coach',
    title: 'Q3 estimate due',
    slots: { stat: 'Sep 15', context: 'Third quarter estimated payment. Same date every year.' },
    baseCopy:
      'Third quarter estimated payment is due September 15. Same date every year, and every ' +
      'year it surprises somebody.',
    localTime: '2025-09-10T11:00',
    accounts: ['x', 'threads', 'facebook'],
    performance: 'high',
  },
  {
    key: 'home-office-rule',
    templateSlug: 'three-tip-list',
    title: 'Home office, honestly',
    slots: {
      heading: 'The home office test',
      tipOne: 'It has to be exclusive. The kitchen table is not exclusive.',
      tipTwo: 'It has to be regular. Twice in March does not count.',
      tipThree: 'Measure it. The deduction is proportional to the square footage.',
    },
    baseCopy: 'The home office deduction has three tests and most people fail the first one.',
    localTime: '2025-10-08T12:30',
    accounts: ['x', 'facebook'],
    destination: 'https://taxdedux.example/home-office',
    performance: 'high',
  },
  {
    key: 'october-extension',
    templateSlug: 'announcement-card',
    personaKey: 'deadline-coach',
    title: 'Extension deadline',
    slots: {
      eyebrow: 'DEADLINE',
      headline: 'October 15',
      detail:
        'If you extended in April, this is the actual due date. There is no second extension.',
    },
    baseCopy:
      'If you extended in April, October 15 is the actual due date. There is no second ' +
      'extension and the late-filing penalty is worse than the late-payment one.',
    localTime: '2025-10-13T09:15',
    accounts: ['x', 'threads', 'facebook'],
    performance: 'high',
  },
  {
    key: 'mileage-log',
    templateSlug: 'plain-text-take',
    title: 'Mileage logs',
    slots: {
      body:
        'A mileage log written in December for the whole year is not a mileage log. It is a ' +
        'guess with a pen. Write it down weekly or take the actual expense method.',
    },
    baseCopy:
      'A mileage log written in December for the whole year is not a mileage log. It is a ' +
      'guess with a pen.',
    // Genuinely text-only: no template image, no renditions. The path the publish pipeline
    // is most likely to assume away.
    mediaType: MediaType.TEXT,
    localTime: '2025-11-19T13:00',
    accounts: ['x', 'threads'],
    performance: 'mid',
  },
  {
    key: 'year-end-checklist',
    templateSlug: 'five-step-checklist',
    title: 'Before December 31',
    slots: {
      heading: 'Do these before Dec 31',
      stepOne: 'Make the retirement contribution.',
      stepTwo: 'Buy the equipment you were going to buy anyway.',
      stepThree: 'Settle outstanding invoices you can settle.',
      stepFour: 'Reconcile the books while you remember the transactions.',
      stepFive: 'Check your Q4 estimate against actual income.',
    },
    baseCopy: 'Five things that only work if you do them before December 31.',
    localTime: '2025-12-09T12:00',
    accounts: ['x', 'facebook', 'threads'],
    destination: 'https://taxdedux.example/year-end',
    performance: 'high',
  },
  {
    key: 'january-forms',
    templateSlug: 'three-tip-list',
    title: 'What arrives in January',
    slots: {
      heading: 'What should be arriving',
      tipOne: 'W-2s by January 31.',
      tipTwo: '1099-NECs by January 31.',
      tipThree: 'Brokerage 1099s in February, and often corrected in March.',
    },
    baseCopy:
      'What should be arriving this month, and the one that will arrive twice. Do not file on ' +
      'the first version of a brokerage 1099.',
    localTime: '2026-01-20T10:00',
    accounts: ['x', 'threads', 'facebook'],
    performance: 'mid',
  },
  {
    key: 'deduction-myth-meals',
    templateSlug: 'big-number',
    trendKey: 'deduction-myths',
    personaKey: 'myth-buster',
    title: 'Meals are not 100%',
    slots: {
      stat: '50%',
      context: 'Business meals. Not 100%. That rule expired at the end of 2022.',
    },
    baseCopy:
      'Business meals are 50% deductible. Not 100%. That was a pandemic-era rule and it ' +
      'expired at the end of 2022.',
    localTime: '2026-02-04T11:45',
    accounts: ['x', 'threads'],
    performance: 'high',
  },
  {
    key: 'receipts-confession',
    templateSlug: 'behind-the-scenes',
    trendKey: 'receipts-shoebox',
    title: 'The shoebox',
    slots: {
      photo: { asset: 'receipt-pile' },
      caption: 'A client brought this in a shoebox. We sorted it. It took four hours.',
    },
    baseCopy:
      'A client brought this in a shoebox. We sorted it, because that is the job. It took ' +
      'four hours and it did not need to.',
    localTime: '2026-02-14T15:00',
    accounts: ['threads', 'facebook'],
    performance: 'mid',
  },
  {
    key: 'march-quarterly',
    templateSlug: 'big-number',
    trendKey: 'quarterly-estimates-panic',
    personaKey: 'deadline-coach',
    title: 'Q1 estimate',
    slots: { stat: 'Apr 15', context: 'Q1 estimate is due the same day as your return. Both.' },
    baseCopy:
      'The Q1 estimate is due the same day as your return. Both. People pay one and forget ' +
      'the other every single year.',
    localTime: '2026-03-31T09:00',
    accounts: ['x', 'threads', 'facebook'],
    destination: 'https://taxdedux.example/quarterly',
    performance: 'high',
  },
  {
    key: 'april-15',
    templateSlug: 'announcement-card',
    personaKey: 'deadline-coach',
    title: 'Filing day',
    slots: {
      eyebrow: 'TODAY',
      headline: 'April 15',
      detail: 'If you cannot file, file the extension. It is free and it takes four minutes.',
    },
    baseCopy:
      'If you cannot file today, file the extension. It is free, it takes four minutes, and ' +
      'it removes the expensive penalty.',
    localTime: '2026-04-15T08:30',
    accounts: ['x', 'threads', 'facebook'],
    performance: 'high',
  },
  {
    key: 'post-season-quiet',
    templateSlug: 'question-hook',
    title: 'What did we get wrong?',
    slots: {
      question: 'What is the one tax rule you still find genuinely confusing?',
      prompt: 'No wrong answers',
    },
    baseCopy:
      'What is the one rule you still find genuinely confusing? We will write about whichever ' +
      'one gets said most.',
    localTime: '2026-05-06T14:00',
    accounts: ['threads', 'x'],
    performance: 'low',
  },
  {
    key: 'summer-bookkeeping',
    templateSlug: 'five-step-checklist',
    title: 'A quiet-month reset',
    slots: {
      heading: 'A June bookkeeping reset',
      stepOne: 'Reconcile every account through May.',
      stepTwo: 'Separate the personal card charges you keep telling yourself you will sort.',
      stepThree: 'Set the Q2 estimate aside now.',
      stepFour: 'Back up the year so far.',
    },
    baseCopy: 'June is the cheapest month to fix your books. Four steps, one afternoon.',
    localTime: '2026-06-09T12:15',
    accounts: ['x', 'facebook'],
    destination: 'https://taxdedux.example/reset',
    performance: 'mid',
  },
  {
    key: 'weekend-midday-myth',
    templateSlug: 'plain-text-take',
    trendKey: 'deduction-myths',
    personaKey: 'myth-buster',
    title: 'Write it off',
    slots: {
      body:
        '"Just write it off" is not a strategy. A deduction returns your marginal rate, not ' +
        'the price. Spending a dollar to save thirty cents is still spending a dollar.',
    },
    baseCopy:
      '"Just write it off" is not a strategy. A deduction returns your marginal rate, not the ' +
      'price of the thing.',
    mediaType: MediaType.TEXT,
    localTime: '2026-03-14T11:30',
    accounts: ['x', 'threads'],
    performance: 'high',
  },
  {
    key: 'weekend-early-filing',
    templateSlug: 'three-tip-list',
    title: 'Saturday filing session',
    slots: {
      heading: 'Before you sit down',
      tipOne: 'Last year’s return, open.',
      tipTwo: 'Every 1099, not most of them.',
      tipThree: 'Your bank details, for the refund.',
    },
    baseCopy: 'If you are filing this weekend, have these three things open before you start.',
    localTime: '2026-02-28T08:15',
    scheduleSource: ScheduleSource.EXPLORATION,
    accounts: ['facebook', 'threads'],
    performance: 'low',
  },
  {
    key: 'weekend-afternoon-extension',
    templateSlug: 'testimonial-quote',
    title: 'A client note',
    slots: {
      quote:
        'You told me the extension was not a red flag. I stopped panicking and filed properly.',
      attribution: 'A client, October',
    },
    baseCopy:
      '"You told me the extension was not a red flag." It is not. It is a filing option, and ' +
      'it is the right one more often than people think.',
    localTime: '2026-04-11T16:00',
    accounts: ['facebook', 'x'],
    performance: 'mid',
  },
  {
    key: 'weekend-evening-quiet',
    templateSlug: 'question-hook',
    title: 'Sunday question',
    slots: {
      question: 'Do you do your own books, or has someone talked you out of it?',
      prompt: 'Curious',
    },
    baseCopy: 'Do you do your own books, or has someone talked you out of it? Genuinely curious.',
    localTime: '2026-07-19T19:30',
    accounts: ['threads'],
    performance: 'low',
  },
  {
    key: 'weekday-evening-deduction',
    templateSlug: 'stat-with-photo',
    title: 'The office corner',
    slots: {
      background: { asset: 'office-corner' },
      stat: '$1,520',
      context: 'A 120 sq ft office at the simplified rate. Not nothing.',
    },
    baseCopy:
      'A 120 square foot office at the simplified rate is $600. At actual expense it was ' +
      '$1,520 for this client. The method matters.',
    localTime: '2026-08-18T19:00',
    accounts: ['x', 'facebook'],
    performance: 'mid',
  },
  {
    key: 'weekday-early-reminder',
    templateSlug: 'plain-text-take',
    title: 'Morning reminder',
    slots: {
      body:
        'If you are self-employed and you have never once set aside tax money monthly, start ' +
        'this month. Any amount. The habit is the hard part, not the arithmetic.',
    },
    baseCopy:
      'If you have never set aside tax money monthly, start this month. Any amount. The habit ' +
      'is the hard part.',
    mediaType: MediaType.TEXT,
    localTime: '2026-01-08T07:00',
    scheduleSource: ScheduleSource.SUGGESTED,
    accounts: ['x'],
    performance: 'mid',
  },
];

const TAXDEDUX_UPCOMING: UpcomingPostSpec[] = [
  {
    key: 'upcoming-q3',
    templateSlug: 'big-number',
    trendKey: 'quarterly-estimates-panic',
    personaKey: 'deadline-coach',
    title: 'Next quarterly reminder',
    slots: { stat: 'Jan 15', context: 'Q4 estimate. The one people skip because of the holidays.' },
    baseCopy: 'Q4 estimate is due January 15. It is the one people skip because of the holidays.',
    inDays: 5,
    atLocalTime: '11:00',
    scheduleSource: ScheduleSource.SUGGESTED,
    accounts: ['x', 'threads', 'facebook'],
    status: PostStatus.SCHEDULED,
    performance: 'mid',
  },
  {
    key: 'ready-audit-myth',
    templateSlug: 'plain-text-take',
    trendKey: 'deduction-myths',
    title: 'Audit odds (ready)',
    slots: {
      body:
        'Audit rates for returns under $200k of income are well under 1%. Filing an honest ' +
        'return with an unusual-looking deduction is not what draws attention.',
    },
    baseCopy: 'Audit rates under $200k are well under 1%. An honest unusual deduction is fine.',
    mediaType: MediaType.TEXT,
    inDays: 1,
    atLocalTime: '12:30',
    accounts: ['x', 'threads'],
    status: PostStatus.READY,
    performance: 'mid',
  },
];

const POSTS_BY_BRAND: Record<string, { published: PostSpec[]; upcoming: UpcomingPostSpec[] }> = {
  'rise-and-shore': { published: RISE_AND_SHORE_POSTS, upcoming: RISE_AND_SHORE_UPCOMING },
  taxdedux: { published: TAXDEDUX_POSTS, upcoming: TAXDEDUX_UPCOMING },
};

// ─── Generation ──────────────────────────────────────────────────────────────────

const PERFORMANCE_BASELINE = {
  low: { impressions: 420, engagementRate: 0.021, clicks: 4 },
  mid: { impressions: 1650, engagementRate: 0.038, clicks: 22 },
  high: { impressions: 5400, engagementRate: 0.062, clicks: 86 },
} as const;

/** The eight-bucket key from docs/06, derived the same way the scorer will derive it. */
export function scheduleSlotFor(instant: Date, timeZone: string): string | null {
  const daypart = daypartForHour(Number(utcToZonedTime(instant, timeZone).slice(11, 13)));
  if (!daypart) return null;
  return `${isWeekendInZone(instant, timeZone) ? 'weekend' : 'weekday'}:${daypart}`;
}

/** A local wall time `days` from now, in the brand's zone. Keeps future posts future. */
function upcomingLocalTime(now: Date, timeZone: string, days: number, hhmm: string): string {
  const today = utcToZonedTime(now, timeZone).slice(0, 10);
  const shifted = new Date(Date.parse(`${today}T00:00:00Z`) + days * DAY_MS);
  return `${shifted.toISOString().slice(0, 10)}T${hhmm}`;
}

function resolveSlotValues(
  brandSlug: string,
  slots: Record<string, SlotValueSpec>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(slots).map(([name, value]) => [
      name,
      typeof value === 'string' ? value : { assetId: assetId(brandSlug, value.asset) },
    ]),
  );
}

interface SeedHistoryResult {
  posts: number;
  targets: number;
  metrics: number;
  clicks: number;
  generations: number;
}

export async function seedHistory(
  db: Db,
  spec: WorkspaceSpec,
  now: Date,
): Promise<SeedHistoryResult> {
  const brand = spec.brand;
  const bId = brandId(brand.slug);
  const tz = brand.timezone;
  const plan = POSTS_BY_BRAND[brand.slug];
  if (!plan) throw new Error(`No seeded history for brand "${brand.slug}"`);

  const result: SeedHistoryResult = { posts: 0, targets: 0, metrics: 0, clicks: 0, generations: 0 };

  for (const post of plan.published) {
    const publishedAt = zonedTimeToUtc(post.localTime, tz);
    if (publishedAt.getTime() > now.getTime()) {
      throw new Error(
        `Seeded post "${post.key}" is dated ${post.localTime}, which is in the future. ` +
          'Published history must stay in the past — use the upcoming list instead.',
      );
    }
    await seedPost(db, { spec, post, bId, tz, now, publishedAt, result });
  }

  for (const upcoming of plan.upcoming) {
    const localTime = upcomingLocalTime(now, tz, upcoming.inDays, upcoming.atLocalTime);
    await seedPost(db, {
      spec,
      post: { ...upcoming, localTime },
      bId,
      tz,
      now,
      publishedAt: null,
      status: upcoming.status,
      result,
    });
  }

  return result;
}

interface SeedPostContext {
  spec: WorkspaceSpec;
  post: PostSpec;
  bId: string;
  tz: string;
  now: Date;
  publishedAt: Date | null;
  status?: PostStatus;
  result: SeedHistoryResult;
}

async function seedPost(db: Db, ctx: SeedPostContext): Promise<void> {
  const { post, bId, tz, now, publishedAt, result } = ctx;
  const brand = ctx.spec.brand;
  const rng = createRng(`post:${brand.slug}:${post.key}`);
  const scheduledAt = publishedAt ?? zonedTimeToUtc(post.localTime, tz);
  const mediaType = post.mediaType ?? MediaType.IMAGE;
  const status = ctx.status ?? PostStatus.PUBLISHED;

  const pId = seedId('post', brand.slug, post.key);
  const postData = {
    brandId: bId,
    templateId: post.templateSlug ? templateId(post.templateSlug) : null,
    templateVersion: post.templateSlug ? 1 : null,
    trendId: post.trendKey ? trendId(post.trendKey) : null,
    personaId: post.personaKey ? personaId(brand.slug, post.personaKey) : null,
    title: post.title,
    slotValues: resolveSlotValues(brand.slug, post.slots),
    baseCopy: post.baseCopy,
    status,
    mediaType,
    // A draft has no date at all; everything else stores the instant *and* the intent.
    scheduledAt: status === PostStatus.DRAFT ? null : scheduledAt,
    scheduledLocal: status === PostStatus.DRAFT ? null : post.localTime,
    scheduledTz: status === PostStatus.DRAFT ? null : tz,
    scheduleSource: post.scheduleSource ?? ScheduleSource.USER,
    scheduleSlot: status === PostStatus.DRAFT ? null : scheduleSlotFor(scheduledAt, tz),
    createdAt: new Date(scheduledAt.getTime() - randomInt(rng, 1, 6) * DAY_MS),
  };

  await db.post.upsert({ where: { id: pId }, create: { id: pId, ...postData }, update: postData });
  result.posts += 1;

  // Renditions: an IMAGE post has one per ratio its template supports; a TEXT post has
  // none at all, which the publish and analytics paths both have to tolerate.
  const renditionIds: Partial<Record<AspectRatio, string>> = {};
  if (mediaType === MediaType.IMAGE) {
    const ratios = post.ratios ?? [AspectRatio.SQUARE_1_1, AspectRatio.PORTRAIT_4_5];
    for (const ratio of ratios) {
      const rId = seedId('rendition', brand.slug, post.key, ratio);
      const dimensions = ratio === AspectRatio.SQUARE_1_1 ? [1080, 1080] : [1080, 1350];
      const data = {
        postId: pId,
        mediaType: MediaType.IMAGE,
        aspectRatio: ratio,
        storageKey: `seed/${brand.slug}/renditions/${post.key}-${ratio.toLowerCase()}.png`,
        mimeType: 'image/png',
        width: dimensions[0]!,
        height: dimensions[1]!,
        bytes: jitter(rng, 480_000, 0.35),
        renderedAt: new Date(scheduledAt.getTime() - 2 * HOUR_MS),
        rendererMeta: {
          renderer: 'seed',
          durationMs: randomInt(rng, 180, 900),
          templateSlug: post.templateSlug ?? undefined,
        },
      };
      await db.rendition.upsert({ where: { id: rId }, create: { id: rId, ...data }, update: data });
      renditionIds[ratio] = rId;
    }
  }

  // Short link, if the post carried a tracked destination.
  let shortLinkId: string | null = null;
  if (post.destination) {
    shortLinkId = seedId('short-link', brand.slug, post.key);
    const slug = `${brand.slug.slice(0, 2)}${post.key.replace(/[^a-z0-9]/g, '').slice(0, 8)}`;
    const data = {
      slug,
      brandId: bId,
      postId: pId,
      platform: null,
      destinationUrl: post.destination,
      createdAt: new Date(scheduledAt.getTime() - HOUR_MS),
    };
    await db.shortLink.upsert({
      where: { id: shortLinkId },
      create: { id: shortLinkId, ...data },
      update: data,
    });
  }

  const baseline = PERFORMANCE_BASELINE[post.performance];

  for (const accountKey of post.accounts) {
    const account = brand.accounts.find((candidate) => candidate.key === accountKey);
    if (!account) throw new Error(`Post "${post.key}" targets unknown account "${accountKey}"`);

    const tId = seedId('post-target', brand.slug, post.key, accountKey);
    const isPublished = status === PostStatus.PUBLISHED;
    // Instagram cannot carry a text-only post; a target that exists but never publishes is
    // a real state the UI has to render.
    const unsupported = mediaType === MediaType.TEXT && account.platform === Platform.INSTAGRAM;

    const targetData = {
      postId: pId,
      platform: account.platform,
      socialAccountId: socialAccountId(brand.slug, accountKey),
      caption: post.baseCopy,
      renditionId:
        mediaType === MediaType.IMAGE
          ? (renditionIds[AspectRatio.PORTRAIT_4_5] ?? renditionIds[AspectRatio.SQUARE_1_1] ?? null)
          : null,
      scheduledFor: status === PostStatus.DRAFT ? null : scheduledAt,
      status: unsupported
        ? TargetStatus.FAILED
        : isPublished
          ? TargetStatus.PUBLISHED
          : status === PostStatus.DRAFT
            ? TargetStatus.DRAFT
            : TargetStatus.SCHEDULED,
      externalPostId: isPublished && !unsupported ? `seed-${post.key}-${accountKey}` : null,
      externalUrl:
        isPublished && !unsupported
          ? `https://${account.platform.toLowerCase()}.example/${account.handle}/${post.key}`
          : null,
      publishedAt: isPublished && !unsupported ? publishedAt : null,
      attempts: unsupported ? 3 : isPublished ? 1 : 0,
      lastError: unsupported
        ? 'Instagram requires media. Text-only posts are not supported.'
        : null,
    };

    await db.postTarget.upsert({
      where: { id: tId },
      create: { id: tId, ...targetData },
      update: targetData,
    });
    result.targets += 1;

    if (!isPublished || unsupported || !publishedAt) continue;

    // Clicks before metrics: `PostMetric.linkClicks` is first-party and derived, so it has
    // to agree with the rows it is derived from.
    const clickTimes: Date[] = [];
    if (shortLinkId) {
      const total = jitter(rng, baseline.clicks, 0.4);
      for (let index = 0; index < total; index += 1) {
        // Front-loaded: most clicks land in the first few hours.
        const offsetMs = Math.round(Math.pow(rng(), 2.4) * 72 * HOUR_MS);
        const occurredAt = new Date(publishedAt.getTime() + offsetMs);
        // Link-preview crawlers hit within seconds of publish. Unfiltered they would
        // poison the outcome signal the whole feedback loop rests on (docs/06).
        const isBot = index < 2;
        const cId = seedId('link-click', brand.slug, post.key, accountKey, String(index));
        const data = {
          shortLinkId,
          occurredAt: isBot ? new Date(publishedAt.getTime() + index * 1500) : occurredAt,
          ipHash: `seed-hash-${randomInt(rng, 1000, 9999)}`,
          userAgent: isBot ? 'facebookexternalhit/1.1' : 'Mozilla/5.0 (seed)',
          referrer: `https://${account.platform.toLowerCase()}.example/`,
          country: 'US',
          deviceType: rng() > 0.35 ? 'mobile' : 'desktop',
          isBot,
        };
        await db.linkClick.upsert({
          where: { id: cId },
          create: { id: cId, ...data },
          update: data,
        });
        result.clicks += 1;
        if (!isBot) clickTimes.push(data.occurredAt);
      }
    }

    // Snapshots, not totals: platform counters keep moving for days, and "at 24h" is the
    // only way to compare two posts like for like (docs/06).
    for (const hoursAfter of [1, 24, 72]) {
      const capturedAt = new Date(publishedAt.getTime() + hoursAfter * HOUR_MS);
      if (capturedAt.getTime() > now.getTime()) continue;

      // Roughly 45% of the eventual total lands in the first hour, 85% by 24h.
      const maturity = hoursAfter === 1 ? 0.45 : hoursAfter === 24 ? 0.85 : 1;
      const impressions = jitter(rng, baseline.impressions * maturity, 0.18);
      const engagements = Math.round(impressions * baseline.engagementRate);

      const mId = seedId('post-metric', brand.slug, post.key, accountKey, String(hoursAfter));
      const data = {
        postTargetId: tId,
        capturedAt,
        source: 'seed',
        impressions,
        reach: Math.round(impressions * 0.78),
        likes: Math.round(engagements * 0.66),
        comments: Math.round(engagements * 0.12),
        shares: Math.round(engagements * 0.09),
        // Saves are the outcome docs/06 weights highest for expertise-led brands.
        saves: Math.round(engagements * 0.13),
        profileVisits: Math.round(impressions * 0.012),
        linkClicks: clickTimes.filter((time) => time.getTime() <= capturedAt.getTime()).length,
        raw: { source: 'seed', capturedAtHours: hoursAfter },
      };
      await db.postMetric.upsert({
        where: { id: mId },
        create: { id: mId, ...data },
        update: data,
      });
      result.metrics += 1;
    }
  }

  // AI telemetry for the posts that would have been drafted by the model, so W8 has cost
  // and latency data to build reporting against rather than an empty table.
  if (post.templateSlug && rng() > 0.45) {
    const gId = seedId('ai-generation', brand.slug, post.key);
    const promptTokens = randomInt(rng, 420, 980);
    const completionTokens = randomInt(rng, 90, 320);
    const data = {
      brandId: bId,
      postId: pId,
      purpose: 'caption',
      provider: 'openai',
      model: 'gpt-4o-mini',
      prompt:
        `Write a ${post.templateSlug} post for ${brand.name}. Voice: ` +
        `${brand.voiceGuide.toneAttributes.join(', ')}. Never open with: ` +
        `${brand.voiceGuide.bannedOpeners.join(' / ')}.`,
      response: post.baseCopy,
      responseTimeMs: randomInt(rng, 700, 4200),
      promptTokens,
      completionTokens,
      // Illustrative only — W8 computes real cost from provider pricing.
      estimatedCost: Number(
        ((promptTokens * 0.00000015 + completionTokens * 0.0000006) as number).toFixed(6),
      ),
      createdAt: new Date(scheduledAt.getTime() - randomInt(rng, 2, 48) * HOUR_MS),
    };
    await db.aiGeneration.upsert({
      where: { id: gId },
      create: { id: gId, ...data },
      update: data,
    });
    result.generations += 1;
  }
}

import {
  AccountStatus,
  AssetKind,
  CredentialMode,
  CredentialStatus,
  PersonaStatus,
  Platform,
  Role,
} from '@prisma/client';
import type { Db } from '../../src/platform/db';
import {
  BrandGoalsSchema,
  BrandPaletteSchema,
  BrandTypographySchema,
  BrandVoiceGuideSchema,
  type BrandGoals,
  type BrandPalette,
  type BrandTypography,
  type BrandVoiceGuide,
} from '../../src/modules/brand/brand.schemas';
import {
  PersonaModifiersSchema,
  type PersonaModifiers,
} from '../../src/modules/brand/persona.schemas';
import {
  CredentialCapabilitiesSchema,
  PlatformMetaSchema,
  type CredentialCapabilities,
  type PlatformMeta,
} from '../../src/modules/publish/credential.schemas';
import { categoryId } from './taxonomy';
import { seedId } from './deterministic';

/**
 * The two seeded tenants.
 *
 * They are two *workspaces*, not two brands in one workspace, because that is the tenancy
 * boundary ADR-0010 defines and the one most easily broken by accident: a query missing a
 * workspace filter looks correct against single-tenant data and leaks against this.
 * Rise & Shore and TaxDedux are modelled on the two live systems in docs/11, so what W6
 * ports has somewhere realistic to land.
 *
 * They differ deliberately — different categories, timezones, platform mixes, credential
 * modes, posting rhythms and media types — because a seed where both tenants look alike
 * lets a whole class of bug through.
 *
 * Every credential value here is visibly fake. Seed files get copied into scratch scripts
 * and pasted into issues by people who assume the contents are inert, so a seeded secret
 * that merely *looks* plausible is a real hazard; these cannot be mistaken for live ones.
 */

const FAKE = 'seed-fake-not-a-real-token';

export interface SocialAccountSpec {
  key: string;
  platform: Platform;
  externalId: string;
  handle: string;
  displayName: string;
  scopes: string[];
  platformMeta: PlatformMeta;
  /** Which credential minted the token, by key. */
  credentialKey: string;
  status?: AccountStatus;
  lastError?: string;
  /** Days from now; negative is in the past (an expired token). */
  expiresInDays?: number;
}

export interface CredentialSpec {
  key: string;
  platform: Platform;
  mode: CredentialMode;
  label: string;
  appId?: string;
  appSecret?: string;
  redirectUri?: string;
  directToken?: string;
  directTokenSecret?: string;
  systemUserToken?: string;
  grantedScopes: string[];
  requiredScopes: string[];
  capabilities: CredentialCapabilities;
  status: CredentialStatus;
  lastError?: string;
}

export interface AssetSpec {
  key: string;
  kind: AssetKind;
  storageKey: string;
  mimeType: string;
  width?: number;
  height?: number;
  bytes: number;
  altText: string;
  tags: string[];
}

export interface PersonaSpec {
  key: string;
  name: string;
  description: string;
  status: PersonaStatus;
  source: string;
  modifiers: PersonaModifiers;
}

export interface BrandSpec {
  slug: string;
  name: string;
  website: string;
  categorySlug: string;
  timezone: string;
  palette: BrandPalette;
  typography: BrandTypography;
  voiceGuide: BrandVoiceGuide;
  goals: BrandGoals;
  targetPlatforms: Platform[];
  logoAssetKey: string;
  assets: AssetSpec[];
  personas: PersonaSpec[];
  credentials: CredentialSpec[];
  accounts: SocialAccountSpec[];
}

export interface WorkspaceSpec {
  slug: string;
  name: string;
  owner: { email: string; name: string };
  brand: BrandSpec;
}

/** Present in every workspace, so multi-workspace membership is exercised by default. */
export const SHARED_ADMIN = {
  email: process.env.SEED_ADMIN_EMAIL?.trim().toLowerCase() || 'sara@buzzalicious.example',
  name: 'Sara (Buzzalicious)',
};

function fullCapabilities(
  extra: Record<string, { supported: boolean; reason?: string; missingScopes?: string[] }> = {},
): CredentialCapabilities {
  return CredentialCapabilitiesSchema.parse({
    publish_image: { supported: true },
    publish_text: { supported: true },
    read_insights: { supported: true },
    ...extra,
  });
}

export const WORKSPACES: WorkspaceSpec[] = [
  {
    slug: 'rise-and-shore',
    name: 'Rise & Shore',
    owner: { email: 'owner@riseandshore.example', name: 'Dana Whitlock' },
    brand: {
      slug: 'rise-and-shore',
      name: 'Rise & Shore',
      website: 'https://riseandshore.example',
      categorySlug: 'vacation-rental',
      // Coastal South Carolina. Eastern time — deliberately different from TaxDedux, so a
      // bug that assumes one server-wide zone shows up in the seed rather than in prod.
      timezone: 'America/New_York',
      palette: BrandPaletteSchema.parse({
        primary: '#1b4965',
        secondary: '#5fa8d3',
        accent: '#cae9ff',
        neutral: '#8a9ba8',
        background: '#fdfcf7',
        text: '#12222e',
      }),
      typography: BrandTypographySchema.parse({
        headingFamily: 'Fraunces',
        bodyFamily: 'Inter',
        headingWeight: 700,
        bodyWeight: 400,
        bodyLineHeight: 1.45,
        headingTransform: 'none',
      }),
      voiceGuide: BrandVoiceGuideSchema.parse({
        summary:
          'Warm, unhurried, and specific. We sound like a neighbour who knows which beach ' +
          'access has parking, not like a listing site.',
        toneAttributes: ['warm', 'unhurried', 'specific', 'quietly confident'],
        doSay: [
          'Name the actual beach, street or restaurant.',
          'Mention the season honestly, including the quiet months.',
          'Talk about the stay, not the transaction.',
        ],
        dontSay: [
          'Book now!',
          'Luxury getaway',
          'Anything that implies the house is bigger or closer to the water than it is.',
        ],
        vocabulary: ['porch', 'tide', 'shoulder season', 'walkable', 'screened-in'],
        sampleCopy: [
          'The marsh side gets the better sunset. Nobody believes us until October.',
          'Six minutes to the pier on foot, less if the sand is packed.',
        ],
        readingLevel: 'standard',
        emojiPolicy: 'sparing',
        bannedOpeners: ['Looking for', 'Are you ready to', 'Introducing'],
      }),
      goals: BrandGoalsSchema.parse({
        primaryGoal: 'leads',
        targetAudience:
          'Families and couples within a half-day drive of the Carolina coast, booking 3–10 ' +
          'weeks ahead.',
        callsToAction: ['Check dates', 'See the house', 'Ask us anything'],
        notes: 'Direct bookings are worth roughly three times an OTA booking after fees.',
      }),
      targetPlatforms: [Platform.INSTAGRAM, Platform.FACEBOOK, Platform.THREADS, Platform.X],
      logoAssetKey: 'logo',
      assets: [
        {
          key: 'logo',
          kind: AssetKind.LOGO,
          storageKey: 'seed/rise-and-shore/logo.png',
          mimeType: 'image/png',
          width: 800,
          height: 800,
          bytes: 24_500,
          altText: 'Rise & Shore wordmark',
          tags: ['logo', 'primary'],
        },
        {
          key: 'porch-morning',
          kind: AssetKind.PHOTO,
          storageKey: 'seed/rise-and-shore/porch-morning.jpg',
          mimeType: 'image/jpeg',
          width: 2000,
          height: 2500,
          bytes: 1_480_000,
          altText: 'Screened porch with two rocking chairs in early morning light',
          tags: ['porch', 'morning', 'exterior'],
        },
        {
          key: 'marsh-sunset',
          kind: AssetKind.PHOTO,
          storageKey: 'seed/rise-and-shore/marsh-sunset.jpg',
          mimeType: 'image/jpeg',
          width: 2400,
          height: 1600,
          bytes: 1_910_000,
          altText: 'Sun setting over tidal marsh grass',
          tags: ['marsh', 'sunset', 'landscape'],
        },
        {
          key: 'kitchen-reset',
          kind: AssetKind.PHOTO,
          storageKey: 'seed/rise-and-shore/kitchen-reset.jpg',
          mimeType: 'image/jpeg',
          width: 2000,
          height: 2500,
          bytes: 1_260_000,
          altText: 'Kitchen counter mid-turnover, clean linens stacked',
          tags: ['interior', 'behind-the-scenes'],
        },
        {
          key: 'bunk-room',
          kind: AssetKind.PHOTO,
          storageKey: 'seed/rise-and-shore/bunk-room.jpg',
          mimeType: 'image/jpeg',
          width: 2000,
          height: 2000,
          bytes: 1_150_000,
          altText: 'Bunk room with four built-in beds',
          tags: ['interior', 'family'],
        },
      ],
      personas: [
        {
          key: 'local-friend',
          name: 'The Local Friend',
          description: 'Recommends the unglamorous thing that is actually better.',
          status: PersonaStatus.APPROVED,
          source: 'manual',
          modifiers: PersonaModifiersSchema.parse({
            toneAttributes: ['candid', 'conversational'],
            addDoSay: ['Name a specific street or business.'],
            addDontSay: ['Hidden gem'],
            intensity: 0.6,
            rationale: 'Outperforms the house voice on saves for anything food- or route-related.',
          }),
        },
        {
          key: 'trip-planner',
          name: 'The Trip Planner',
          description: 'Logistics-first: drive times, parking, tides, what to pack.',
          status: PersonaStatus.SUGGESTED,
          source: 'ai',
          modifiers: PersonaModifiersSchema.parse({
            toneAttributes: ['precise', 'practical'],
            suppressToneAttributes: ['unhurried'],
            readingLevel: 'simple',
            emojiPolicy: 'none',
            intensity: 0.45,
            rationale: 'Suggested from the question-hook posts that drew the most replies.',
          }),
        },
      ],
      credentials: [
        {
          key: 'meta-direct',
          platform: Platform.INSTAGRAM,
          mode: CredentialMode.DIRECT_TOKEN,
          label: 'Rise & Shore Meta system user (migrated)',
          // The day-one migration path in ADR-0009: a long-lived token pasted in, no OAuth.
          directToken: `${FAKE}-meta-system-user`,
          systemUserToken: `${FAKE}-meta-system-user`,
          grantedScopes: [
            'instagram_basic',
            'instagram_content_publish',
            'pages_read_engagement',
            'pages_manage_posts',
          ],
          requiredScopes: ['instagram_basic', 'instagram_content_publish', 'pages_manage_posts'],
          capabilities: fullCapabilities({
            publish_carousel: { supported: true, missingScopes: [] },
          }),
          status: CredentialStatus.ACTIVE,
        },
        {
          key: 'threads-direct',
          platform: Platform.THREADS,
          mode: CredentialMode.DIRECT_TOKEN,
          label: 'Rise & Shore Threads token',
          directToken: `${FAKE}-threads`,
          grantedScopes: ['threads_basic', 'threads_content_publish'],
          requiredScopes: ['threads_basic', 'threads_content_publish'],
          capabilities: fullCapabilities(),
          status: CredentialStatus.ACTIVE,
        },
        {
          key: 'x-direct',
          platform: Platform.X,
          mode: CredentialMode.DIRECT_TOKEN,
          label: 'Rise & Shore X (OAuth 1.0a keys)',
          directToken: `${FAKE}-x-access-token`,
          // X OAuth 1.0a needs a token *and* a secret — the reason the column exists.
          directTokenSecret: `${FAKE}-x-access-secret`,
          grantedScopes: ['tweet.read', 'tweet.write', 'users.read'],
          requiredScopes: ['tweet.write'],
          capabilities: fullCapabilities({
            publish_image: { supported: true },
            // A read tier the client has not paid for. Exactly what pre-flight is for
            // (docs/10): known now, not discovered during a scheduled publish.
            read_insights: {
              supported: false,
              reason: 'The connected X app is on a tier without post metrics.',
              missingScopes: [],
            },
          }),
          status: CredentialStatus.INSUFFICIENT,
          lastError: 'Metrics unavailable on the current X API access tier.',
        },
      ],
      accounts: [
        {
          key: 'instagram',
          platform: Platform.INSTAGRAM,
          externalId: '17841400000000001',
          handle: 'riseandshore',
          displayName: 'Rise & Shore',
          scopes: ['instagram_basic', 'instagram_content_publish'],
          platformMeta: PlatformMetaSchema.parse({
            facebookPageId: '100000000000001',
            instagramBusinessAccountId: '17841400000000001',
            isBusinessAccount: true,
          }),
          credentialKey: 'meta-direct',
          expiresInDays: 45,
        },
        {
          key: 'facebook',
          platform: Platform.FACEBOOK,
          externalId: '100000000000001',
          handle: 'riseandshore',
          displayName: 'Rise & Shore',
          scopes: ['pages_manage_posts', 'pages_read_engagement'],
          platformMeta: PlatformMetaSchema.parse({ facebookPageId: '100000000000001' }),
          credentialKey: 'meta-direct',
          expiresInDays: 45,
        },
        {
          key: 'threads',
          platform: Platform.THREADS,
          externalId: '78460000000000001',
          handle: 'riseandshore',
          displayName: 'Rise & Shore',
          scopes: ['threads_basic', 'threads_content_publish'],
          platformMeta: PlatformMetaSchema.parse({ threadsUserId: '78460000000000001' }),
          credentialKey: 'threads-direct',
          expiresInDays: 20,
        },
        {
          key: 'x',
          platform: Platform.X,
          externalId: '1600000000000000001',
          handle: 'riseandshore',
          displayName: 'Rise & Shore',
          scopes: ['tweet.write'],
          platformMeta: PlatformMetaSchema.parse({ xUserId: '1600000000000000001' }),
          credentialKey: 'x-direct',
          // Already expired: the refresh sweep and the "reconnect this account" UI both
          // need a row in this state to develop against.
          expiresInDays: -3,
          status: AccountStatus.EXPIRED,
          lastError: 'Token expired. Reconnect required.',
        },
      ],
    },
  },
  {
    slug: 'taxdedux',
    name: 'TaxDedux',
    owner: { email: 'owner@taxdedux.example', name: 'Marcus Oyelaran' },
    brand: {
      slug: 'taxdedux',
      name: 'TaxDedux',
      website: 'https://taxdedux.example',
      categorySlug: 'tax-prep',
      // Central time, and a different platform mix: text-first rather than image-first.
      timezone: 'America/Chicago',
      palette: BrandPaletteSchema.parse({
        primary: '#14532d',
        secondary: '#166534',
        accent: '#dcfce7',
        neutral: '#6b7280',
        background: '#ffffff',
        text: '#111827',
      }),
      typography: BrandTypographySchema.parse({
        headingFamily: 'Inter',
        bodyFamily: 'Inter',
        headingWeight: 800,
        bodyWeight: 400,
        headingLetterSpacing: -0.5,
        headingTransform: 'none',
      }),
      voiceGuide: BrandVoiceGuideSchema.parse({
        summary:
          'Plain, exact, and unbothered. We explain one thing at a time and we never imply ' +
          'that a rule is simpler than it is.',
        toneAttributes: ['plain-spoken', 'exact', 'calm', 'faintly dry'],
        doSay: [
          'Name the form or the deadline.',
          'Say when something depends on circumstances.',
          'Give the number.',
        ],
        dontSay: [
          'The IRS hates this one trick',
          'Write it off!',
          'Anything that reads as advice for a specific filer.',
        ],
        vocabulary: ['deduction', 'quarterly estimate', 'Schedule C', 'basis', 'safe harbor'],
        sampleCopy: [
          'A home office has to be exclusive. The kitchen table is not exclusive.',
          'Missing a quarterly estimate is a penalty, not a crime. Pay it late anyway.',
        ],
        readingLevel: 'standard',
        emojiPolicy: 'none',
        bannedOpeners: ['Did you know', 'Tax season is here', 'Attention'],
      }),
      goals: BrandGoalsSchema.parse({
        primaryGoal: 'awareness',
        targetAudience:
          'Self-employed filers and small-business owners who do their own bookkeeping and ' +
          'file late.',
        callsToAction: ['Read the breakdown', 'Book a review'],
        notes: 'Saves matter more than likes here. A saved post is someone who will file.',
      }),
      targetPlatforms: [Platform.X, Platform.THREADS, Platform.FACEBOOK],
      logoAssetKey: 'logo',
      assets: [
        {
          key: 'logo',
          kind: AssetKind.LOGO,
          storageKey: 'seed/taxdedux/logo.png',
          mimeType: 'image/png',
          width: 800,
          height: 800,
          bytes: 18_200,
          altText: 'TaxDedux wordmark',
          tags: ['logo', 'primary'],
        },
        {
          key: 'desk-forms',
          kind: AssetKind.PHOTO,
          storageKey: 'seed/taxdedux/desk-forms.jpg',
          mimeType: 'image/jpeg',
          width: 2000,
          height: 2500,
          bytes: 980_000,
          altText: 'Tax forms and a calculator on a plain desk',
          tags: ['desk', 'forms'],
        },
        {
          key: 'receipt-pile',
          kind: AssetKind.PHOTO,
          storageKey: 'seed/taxdedux/receipt-pile.jpg',
          mimeType: 'image/jpeg',
          width: 2000,
          height: 2000,
          bytes: 860_000,
          altText: 'A disorganised pile of paper receipts',
          tags: ['receipts', 'humour'],
        },
        {
          key: 'office-corner',
          kind: AssetKind.PHOTO,
          storageKey: 'seed/taxdedux/office-corner.jpg',
          mimeType: 'image/jpeg',
          width: 2400,
          height: 1600,
          bytes: 1_020_000,
          altText: 'A small dedicated home-office corner',
          tags: ['home-office', 'deduction'],
        },
      ],
      personas: [
        {
          key: 'deadline-coach',
          name: 'The Deadline Coach',
          description: 'Used only in the weeks before a filing date. Urgent without panic.',
          status: PersonaStatus.APPROVED,
          source: 'manual',
          modifiers: PersonaModifiersSchema.parse({
            toneAttributes: ['direct', 'time-bound'],
            addDoSay: ['State the date.'],
            addDontSay: ['Last chance'],
            intensity: 0.7,
            rationale: 'Only appropriate inside a two-week window before a deadline.',
          }),
        },
        {
          key: 'myth-buster',
          name: 'The Myth Buster',
          description: 'Corrects a widely repeated piece of bad advice, without mockery.',
          status: PersonaStatus.SUGGESTED,
          source: 'ai',
          modifiers: PersonaModifiersSchema.parse({
            toneAttributes: ['corrective', 'patient'],
            addDontSay: ['Everyone gets this wrong'],
            intensity: 0.5,
            rationale: 'Suggested from the save rate on myth-format posts.',
          }),
        },
      ],
      credentials: [
        {
          key: 'x-client-app',
          platform: Platform.X,
          mode: CredentialMode.CLIENT_APP,
          label: 'TaxDedux X app (OAuth)',
          // The durable path in ADR-0009: the client's own app, we run the OAuth dance.
          appId: 'seed-fake-x-app-id',
          appSecret: `${FAKE}-x-app-secret`,
          redirectUri: 'https://app.buzzalicious.example/oauth/x/callback',
          grantedScopes: ['tweet.read', 'tweet.write', 'users.read', 'offline.access'],
          requiredScopes: ['tweet.write', 'offline.access'],
          capabilities: fullCapabilities(),
          status: CredentialStatus.ACTIVE,
        },
        {
          key: 'meta-direct',
          platform: Platform.FACEBOOK,
          mode: CredentialMode.DIRECT_TOKEN,
          label: 'TaxDedux Facebook Page token',
          directToken: `${FAKE}-facebook-page`,
          grantedScopes: ['pages_manage_posts', 'pages_read_engagement'],
          requiredScopes: ['pages_manage_posts'],
          capabilities: fullCapabilities(),
          status: CredentialStatus.ACTIVE,
        },
        {
          key: 'threads-direct',
          platform: Platform.THREADS,
          mode: CredentialMode.DIRECT_TOKEN,
          label: 'TaxDedux Threads token',
          directToken: `${FAKE}-threads-taxdedux`,
          grantedScopes: ['threads_basic', 'threads_content_publish'],
          requiredScopes: ['threads_basic', 'threads_content_publish'],
          capabilities: fullCapabilities(),
          status: CredentialStatus.ACTIVE,
        },
      ],
      accounts: [
        {
          key: 'x',
          platform: Platform.X,
          externalId: '1600000000000000002',
          handle: 'taxdedux',
          displayName: 'TaxDedux',
          scopes: ['tweet.write', 'offline.access'],
          platformMeta: PlatformMetaSchema.parse({ xUserId: '1600000000000000002' }),
          credentialKey: 'x-client-app',
          expiresInDays: 90,
        },
        {
          key: 'threads',
          platform: Platform.THREADS,
          externalId: '78460000000000002',
          handle: 'taxdedux',
          displayName: 'TaxDedux',
          scopes: ['threads_basic', 'threads_content_publish'],
          platformMeta: PlatformMetaSchema.parse({ threadsUserId: '78460000000000002' }),
          credentialKey: 'threads-direct',
          expiresInDays: 30,
        },
        {
          key: 'facebook',
          platform: Platform.FACEBOOK,
          externalId: '100000000000002',
          handle: 'taxdedux',
          displayName: 'TaxDedux',
          scopes: ['pages_manage_posts'],
          platformMeta: PlatformMetaSchema.parse({ facebookPageId: '100000000000002' }),
          credentialKey: 'meta-direct',
          expiresInDays: 60,
        },
      ],
    },
  },
];

const DAY_MS = 24 * 60 * 60 * 1000;

export const workspaceId = (slug: string): string => seedId('workspace', slug);
export const userId = (email: string): string => seedId('user', email);
export const brandId = (slug: string): string => seedId('brand', slug);
export const assetId = (brandSlug: string, key: string): string => seedId('asset', brandSlug, key);
export const personaId = (brandSlug: string, key: string): string =>
  seedId('persona', brandSlug, key);
export const credentialId = (brandSlug: string, key: string): string =>
  seedId('credential', brandSlug, key);
export const socialAccountId = (brandSlug: string, key: string): string =>
  seedId('social-account', brandSlug, key);

/** Seeds workspaces, users, memberships, brands, assets, personas, credentials, accounts. */
export async function seedWorkspaces(db: Db, now: Date): Promise<number> {
  const sharedAdmin = await db.user.upsert({
    where: { email: SHARED_ADMIN.email },
    create: { id: userId(SHARED_ADMIN.email), ...SHARED_ADMIN },
    update: { name: SHARED_ADMIN.name },
  });
  const sharedAdminId = sharedAdmin.id;

  for (const spec of WORKSPACES) {
    const wsId = workspaceId(spec.slug);
    await db.workspace.upsert({
      where: { id: wsId },
      create: { id: wsId, name: spec.name, slug: spec.slug },
      update: { name: spec.name, slug: spec.slug },
    });

    const ownerId = userId(spec.owner.email);
    await db.user.upsert({
      where: { id: ownerId },
      create: { id: ownerId, ...spec.owner },
      update: { name: spec.owner.name },
    });

    for (const [memberId, role] of [
      [ownerId, Role.OWNER],
      // The agency case ADR-0010 exists for: one person across several clients.
      [sharedAdminId, Role.ADMIN],
    ] as const) {
      const id = seedId('membership', spec.slug, memberId);
      await db.membership.upsert({
        where: { id },
        create: { id, userId: memberId, workspaceId: wsId, role },
        update: { role },
      });
    }

    await seedBrand(db, spec, wsId, now);
  }

  return WORKSPACES.length;
}

async function seedBrand(db: Db, spec: WorkspaceSpec, wsId: string, now: Date): Promise<void> {
  const brand = spec.brand;
  const id = brandId(brand.slug);

  // Assets first: the brand references its logo.
  for (const asset of brand.assets) {
    const aId = assetId(brand.slug, asset.key);
    const data = {
      brandId: id,
      kind: asset.kind,
      storageKey: asset.storageKey,
      mimeType: asset.mimeType,
      width: asset.width ?? null,
      height: asset.height ?? null,
      bytes: asset.bytes,
      source: 'seed',
      altText: asset.altText,
      tags: asset.tags,
    };
    // The Brand row must exist before its assets can point at it, so the brand is written
    // twice: once without a logo, then updated once the asset exists.
    await db.brand.upsert({
      where: { id },
      create: {
        id,
        workspaceId: wsId,
        name: brand.name,
        slug: brand.slug,
        website: brand.website,
        categoryId: categoryId(brand.categorySlug),
        palette: brand.palette,
        typography: brand.typography,
        voiceGuide: brand.voiceGuide,
        goals: brand.goals,
        targetPlatforms: brand.targetPlatforms,
        timezone: brand.timezone,
      },
      update: {},
    });
    await db.asset.upsert({ where: { id: aId }, create: { id: aId, ...data }, update: data });
  }

  await db.brand.update({
    where: { id },
    data: {
      name: brand.name,
      website: brand.website,
      categoryId: categoryId(brand.categorySlug),
      logoAssetId: assetId(brand.slug, brand.logoAssetKey),
      palette: brand.palette,
      typography: brand.typography,
      voiceGuide: brand.voiceGuide,
      goals: brand.goals,
      targetPlatforms: brand.targetPlatforms,
      timezone: brand.timezone,
      deletedAt: null,
    },
  });

  for (const persona of brand.personas) {
    const pId = personaId(brand.slug, persona.key);
    const data = {
      brandId: id,
      name: persona.name,
      description: persona.description,
      modifiers: persona.modifiers,
      status: persona.status,
      source: persona.source,
    };
    await db.personaLayer.upsert({
      where: { id: pId },
      create: { id: pId, ...data },
      update: data,
    });
  }

  for (const credential of brand.credentials) {
    const cId = credentialId(brand.slug, credential.key);
    const data = {
      workspaceId: wsId,
      brandId: id,
      platform: credential.platform,
      mode: credential.mode,
      label: credential.label,
      appId: credential.appId ?? null,
      // Written as plaintext here and encrypted by the Prisma extension on the way in.
      appSecret: credential.appSecret ?? null,
      redirectUri: credential.redirectUri ?? null,
      directToken: credential.directToken ?? null,
      directTokenSecret: credential.directTokenSecret ?? null,
      systemUserToken: credential.systemUserToken ?? null,
      grantedScopes: credential.grantedScopes,
      requiredScopes: credential.requiredScopes,
      capabilities: credential.capabilities,
      status: credential.status,
      lastValidatedAt: now,
      lastError: credential.lastError ?? null,
    };
    await db.platformCredential.upsert({
      where: { id: cId },
      create: { id: cId, ...data },
      update: data,
    });
  }

  for (const account of brand.accounts) {
    const aId = socialAccountId(brand.slug, account.key);
    const data = {
      brandId: id,
      platform: account.platform,
      externalId: account.externalId,
      handle: account.handle,
      displayName: account.displayName,
      accessToken: `${FAKE}-${brand.slug}-${account.key}-access`,
      refreshToken:
        account.platform === Platform.X ? `${FAKE}-${brand.slug}-${account.key}-refresh` : null,
      tokenSecret:
        account.platform === Platform.X ? `${FAKE}-${brand.slug}-${account.key}-secret` : null,
      expiresAt:
        account.expiresInDays === undefined
          ? null
          : new Date(now.getTime() + account.expiresInDays * DAY_MS),
      scopes: account.scopes,
      credentialId: credentialId(brand.slug, account.credentialKey),
      platformMeta: account.platformMeta,
      status: account.status ?? AccountStatus.ACTIVE,
      lastError: account.lastError ?? null,
      lastValidatedAt: now,
    };
    await db.socialAccount.upsert({
      where: { id: aId },
      create: { id: aId, ...data },
      update: data,
    });
  }
}

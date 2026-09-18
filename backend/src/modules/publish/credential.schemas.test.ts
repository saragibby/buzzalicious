import { describe, expect, it } from 'vitest';
import { CredentialCapabilitiesSchema, PlatformMetaSchema } from './credential.schemas';

describe('PlatformMetaSchema', () => {
  it('accepts the Instagram-via-Facebook-Page shape', () => {
    const parsed = PlatformMetaSchema.parse({
      facebookPageId: '1234567890',
      instagramBusinessAccountId: '17841400000000000',
      isBusinessAccount: true,
    });
    expect(parsed.facebookPageId).toBe('1234567890');
  });

  it('keeps unknown adapter keys rather than dropping them', () => {
    // A platform adding a required id should not need a migration, and silently dropping
    // it on write would break publishing in a way that looks like a platform outage.
    const parsed = PlatformMetaSchema.parse({ tiktokOpenId: 'abc' });
    expect(parsed).toMatchObject({ tiktokOpenId: 'abc' });
  });

  it('rejects a known id given as a number', () => {
    expect(PlatformMetaSchema.safeParse({ facebookPageId: 1234567890 }).success).toBe(false);
  });
});

describe('CredentialCapabilitiesSchema', () => {
  it('accepts a pre-flight report naming the missing scope', () => {
    const parsed = CredentialCapabilitiesSchema.parse({
      publish_image: { supported: true },
      read_insights: {
        supported: false,
        reason: 'The app is not approved for insights',
        missingScopes: ['instagram_manage_insights'],
      },
    });
    expect(parsed.read_insights?.missingScopes).toEqual(['instagram_manage_insights']);
  });

  it('defaults missingScopes so the report is never undefined', () => {
    const parsed = CredentialCapabilitiesSchema.parse({ publish_text: { supported: true } });
    expect(parsed.publish_text?.missingScopes).toEqual([]);
  });

  it('rejects a capability we have no pre-flight check for', () => {
    expect(
      CredentialCapabilitiesSchema.safeParse({ publish_hologram: { supported: true } }).success,
    ).toBe(false);
  });

  it('rejects a report with no verdict', () => {
    expect(
      CredentialCapabilitiesSchema.safeParse({ publish_image: { reason: 'unclear' } }).success,
    ).toBe(false);
  });
});

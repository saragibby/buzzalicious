import { describe, expect, it } from 'vitest';
import { buildCaptionsFile, captionFor, exportFilename } from './export.service';
import type { DraftView } from './post.service';

/**
 * What lands in someone's Downloads folder.
 *
 * The zip is assembled against a real render in `tests/db/composer.test.ts`. This covers
 * the text files, which are the part a person actually reads — and the part that has to
 * explain `{{link}}` before it appears verbatim in an Instagram caption.
 */

function draft(overrides: Partial<DraftView> = {}): DraftView {
  return {
    id: 'post-1',
    brandId: 'brand-1',
    title: 'Spring clean offer',
    templateId: 'tpl-1',
    templateSlug: 'bold-offer',
    templateName: 'Bold offer',
    templateVersion: 1,
    slotValues: {},
    baseCopy: 'Twenty percent off all spring cleans.',
    status: 'DRAFT',
    targets: [
      { platform: 'INSTAGRAM', caption: null },
      { platform: 'X', caption: null },
    ],
    updatedAt: new Date('2026-03-01T00:00:00Z'),
    createdAt: new Date('2026-03-01T00:00:00Z'),
    ...overrides,
  };
}

describe('captionFor', () => {
  it('inherits the base caption when the override is null', () => {
    expect(captionFor(draft(), 'INSTAGRAM')).toBe('Twenty percent off all spring cleans.');
  });

  it('honours an empty override rather than resurrecting the base', () => {
    // `null` means inherit; `''` means the user deliberately cleared this platform. If the
    // two collapse, a caption someone emptied on purpose comes back at publish time.
    const cleared = draft({
      targets: [
        { platform: 'INSTAGRAM', caption: '' },
        { platform: 'X', caption: null },
      ],
    });

    expect(captionFor(cleared, 'INSTAGRAM')).toBe('');
    expect(captionFor(cleared, 'X')).toBe('Twenty percent off all spring cleans.');
  });

  it('is empty rather than undefined for an untargeted platform', () => {
    expect(captionFor(draft({ targets: [], baseCopy: null }), 'THREADS')).toBe('');
  });
});

describe('buildCaptionsFile', () => {
  it('counts each platform the way that platform counts', () => {
    // The same caption, two counts. A single length would be wrong for at least one of
    // them, and the file is what someone pastes from — it is the last chance to warn.
    const withUrl = draft({
      baseCopy: 'Book here https://example.com/a-very-long-booking-path-indeed',
    });

    const file = buildCaptionsFile(withUrl);

    // X wraps the URL to 23; Instagram counts it literally.
    expect(file).toContain('33 / 280 characters');
    expect(file).toContain('61 / 2200 characters');
  });

  it('flags an over-limit caption instead of quietly truncating it', () => {
    const tooLong = draft({
      baseCopy: 'x'.repeat(300),
      targets: [{ platform: 'X', caption: null }],
    });

    const file = buildCaptionsFile(tooLong);
    expect(file).toContain('20 over the limit');
    // The caption itself is still there in full — trimming it for the user would lose
    // words they wrote.
    expect(file).toContain('x'.repeat(300));
  });

  it('warns that an Instagram link is not clickable', () => {
    const withMarker = draft({
      baseCopy: 'Book now {{link}}',
      targets: [{ platform: 'INSTAGRAM', caption: null }],
    });

    expect(buildCaptionsFile(withMarker)).toMatch(/does not make caption links clickable/i);
  });

  it('does not warn about links on a platform where they work', () => {
    const withMarker = draft({
      baseCopy: 'Book now {{link}}',
      targets: [{ platform: 'FACEBOOK', caption: null }],
    });

    expect(buildCaptionsFile(withMarker)).not.toMatch(/not clickable/i);
  });

  it('says a caption is missing rather than leaving a blank section', () => {
    const empty = draft({ baseCopy: null, targets: [{ platform: 'X', caption: null }] });
    expect(buildCaptionsFile(empty)).toContain('(no caption written)');
  });
});

describe('exportFilename', () => {
  it('slugifies the title so the file means something in a Downloads folder', () => {
    expect(exportFilename(draft())).toBe('spring-clean-offer-buzzalicious.zip');
  });

  it('falls back to the template name, then to a generic name', () => {
    expect(exportFilename(draft({ title: null }))).toBe('bold-offer-buzzalicious.zip');
    expect(exportFilename(draft({ title: null, templateName: null }))).toBe(
      'post-buzzalicious.zip',
    );
  });

  it('produces a usable name from a title that is all punctuation', () => {
    // An empty slug would yield "-buzzalicious.zip", which some browsers refuse to save.
    expect(exportFilename(draft({ title: '!!!' }))).toBe('post-buzzalicious.zip');
  });
});

import { describe, expect, it } from 'vitest';
import { RendererMetaSchema } from './rendition.schemas';

describe('RendererMetaSchema', () => {
  it('records what produced a rendition', () => {
    const parsed = RendererMetaSchema.parse({
      satoriVersion: '0.10.13',
      resvgVersion: '2.6.2',
      templateVersion: 1,
      durationMs: 42,
    });
    expect(parsed.fonts).toEqual([]);
    expect(parsed.fittedDown).toEqual([]);
  });

  it('requires the renderer versions', () => {
    // Determinism (ADR-0002) is only a meaningful claim if a rendition can say which
    // library versions produced it. Without them, unexpected output is undiagnosable.
    expect(RendererMetaSchema.safeParse({ templateVersion: 1 }).success).toBe(false);
  });

  it('requires a positive template version', () => {
    expect(
      RendererMetaSchema.safeParse({
        satoriVersion: '0.10.13',
        resvgVersion: '2.6.2',
        templateVersion: 0,
      }).success,
    ).toBe(false);
  });
});

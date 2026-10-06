import { describe, expect, it } from 'vitest';
import { DependencySchema, hashManifest } from './index.ts';

const dependency = { id: 'sample', name: 'Sample dependency', type: 'RESOURCE', required: true,
  approved: false, healthy: false, confidence: 'DETECTED' as const };
describe('dependency evidence uncertainty', () => {
  it('preserves legacy manifests without an implicit certainty or consent-hash change', () => {
    const parsed = DependencySchema.parse(dependency);
    expect(parsed).not.toHaveProperty('certainty');
    expect(hashManifest(parsed)).toBe(hashManifest(dependency));
  });
  it('keeps discovery provenance separate from certainty and never grants permission', () => {
    for (const certainty of ['CONFIRMED', 'LIKELY', 'POSSIBLE', 'UNKNOWN']) {
      expect(DependencySchema.parse({ ...dependency, certainty })).toMatchObject({
        confidence: 'DETECTED', certainty, approved: false, healthy: false,
      });
    }
  });
  it('rejects mixing the two vocabularies', () => {
    expect(DependencySchema.safeParse({ ...dependency, certainty: 'DETECTED' }).success).toBe(false);
    expect(DependencySchema.safeParse({ ...dependency, confidence: 'CONFIRMED' }).success).toBe(false);
  });
});

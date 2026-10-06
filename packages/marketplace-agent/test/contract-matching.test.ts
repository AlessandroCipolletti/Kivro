import { randomUUID } from 'node:crypto';
import type { InputField, IOContract } from '@kivro/contracts';
import { describe, expect, it } from 'vitest';
import { inputAssetHints, matchDirectContract, matchOutputRequirements, matchPlanFinalOutputs, RequiredOutputFilesSchema,
  validatePlanEntryAssets, type ResolvedInputAsset } from '../src/contract-matching.js';

const now = new Date('2026-10-06T12:00:00Z');
const bounds = { allowedMimeTypes: ['image/png'], allowedExtensions: ['.png'], maxFileSizeBytes: 500, maxTotalSizeBytes: 1200, maxFiles: 4 };
function file(key = 'images', changes: Partial<InputField> = {}): InputField {
  return { key, label: key, type: 'FILES', required: true, order: 0, constraints: { ...bounds }, ...changes };
}
function asset(changes: Partial<ResolvedInputAsset> = {}): ResolvedInputAsset {
  return { id: randomUUID(), filename: 'private.png', mimeType: 'image/png', sizeBytes: 200, sha256: 'a'.repeat(64), ...changes };
}
function contract(inputs: InputField[] = [file()]): IOContract {
  return { schemaVersion: 1, inputs, output: { type: 'FILES', description: 'Images', required: true,
    files: { allowedMimeTypes: ['image/png'], allowedExtensions: ['.png'], maxFiles: 4, maxTotalSizeBytes: 1200 } } };
}

describe('direct contract-aware attachment preparation', () => {
  it('maps a real blend scene and three PNGs without inventing the missing resolution', () => {
    const scene = asset({ filename: 'product.blend', mimeType: 'application/x-blender' });
    const refs = [asset(), asset(), asset()];
    const definition = contract([file('scene', { type: 'FILE', constraints: { ...bounds, allowedMimeTypes: ['application/x-blender'], allowedExtensions: ['.blend'] } }),
      file(), { key: 'resolution', label: 'Resolution', order: 2, type: 'INTEGER', required: true }]);
    const result = matchDirectContract({ contract: definition, assets: [scene, ...refs], now });
    expect(result.status).toBe('NEEDS_INPUT'); expect(result.preparedInput.scene).toBe(scene.id);
    expect(new Set(result.preparedInput.images as string[])).toEqual(new Set(refs.map(item => item.id)));
    expect(result.preparedInput).not.toHaveProperty('resolution');
    expect(result.issues).toEqual([{ code: 'MISSING_INPUT', severity: 'CLARIFICATION', inputKey: 'resolution' }]);
  });
  it('hard-rejects a text-only capability for real buyer attachments', () => {
    expect(matchDirectContract({ contract: contract([]), assets: [asset()], now }).issues[0]?.code).toBe('FILE_NOT_ACCEPTED');
  });
  it.each([
    { mimeType: 'application/pdf' }, { filename: 'image.png.exe' }, { sizeBytes: 501 },
  ])('rejects incompatible actual file metadata %j', changes => {
    expect(matchDirectContract({ contract: contract(), assets: [asset(changes)], now }).status).toBe('INCOMPATIBLE');
  });
  it('accepts case-insensitive extensions without weakening MIME checks', () => {
    expect(matchDirectContract({ contract: contract(), assets: [asset({ filename: 'IMAGE.PNG' })], now }).status).toBe('READY');
  });
  it.each(['count', 'totalBytes'] as const)('rejects combined %s overflow, not only each file', kind => {
    const files = Array.from({ length: kind === 'count' ? 5 : 3 }, () => asset({ sizeBytes: kind === 'count' ? 1 : 450 }));
    const result = matchDirectContract({ contract: contract(), assets: files, now });
    expect(result.status).toBe('INCOMPATIBLE'); expect(result.issues.some(issue => issue.code === 'FILE_ASSIGNMENT_IMPOSSIBLE')).toBe(true);
  });
  it('asks for more required files rather than synthesizing IDs', () => {
    const provided = asset();
    const result = matchDirectContract({ contract: contract([file('images', { constraints: { ...bounds, minFiles: 3 } })]), assets: [provided], now });
    expect(result.status).toBe('NEEDS_INPUT'); expect(result.preparedInput.images).toEqual([provided.id]);
    expect(result.issues[0]?.code).toBe('FILE_COUNT_REQUIRED');
  });
  it('requires an explicit field choice when matching formats do not establish semantic placement', () => {
    const image = asset(); const definition = contract([file('front'), file('back')]);
    const result = matchDirectContract({ contract: definition, assets: [image], now });
    expect(result.status).toBe('NEEDS_INPUT'); expect(result.preparedInput).toEqual({});
    expect(result.assetOptions).toEqual([{ assetId: image.id, inputKeys: ['front', 'back'] }]);
    expect(result.issues.some(issue => issue.code === 'AMBIGUOUS_FILE_ASSIGNMENT')).toBe(true);
    const explicit = matchDirectContract({ contract: definition, assets: [image], input: { front: [image.id], back: [image.id] }, now });
    expect(explicit.status).toBe('READY');
  });
  it('bounds adversarial assignment search and never asserts compatibility or invents a mapping at the bound', () => {
    const fields = Array.from({ length: 8 }, (_, index) => file(`image${index}`, { type: 'FILE' }));
    const result = matchDirectContract({ contract: contract(fields), assets: Array.from({ length: 9 }, () => asset()), now });
    expect(result.status).toBe('NEEDS_INPUT'); expect(result.issues.some(issue => issue.code === 'MATCHING_LIMIT')).toBe(true);
    expect(result.preparedInput).toEqual({});
  });
  it('applies seller scalar defaults only with explicit policy permission', () => {
    const definition = contract([{ key: 'resolution', label: 'Resolution', type: 'INTEGER', order: 0, required: true, default: 1080 }]);
    expect(matchDirectContract({ contract: definition, assets: [], now }).status).toBe('NEEDS_INPUT');
    const permitted = matchDirectContract({ contract: definition, assets: [], allowSellerDefaults: true, now });
    expect(permitted.status).toBe('READY'); expect(permitted.preparedInput).toEqual({ resolution: 1080 });
    expect(permitted.appliedDefaults).toEqual(['resolution']);
  });
  it('cannot grant itself file defaults or inject an unknown field/prototype', () => {
    expect(() => matchDirectContract({ contract: contract([file('images', { default: [randomUUID()] })]), assets: [], now })).toThrow();
    expect(matchDirectContract({ contract: contract([]), assets: [], input: JSON.parse('{"__proto__":{"admin":true}}'), now }).status).toBe('INCOMPATIBLE');
    expect({}).not.toHaveProperty('admin');
  });
  it('respects hidden fields and unresolved/defaulted conditional controls', () => {
    const toggle: InputField = { key: 'useImage', label: 'Use image', type: 'BOOLEAN', order: 0, required: true, default: true };
    const definition = contract([file('images', { visibleWhen: { key: 'useImage', equals: true } }), toggle]);
    const image = asset();
    const unresolved = matchDirectContract({ contract: definition, assets: [image], now });
    expect(unresolved.status).toBe('NEEDS_INPUT'); expect(unresolved.preparedInput).not.toHaveProperty('images');
    expect(matchDirectContract({ contract: definition, assets: [image], input: { useImage: false }, now }).status).toBe('INCOMPATIBLE');
    expect(matchDirectContract({ contract: definition, assets: [image], input: { useImage: false, images: [image.id] }, now }).issues[0]?.code).toBe('INACTIVE_INPUT');
    expect(matchDirectContract({ contract: definition, assets: [image], allowSellerDefaults: true, now }).status).toBe('READY');
  });
  it.each(['unknown', 'duplicate', 'expired', 'bytes', 'url'] as const)('rejects %s attachment metadata/references', kind => {
    const image = asset(); const request = { contract: contract(), assets: [image], now };
    if (kind === 'unknown') expect(matchDirectContract({ ...request, input: { images: [randomUUID()] } }).status).toBe('INCOMPATIBLE');
    else if (kind === 'duplicate') expect(() => matchDirectContract({ ...request, assets: [image, image] })).toThrow();
    else if (kind === 'expired') expect(() => matchDirectContract({ ...request, assets: [{ ...image, expiresAt: now.toISOString() }] })).toThrow('expired');
    else expect(() => matchDirectContract({ ...request, assets: [{ ...image, [kind === 'bytes' ? 'fileBytes' : 'downloadUrl']: 'private-data' }] })).toThrow();
  });
  it('leaves source contracts/assets untouched and emits only minimal file hints', () => {
    const image = asset({ filename: 'private-patient-name.PNG' }); const definition = contract();
    const before = structuredClone({ image, definition });
    matchDirectContract({ contract: definition, assets: [image], now });
    expect({ image, definition }).toEqual(before);
    expect(inputAssetHints([image], now)).toEqual([{ id: image.id, mimeType: 'image/png', sizeBytes: 200, extension: '.png' }]);
    expect(JSON.stringify(inputAssetHints([image], now))).not.toMatch(/patient|sha256|filename|download/);
  });
});

describe('plan entry and final-output matching are separate', () => {
  it('allows each entry step to consume a subset and does not require unrelated downstream scalar/file inputs', () => {
    const a = asset(), b = asset({ mimeType: 'application/pdf', filename: 'other.pdf' });
    const definition = contract([file(), { key: 'upstream', label: 'Upstream text', required: true, order: 1, type: 'LONG_TEXT' }]);
    expect(validatePlanEntryAssets({ contract: definition, assets: [a, b], input: { images: [a.id] }, now }))
      .toEqual({ valid: true, assetIds: [a.id], issues: [] });
    expect(validatePlanEntryAssets({ contract: contract(), assets: [a, b], now }).valid).toBe(true);
    expect(matchDirectContract({ contract: definition, assets: [a, b], now }).status).toBe('INCOMPATIBLE');
  });
  it('rejects invented literal file IDs without granting access to unrelated owned assets', () => {
    expect(validatePlanEntryAssets({ contract: contract(), assets: [asset()], input: { images: [randomUUID()] }, now }))
      .toMatchObject({ valid: false, assetIds: [], issues: [{ code: 'INVALID_INPUT' }] });
    for (const images of [null, '', []]) expect(validatePlanEntryAssets({ contract: contract(), assets: [], input: { images }, now }).valid).toBe(false);
  });
  it('checks both output MIME and extension, even when one matches', () => {
    for (const files of [[{ mimeType: 'application/pdf', extension: '.png', minCount: 1 }], [{ mimeType: 'image/png', extension: '.pdf', minCount: 1 }]]) {
      expect(matchOutputRequirements(contract(), { files }).compatible).toBe(false);
    }
  });
  it('does not turn the maxFiles ceiling into a guarantee of four renders', () => {
    expect(matchOutputRequirements(contract(), { files: [{ extension: '.png', minCount: 4 }] }))
      .toMatchObject({ compatible: true, guaranteed: false, issues: [{ code: 'OUTPUT_NOT_GUARANTEED' }] });
    expect(matchOutputRequirements(contract(), { files: [{ extension: '.png', minCount: 5 }] }).compatible).toBe(false);
  });
  it('recognizes a required narrow named output minimum, but not optional or mixed-format promises', () => {
    const definition = contract(); definition.output.fields = [file('renders', { constraints: { ...bounds, minFiles: 4 } })];
    const requirements = { files: [{ sourceField: 'renders', mimeType: 'image/png', extension: '.png', minCount: 4 }] };
    expect(matchOutputRequirements(definition, requirements).guaranteed).toBe(true);
    definition.output.fields[0]!.required = false;
    expect(matchOutputRequirements(definition, requirements).guaranteed).toBe(false);
    expect(matchOutputRequirements(definition, { files: [{ ...requirements.files[0]!, sourceField: 'invented' }] }).compatible).toBe(false);
  });
  it('rejects named scalar fields, named/envelope format contradictions and named capacity overflow', () => {
    const definition = contract(); definition.output.fields = [file('image', { type: 'FILE' })];
    expect(matchOutputRequirements(definition, { files: [{ sourceField: 'image', extension: '.png', minCount: 2 }] }).compatible).toBe(false);
    definition.output.fields[0]!.constraints!.allowedExtensions = ['.pdf'];
    expect(matchOutputRequirements(definition, { files: [{ sourceField: 'image', extension: '.pdf', minCount: 1 }] }).compatible).toBe(false);
    definition.output.fields = [{ key: 'text', label: 'Text', required: true, type: 'SHORT_TEXT', order: 0 }];
    expect(matchOutputRequirements(definition, { files: [{ sourceField: 'text', extension: '.png', minCount: 1 }] }).compatible).toBe(false);
  });
  it('enforces combined and same-named-field cardinality as well as byte ceilings', () => {
    const definition = contract(); definition.output.fields = [file('renders', { constraints: { ...bounds, maxFiles: 2 } })];
    const group = { sourceField: 'renders', extension: '.png', minCount: 2 };
    expect(matchOutputRequirements(definition, { files: [group, group] }).compatible).toBe(false);
    expect(matchOutputRequirements(definition, { files: [{ extension: '.png', minCount: 1, maxFileSizeBytes: 100 }] }).compatible).toBe(false);
    expect(matchOutputRequirements(definition, { files: [{ extension: '.png', minCount: 1, maxTotalSizeBytes: 1000 }] }).compatible).toBe(false);
  });
  it('never promises distinct cross-field files or formats allowed only as alternatives', () => {
    const definition = contract(); definition.output.fields = [file('a', { type: 'FILE' }), file('b', { type: 'FILE' })];
    expect(matchOutputRequirements(definition, { files: ['a', 'b'].map(sourceField => ({ sourceField, extension: '.png', minCount: 1 })) }).guaranteed).toBe(false);
    definition.output.fields = [];
    definition.output.files!.allowedExtensions.push('.pdf'); definition.output.files!.allowedMimeTypes.push('application/pdf');
    expect(matchOutputRequirements(definition, { files: [{ extension: '.png', minCount: 1 }] }).guaranteed).toBe(false);
  });
  it('supports nested extension allowlists without admitting arbitrary suffixes', () => {
    const definition = contract(); definition.output.files!.allowedExtensions = ['.gz'];
    definition.output.fields = [file('archive', { type: 'FILE', constraints: { ...bounds, allowedExtensions: ['.tar.gz'] } })];
    expect(matchOutputRequirements(definition, { files: [{ sourceField: 'archive', extension: '.tar.gz', minCount: 1 }] }).guaranteed).toBe(true);
    expect(matchOutputRequirements(definition, { files: [{ sourceField: 'archive', extension: '.gz', minCount: 1 }] }).compatible).toBe(false);
  });
  it('validates the small strict API output-file request', () => {
    expect(RequiredOutputFilesSchema.parse([{ extension: '.pdf', count: 1 }])).toEqual([{ extension: '.pdf', count: 1 }]);
    for (const invalid of [[{ count: 1 }], [{ extension: '.pdf', count: 0 }], [{ extension: '.pdf', count: 1, bytes: 'data' }]]) {
      expect(RequiredOutputFilesSchema.safeParse(invalid).success).toBe(false);
    }
    expect(RequiredOutputFilesSchema.safeParse([{ extension: '.pdf', count: 11 }, { extension: '.png', count: 10 }]).success).toBe(false);
    expect(RequiredOutputFilesSchema.safeParse([{ extension: '.pdf', count: 1 }, { extension: '.pdf', count: 1 }]).success).toBe(false);
    expect(RequiredOutputFilesSchema.safeParse([{ mimeType: 'IMAGE/PNG', count: 1 }]).success).toBe(false);
  });
  it('uses required named format guarantees for the blend plus four renders example', () => {
    const definition = contract(); definition.output.files = { allowedMimeTypes: ['image/png', 'application/x-blender'],
      allowedExtensions: ['.png', '.blend'], maxFiles: 5, maxTotalSizeBytes: 5000 };
    definition.output.fields = [file('scene', { type: 'FILE', constraints: { ...bounds, allowedMimeTypes: ['application/x-blender'], allowedExtensions: ['.blend'] } }),
      file('renders', { constraints: { ...bounds, minFiles: 4 } })];
    const requirements = { files: [{ extension: '.blend', minCount: 1 }, { extension: '.png', minCount: 4 }] };
    expect(matchOutputRequirements(definition, requirements)).toMatchObject({ compatible: true, guaranteed: true, issues: [] });
    expect(matchPlanFinalOutputs([definition], requirements)).toBe(true);
    definition.output.files.maxFiles = 4;
    expect(matchPlanFinalOutputs([definition], requirements)).toBe(false);
  });
  it('allocates separate final producer constraints collectively, with no per-step output requirement', () => {
    const png = contract(), pdf = contract(); pdf.output.files!.allowedMimeTypes = ['application/pdf']; pdf.output.files!.allowedExtensions = ['.pdf'];
    const requirements = { files: [{ extension: '.png', minCount: 1 }, { extension: '.pdf', minCount: 1 }] };
    expect(matchPlanFinalOutputs([png, pdf], requirements)).toBe(true);
    expect(matchPlanFinalOutputs([png], requirements)).toBe(false);
    expect(matchPlanFinalOutputs([png, pdf], { types: ['JSON'] })).toBe(false);
  });
  it('does not guarantee an internally impossible named minimum or required FILES minimum zero', () => {
    const definition = contract(); definition.output.files!.maxFiles = 2;
    definition.output.fields = [file('renders', { constraints: { ...bounds, minFiles: 3 } })];
    expect(matchOutputRequirements(definition, { files: [{ sourceField: 'renders', extension: '.png', minCount: 1 }] }).guaranteed).toBe(false);
    definition.output.fields[0]!.constraints!.minFiles = 0;
    expect(matchOutputRequirements(definition, { files: [{ sourceField: 'renders', extension: '.png', minCount: 1 }] }).guaranteed).toBe(false);
  });
});

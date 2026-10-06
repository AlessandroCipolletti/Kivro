import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { evidencePaths, masterSections, mergeEvidenceStatus, requirementSources, sourceCoverage } from '../scripts/coverage-model.js';

describe('authoritative specification traceability', () => {
  it('validates repository-root and CI evidence as well as package paths', () => {
    expect(evidencePaths('`README.md`; .github/workflows/ci.yml:12; [test](tests/coverage-model.test.ts); package.json; .env.example; pnpm-lock.yaml; playwright.config.ts; tsconfig.tools.json; README.md'))
      .toEqual(['README.md', '.github/workflows/ci.yml', 'tests/coverage-model.test.ts', 'package.json', '.env.example', 'pnpm-lock.yaml', 'playwright.config.ts', 'tsconfig.tools.json']);
  });
  it('ignores external/path-prefix coincidences and rejects traversal in local evidence', () => {
    expect(evidencePaths('https://example.com/docs/missing.md unrelated-packages/missing.ts /tmp/README.md other-package.json')).toEqual([]);
    expect(() => evidencePaths('apps/../outside.ts')).toThrow('Invalid evidence path');
    expect(() => evidencePaths('.github/./workflows/ci.yml')).toThrow('Invalid evidence path');
  });
  it('preserves the least complete evidence and never lets a deferral erase unresolved scope', () => {
    expect(mergeEvidenceStatus(['TESTED', 'TESTED'])).toBe('TESTED');
    expect(mergeEvidenceStatus(['TESTED', 'IMPLEMENTED'])).toBe('IMPLEMENTED');
    expect(mergeEvidenceStatus(['DEFERRED', 'DEFERRED'])).toBe('DEFERRED');
    for (const status of ['TESTED', 'IMPLEMENTED', 'IN_PROGRESS']) expect(mergeEvidenceStatus(['DEFERRED', status])).toBe('IN_PROGRESS');
    expect(mergeEvidenceStatus(['DEFERRED', 'TODO'])).toBe('TODO');
    expect(mergeEvidenceStatus(['DEFERRED', 'BLOCKED'])).toBe('BLOCKED');
    expect(() => mergeEvidenceStatus([])).toThrow();
    expect(() => mergeEvidenceStatus(['COMPLETE'])).toThrow();
  });
  it('recognizes the unusual section-one level while excluding subsections and fenced examples', () => {
    expect(masterSections('## 1. Summary\n# 2. Scope\n## 2.1 Detail\n```md\n# 999. Example\n```\n# 3. Next')).toEqual([1, 2, 3]);
    expect(masterSections('~~~text\n# 999. Example\n```\n# 998. Still fenced\n~~~~\n# 4. Real')).toEqual([4]);
  });
  it('retains all prefixes and multiple explicit sources for curated requirements', () => {
    const markdown = '### IO-0010 Title\n- **Source:** MASTER-SPEC.md §53\n### SEC-0098 Title\n- **Source:** MASTER-SPEC.md §300\n## Local\n| DEV-LOCAL-002 | P1 | §552, §554 | Redis |';
    expect(requirementSources(markdown)).toEqual([{ id: 'IO-0010', sections: [53] }, { id: 'SEC-0098', sections: [300] }, { id: 'DEV-LOCAL-002', sections: [552, 554] }]);
  });
  it('fails on duplicates, invented sources, unmapped sections and missing sources', () => {
    const result = sourceCoverage('# 1. One\n# 2. Two\n# 2. Duplicate', '### SEC-0001 One\n- **Source:** §1\n### SEC-0001 Duplicate\n- **Source:** §9\n### IO-0001 Missing');
    expect(result.errors).toEqual(['Master contains duplicate numbered sections', 'SEC-0001: duplicate requirement', 'SEC-0001: unknown Master section 9', 'IO-0001: no numbered Master source', 'Master section 2: no requirement mapping', 'Master section 2: no requirement mapping']);
  });
  it('maps every numbered section in the actual Master without declaring behavior complete', async () => {
    const master = await readFile(new URL('../spec/MASTER-SPEC.md', import.meta.url), 'utf8');
    const requirements = await readFile(new URL('../spec/REQUIREMENTS.md', import.meta.url), 'utf8');
    const mapping = sourceCoverage(master, requirements);
    expect(mapping.sections).toHaveLength(573); expect(mapping.sources).toHaveLength(1701);
    expect(mapping.mappedSections).toBe(573); expect(mapping.errors).toEqual([]);
  });
});

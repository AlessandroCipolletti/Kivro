import { readFile, access, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { root } from './common.js';
import { coverageStatuses, evidencePaths, sourceCoverage } from './coverage-model.js';

type Row = { id: string; priority: string; source: string; status: string; implementation: string; tests: string; notes: string };
async function audit() {
  const coverage = await readFile(resolve(root, 'spec/COVERAGE.md'), 'utf8');
  const requirements = await readFile(resolve(root, 'spec/REQUIREMENTS.md'), 'utf8');
  const master = await readFile(resolve(root, 'spec/MASTER-SPEC.md'), 'utf8');
  const mapping = sourceCoverage(master, requirements);
  const expected = new Set(mapping.sources.map(source => source.id));
  const rows: Row[] = coverage.split('\n').filter(line => /^\|\s*`?(?:[A-Z]+-\d+|DEV-LOCAL-\d+)`?\s*\|/.test(line)).map(line => {
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim().replace(/`/g, ''));
    const [id, priority, source, status, implementation, tests, notes] = cells.length === 6
      ? [cells[0], cells[1], cells[5], cells[2], cells[3], cells[4], ''] : cells;
    return { id, priority, source, status, implementation, tests, notes };
  });
  const invalidEvidence: string[] = [...mapping.errors];
  const counts: Record<string, number> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    if (seen.has(row.id)) invalidEvidence.push(`${row.id}: duplicate row`);
    if (!expected.has(row.id)) invalidEvidence.push(`${row.id}: unknown requirement`);
    seen.add(row.id);
    counts[row.status] = (counts[row.status] ?? 0) + 1;
    if (!new Set<string>(coverageStatuses).has(row.status)) invalidEvidence.push(`${row.id}: unknown status ${row.status}`);
    if (['IMPLEMENTED', 'TESTED'].includes(row.status)) {
      if (!row.implementation || /^(?:—|-|_unassigned_)$/.test(row.implementation)) invalidEvidence.push(`${row.id}: missing implementation evidence`);
      if (row.status === 'TESTED' && (!row.tests || /^(?:—|-|_unassigned_)$/.test(row.tests))) invalidEvidence.push(`${row.id}: missing test evidence`);
      for (const field of [row.implementation, row.tests]) for (const path of evidencePaths(field)) {
        try { await access(resolve(root, path)); } catch { invalidEvidence.push(`${row.id}: evidence path does not exist: ${path}`); }
      }
    }
    if (row.status === 'DEFERRED' && (!row.notes || row.notes === '—')) invalidEvidence.push(`${row.id}: deferral needs an explicit source or user authorization`);
  }
  const missing = [...expected].filter(id => !seen.has(id));
  const remaining = rows.filter(r => !['TESTED', 'DEFERRED'].includes(r.status));
  const sourceMapping = { masterSections: mapping.sections.length, mappedSections: mapping.mappedSections, unmappedSections: mapping.unmappedSections };
  const report = { generatedAt: new Date().toISOString(), expected: expected.size, rows: rows.length, sourceMapping, counts, missing, invalidEvidence, remaining };
  await mkdir(resolve(root, '.local'), { recursive: true });
  await writeFile(resolve(root, '.local/coverage-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ expected: expected.size, rows: rows.length, sourceMapping, counts, missing, invalidEvidence, remaining: remaining.length }, null, 2));
  if (missing.length || invalidEvidence.length || (process.argv.includes('--release') && remaining.length)) process.exitCode = 1;
}
audit().catch(error => { console.error(error.message); process.exitCode = 1; });

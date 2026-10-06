import assert from 'node:assert/strict';
import { readFile, readdir, writeFile, access } from 'node:fs/promises';
import { resolve } from 'node:path';
import { root } from './common.js';
import { coverageStatuses, evidencePaths, mergeEvidenceStatus, requirementSources } from './coverage-model.js';

type Evidence = { id: string; status: string; implementation: string; tests: string; notes: string };
const statuses = new Set<string>(coverageStatuses);
const clean = (text: string) => text.replaceAll('|', '&#124;').replace(/[\r\n]+/g, ' ').replaceAll('`', '').trim();
async function main() {
  const path = resolve(root, 'spec/COVERAGE.md');
  const original = await readFile(path, 'utf8');
  const sources = new Map(requirementSources(await readFile(resolve(root, 'spec/REQUIREMENTS.md'), 'utf8')).map(item => [item.id, item.sections.map(section => `§${section}`).join(', ')]));
  const known = new Set([...original.matchAll(/^\|\s*`?((?:[A-Z]+-\d+|DEV-LOCAL-\d+))`?\s*\|/gm)].map(match => match[1]));
  const reports = (await readdir(resolve(root, 'docs'))).filter(name => /^coverage-[a-z-]+\.json$/.test(name)).sort();
  const entries = new Map<string, Evidence[]>();
  for (const report of reports) {
    const value: unknown = JSON.parse(await readFile(resolve(root, 'docs', report), 'utf8'));
    assert(Array.isArray(value), `${report}: expected an evidence array`);
    for (const entry of value) {
      assert(entry && typeof entry === 'object' && ['id', 'status', 'implementation', 'tests', 'notes'].every(key => typeof entry[key] === 'string'), `${report}: invalid evidence entry`);
      const evidence = entry as Evidence;
      assert(known.has(evidence.id), `${report}: unknown requirement ${evidence.id}`);
      assert(statuses.has(evidence.status), `${report}: unsupported evidence status`);
      assert(evidence.notes.length > 10, `${evidence.id}: explain evidence scope and limitations`);
      if (evidence.status === 'TESTED') assert(evidence.tests.length > 2, `${evidence.id}: tests required`);
      for (const field of [evidence.implementation, evidence.tests]) for (const path of evidencePaths(field)) await access(resolve(root, path));
      entries.set(evidence.id, [...(entries.get(evidence.id) ?? []), evidence]);
    }
  }
  const conflicts: string[] = [];
  const lines = original.split('\n').map(line => {
    const cells = line.split('|').slice(1, -1).map(cell => cell.trim().replaceAll('`', ''));
    const evidence = entries.get(cells[0]);
    if (!evidence) return line;
    const statusSet = new Set(evidence.map(item => item.status));
    if (statusSet.size > 1) conflicts.push(cells[0]);
    // A package-level success cannot silently promote another owner's partial section.
    const status = mergeEvidenceStatus(evidence.map(item => item.status));
    const source = sources.get(cells[0]) ?? (cells.length === 6 ? cells[5].match(/§\d+/)?.[0] ?? 'Local specification' : cells[2]);
    const joined = (key: 'implementation' | 'tests' | 'notes') => [...new Set(evidence.map(item => clean(item[key])).filter(Boolean))].join('; ');
    return `| \`${cells[0]}\` | ${cells[1]} | ${source} | \`${status}\` | ${joined('implementation') || '-'} | ${joined('tests') || '-'} | ${joined('notes')} |`;
  });
  const normalized = lines.join('\n').replace('| Requirement | Priority | Status | Implementation | Tests | Notes |\n|---|---|---|---|---|---|', '| Requirement | Priority | Source | Status | Implementation evidence | Test evidence | Notes |\n|---|---|---|---|---|---|---|');
  if (process.argv.includes('--apply')) await writeFile(path, normalized);
  console.log(JSON.stringify({ reports, reviewedRequirements: entries.size, conservativeConflicts: conflicts, applied: process.argv.includes('--apply') }, null, 2));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });

export type RequirementSource = { id: string; sections: number[] };

export function evidencePaths(text: string): string[] {
  const paths = [...text.matchAll(/(?<![A-Za-z0-9_./:-])(?:(?:apps|packages|tests|security|scripts|infrastructure|docs|\.github)\/[A-Za-z0-9_./-]+|(?:README\.md|package\.json|\.env\.example|pnpm-lock\.yaml|pnpm-workspace\.yaml|(?:eslint|playwright|vitest)\.config\.[a-z]+|tsconfig(?:\.[a-z]+)?\.json))(?![A-Za-z0-9_/-])/g)].map(match => match[0]);
  for (const path of paths) if (path.split('/').some(segment => segment === '.' || segment === '..')) throw new Error(`Invalid evidence path: ${path}`);
  return [...new Set(paths)];
}

export const coverageStatuses = ['TODO', 'IN_PROGRESS', 'IMPLEMENTED', 'TESTED', 'BLOCKED', 'DEFERRED'] as const;
export function mergeEvidenceStatus(values: string[]) {
  const statuses = new Set(values);
  if (!statuses.size || values.some(value => !new Set<string>(coverageStatuses).has(value))) throw new Error('Invalid coverage evidence status');
  if (statuses.has('BLOCKED')) return 'BLOCKED';
  if (statuses.has('TODO')) return 'TODO';
  if (statuses.has('IN_PROGRESS') || statuses.has('DEFERRED') && statuses.size > 1) return 'IN_PROGRESS';
  if (statuses.has('DEFERRED')) return 'DEFERRED';
  return statuses.has('IMPLEMENTED') ? 'IMPLEMENTED' : 'TESTED';
}

function outsideFences(markdown: string) {
  let fence: { marker: string; length: number } | undefined;
  return markdown.split('\n').map(line => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = { marker: marker[0]!, length: marker.length };
      else if (marker[0] === fence.marker && marker.length >= fence.length && /^ {0,3}(?:`+|~+)\s*$/.test(line)) fence = undefined;
      return '';
    }
    return fence ? '' : line;
  });
}

export function masterSections(markdown: string): number[] {
  return outsideFences(markdown).flatMap(line => {
    const match = /^#{1,2} (\d+)\.\s+/.exec(line);
    return match ? [Number(match[1])] : [];
  });
}

export function requirementSources(markdown: string): RequirementSource[] {
  const result: RequirementSource[] = [];
  let current: RequirementSource | undefined;
  for (const line of outsideFences(markdown)) {
    const heading = /^### ([A-Z]+-\d+)\s/.exec(line);
    if (heading) { current = { id: heading[1]!, sections: [] }; result.push(current); continue; }
    if (/^#{1,3} /.test(line)) current = undefined;
    if (current && line.startsWith('- **Source:**')) current.sections = [...line.matchAll(/§(\d+)/g)].map(match => Number(match[1]));
    const curated = /^\| (DEV-LOCAL-\d+) \|/.exec(line);
    if (curated) {
      const source = line.split('|')[3] ?? '';
      result.push({ id: curated[1]!, sections: [...source.matchAll(/§(\d+)/g)].map(match => Number(match[1])) });
    }
  }
  return result;
}

export function sourceCoverage(master: string, requirements: string) {
  const sections = masterSections(master), sources = requirementSources(requirements);
  const sectionSet = new Set(sections), seen = new Set<string>(), mapped = new Set<number>();
  const errors: string[] = [];
  if (sections.length !== sectionSet.size) errors.push('Master contains duplicate numbered sections');
  for (const source of sources) {
    if (seen.has(source.id)) errors.push(`${source.id}: duplicate requirement`);
    seen.add(source.id);
    if (!source.sections.length) errors.push(`${source.id}: no numbered Master source`);
    for (const section of source.sections) {
      if (!sectionSet.has(section)) errors.push(`${source.id}: unknown Master section ${section}`);
      else mapped.add(section);
    }
  }
  const unmapped = sections.filter(section => !mapped.has(section));
  for (const section of unmapped) errors.push(`Master section ${section}: no requirement mapping`);
  return { sections, sources, mappedSections: mapped.size, unmappedSections: unmapped, errors };
}

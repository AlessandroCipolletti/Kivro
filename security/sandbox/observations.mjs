export function summarizeToolObservations(raw, recorded, allowed) {
  // OpenClaw 2026.8.2 buildTraceToolSummary omits the field for zero toolMetas.
  const summary = raw === undefined ? { calls: 0, failures: 0, tools: [] } : raw;
  if (!summary || !Number.isSafeInteger(summary.calls) || summary.calls < 0 || summary.calls > 128 || !Number.isSafeInteger(summary.failures) || summary.failures < 0 || summary.failures > summary.calls || !Array.isArray(summary.tools) || summary.tools.length > summary.calls || new Set(summary.tools).size !== summary.tools.length || summary.tools.some(name => !allowed.includes(name))) throw new Error('INVALID_OPENCLAW_TOOL_SUMMARY');
  const observations = recorded.map(item => ({ ...item }));
  if (observations.some(item => Object.keys(item).sort().join(',') !== 'name,outcome' || !summary.tools.includes(item.name) || !['SUCCEEDED', 'FAILED'].includes(item.outcome))) throw new Error('TOOL_OBSERVATION_SUMMARY_MISMATCH');
  for (const name of summary.tools) if (!observations.some(item => item.name === name)) observations.push({ name, outcome: 'OBSERVED' });
  if (observations.length > summary.calls || observations.filter(item => item.outcome === 'FAILED').length > summary.failures) throw new Error('TOOL_OBSERVATION_SUMMARY_MISMATCH');
  return { observations, toolSummary: { calls: summary.calls, failures: summary.failures } };
}

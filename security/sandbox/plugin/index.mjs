import { constants, openSync, fstatSync, writeSync, closeSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { sandboxTiming } from '../timing.mjs';
import { callToolBridge } from './bridge.mjs';

const object = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const text = { type: 'string', minLength: 1, maxLength: 600 };
const definitions = [
  ['research_search', 'Search public web information through the approved research broker.', object({ query: text })],
  ['research_fetch', 'Read an approved public web page through the research broker.', object({ url: { type: 'string', maxLength: 4096 } })],
  ['research_download', 'Look up a scanned public file from the immutable job cache. No network request is made.', object({ reviewedSourceId: text })],
  ['resource_read', 'Read one explicitly approved immutable local resource snapshot.', object({ resourceId: text })],
  ['resource_query', 'Look up rows through an approved named read-only database operation.', object({ resourceId: text, operation: text, input: { type: 'object', additionalProperties: true, maxProperties: 10 } })],
  ['connector_call', 'Call one approved read-only public JSON connector with fixed endpoint and declared parameters.', object({ connectorId: text, input: { type: 'object', additionalProperties: true, maxProperties: 30 } })],
  ['blender_render', 'Render one frame from an input blend asset. Automatic scripts are disabled.', object({ assetId: { type: 'string', format: 'uuid' }, frame: { type: 'integer', minimum: 1, maximum: 10000 } })],
  ['ffmpeg_transcode', 'Transcode one input media asset to the fixed H.264 MP4 preset.', object({ assetId: { type: 'string', format: 'uuid' } })],
];
let observations = 0;
function recordTool(name, outcome) {
  // One overflow record makes the runner fail closed rather than truncate proof.
  if (observations++ > 128) return;
  const fd = openSync('/job/work/tool-observations.ndjson', constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > 32768) throw new Error('INVALID_TOOL_OBSERVATIONS');
    writeSync(fd, `${JSON.stringify({ name, outcome })}\n`);
  } finally { closeSync(fd); }
}
export default {
  id: 'kivro-broker', name: 'Kivro Restricted Tools',
  register(api) {
    const reviewed = api.pluginConfig?.reviewedResearch;
    for (const definition of definitions) {
      let [name, description, parameters] = definition;
      if (reviewed && ['research_search', 'research_fetch', 'research_download'].includes(name)) {
        const ids = name === 'research_search' ? reviewed.searchSourceIds : name === 'research_download' ? reviewed.downloadSourceIds : reviewed.fetchSourceIds;
        if (!Array.isArray(ids) || !ids.length) continue;
        description = 'Read one reviewed public source from the immutable job cache. No outbound request or private input is accepted.';
        parameters = object({ reviewedSourceId: { type: 'string', enum: ids } });
      }
      api.registerTool({
      name, label: name, description, parameters,
      async execute(_toolCallId, args, signal) {
        try {
          const timing = sandboxTiming(JSON.parse(await readFile('/job/input/request.json', 'utf8')));
          const result = await callToolBridge({ name, args }, signal, timing.wallMs); recordTool(name, 'SUCCEEDED');
          return { content: [{ type: 'text', text: JSON.stringify(result) }], details: result };
        } catch (error) { recordTool(name, 'FAILED'); throw error; }
      },
      }, { optional: true });
    }
  },
};

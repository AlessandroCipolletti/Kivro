import type { CapabilityDTO, InputField } from '@kivro/contracts';

const text = (value: unknown, limit: number): string => typeof value === 'string' ? value.slice(0, limit) : '';
const preview = (value: unknown, limit: number): string => value === undefined ? '' : text(JSON.stringify(value), limit);

function fieldDescription(field: InputField) {
  const constraints = field.constraints;
  return { key: field.key, label: field.label, type: field.type, description: field.description,
    semanticType: constraints?.semanticType,
    allowedValues: constraints?.allowedValues, allowedExtensions: constraints?.allowedExtensions,
    allowedMimeTypes: constraints?.allowedMimeTypes, schema: preview(constraints?.jsonSchema, 4000) };
}

/** Public version data only. Never serialize an entire seller or capability object. */
export function publicDiscoveryContent(capability: CapabilityDTO) {
  if (capability.visibility !== 'PUBLIC') return null;
  const output = capability.ioContract.output;
  const scalarInputs = capability.ioContract.inputs.filter(field => !['FILE', 'FILES'].includes(field.type));
  return {
    title: text(capability.title, 200), summary: text(capability.summary, 600),
    description: text(capability.description, 12000), category: text(capability.category, 100),
    tags: capability.tags.slice(0, 12).map(tag => text(tag, 40)),
    inputs: capability.ioContract.inputs.slice(0, 64).map(fieldDescription),
    output: { type: output.type, description: text(output.description, 2000),
      fields: output.fields?.slice(0, 64).map(field => fieldDescription({ ...field, type: field.type === 'MARKDOWN' ? 'LONG_TEXT' : field.type })),
      schema: preview(output.jsonSchema, 4000),
      allowedExtensions: output.files?.allowedExtensions, allowedMimeTypes: output.files?.allowedMimeTypes },
    examples: capability.examples.slice(0, 10).map(example => ({
      title: text(example.title, 200), description: text(example.description, 2000),
      input: scalarInputs.filter(field => Object.hasOwn(example.input, field.key)).map(field => ({ key: field.key, value: preview(example.input[field.key], 2000) })),
      output: text(example.output, 10000),
      files: [...(example.inputAssets ?? []), ...(example.outputAssets ?? [])].slice(0, 60)
        .map(asset => ({ filename: text(asset.filename, 255), mimeType: text(asset.mimeType, 150) })),
    })),
  };
}

export function publicDiscoveryText(capability: CapabilityDTO): string {
  const content = publicDiscoveryContent(capability);
  if (!content) return '';
  // This ephemeral index is rebuilt from the current public version. Revoked
  // examples and private versions therefore cannot persist in a stale index.
  const values: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === 'string') values.push(value);
    else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  };
  visit(content);
  return values.join(' ').toLowerCase();
}

export function publicDiscoveryContext(capability: CapabilityDTO) {
  const content = publicDiscoveryContent(capability);
  if (!content) return null;
  // Optional retrieval evidence must not crowd out the required contract data.
  // Check serialized bytes, since Unicode/control characters expand differently.
  for (let limit = 512; limit >= 1; limit = Math.floor(limit / 2)) {
    const context = { description: content.description.slice(0, limit), examples: content.examples.slice(0, 2).map(example => ({
      title: example.title.slice(0, limit), description: example.description.slice(0, limit),
      input: example.input.slice(0, 2).map(field => ({ key: field.key, value: field.value.slice(0, limit) })),
      output: example.output.slice(0, limit), files: example.files.slice(0, 2).map(file => ({ filename: file.filename.slice(0, limit), mimeType: file.mimeType.slice(0, limit) })),
    })) };
    if (Buffer.byteLength(JSON.stringify(context)) <= 768) return context;
  }
  return { description: content.description.slice(0, 80), examples: [] };
}

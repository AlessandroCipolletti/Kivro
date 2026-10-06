import { validateOutput, JobOutputSchema, type JobOffer, type JobOutput, type AssetDTO } from '@kivro/contracts';
import type { ExecutionResult } from '@kivro/openclaw-adapter';

export function projectResult(offer: JobOffer, result: ExecutionResult, assets: AssetDTO[]): JobOutput {
  let output: JobOutput;
  if (offer.ioContract.output.fields?.length) {
    // A no-write capability can deliver named fields in its bounded final
    // response. Never extract JSON from prefixed/fenced prose or infer fields.
    output = JobOutputSchema.parse(result.resultManifest ?? JSON.parse(result.text));
    if (output.assets) throw new Error('RUNTIME_ASSET_IDS_FORBIDDEN');
    const fields = { ...output.fields };
    for (const field of offer.ioContract.output.fields) {
      const value = fields[field.key];
      if (value === undefined || !['FILE', 'FILES'].includes(field.type)) continue;
      const paths = field.type === 'FILE' ? [value] : value;
      if (!Array.isArray(paths)) throw new Error('INVALID_NAMED_FILE_RESULT');
      const ids = paths.map(path => {
        if (typeof path !== 'string') throw new Error('INVALID_NAMED_FILE_RESULT');
        const index = result.files.findIndex(file => file.relativePath === path);
        if (index < 0 || !assets[index]) throw new Error('NAMED_FILE_NOT_COLLECTED'); return assets[index]!.id;
      });
      fields[field.key] = field.type === 'FILE' ? ids[0] : ids;
    }
    output.fields = fields;
  } else if (result.resultManifest) throw new Error('UNDECLARED_RESULT_MANIFEST');
  else output = offer.ioContract.output.type === 'JSON' ? { json: JSON.parse(result.text) } : offer.ioContract.output.type === 'FILES' ? {} : { text: result.text };
  return validateOutput(offer.ioContract, { ...output, ...(assets.length ? { assets } : {}) });
}

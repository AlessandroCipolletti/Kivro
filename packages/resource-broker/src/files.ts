import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { ResourceBrokerError, type FileResource } from './types.ts';

export function checkSignal(signal: AbortSignal): void {
  if (signal.aborted) throw signal.reason instanceof ResourceBrokerError ? signal.reason : new ResourceBrokerError('RESOURCE_CANCELLED');
}

export async function readSelection(resource: FileResource, input: unknown, maxBytes: number, signal: AbortSignal): Promise<unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 ||
    !('selectionId' in input) || typeof input.selectionId !== 'string') throw new ResourceBrokerError('INVALID_INPUT');
  const selection = resource.selections.find(file => file.id === input.selectionId);
  if (!selection) throw new ResourceBrokerError('RESOURCE_DENIED');
  const { root, path } = selection;
  if (!isAbsolute(root) || !isAbsolute(path) || resolve(root) !== root || resolve(path) !== path ||
    !path.startsWith(root + sep) || selection.sizeBytes > maxBytes ||
    /(?:^|\/)(?:\.ssh|\.aws|\.gnupg|\.docker|\.openclaw|\.config|\.env(?:\.[^/]*)?|Library)(?:\/|$)/i.test(path)) throw new ResourceBrokerError('RESOURCE_DENIED');
  const verifyPath = async () => {
    checkSignal(signal);
    if (await realpath(root) !== root || await realpath(path) !== path) throw new ResourceBrokerError('RESOURCE_CHANGED');
    let directory = root;
    for (const part of ['', ...relative(root, path).split(sep).slice(0, -1)]) {
      if (part) directory += sep + part;
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o022) ||
        (process.getuid && stat.uid !== process.getuid())) throw new ResourceBrokerError('RESOURCE_CHANGED');
    }
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o222) ||
      stat.size !== selection.sizeBytes || (process.getuid && stat.uid !== process.getuid())) throw new ResourceBrokerError('RESOURCE_CHANGED');
    return stat;
  };
  const expected = await verifyPath();
  checkSignal(signal);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.dev !== expected.dev || before.ino !== expected.ino || before.nlink !== 1 || before.size !== expected.size) throw new ResourceBrokerError('RESOURCE_CHANGED');
    const bytes = Buffer.alloc(selection.sizeBytes + 1);
    let offset = 0;
    while (offset < bytes.length) {
      checkSignal(signal);
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (!read.bytesRead) break;
      offset += read.bytesRead;
    }
    const after = await handle.stat(), current = await verifyPath();
    if (offset !== selection.sizeBytes || after.dev !== before.dev || after.ino !== before.ino || after.nlink !== 1 ||
      after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs ||
      current.dev !== before.dev || current.ino !== before.ino || current.mtimeMs !== before.mtimeMs || current.ctimeMs !== before.ctimeMs) throw new ResourceBrokerError('RESOURCE_CHANGED');
    const content = bytes.subarray(0, offset);
    if (createHash('sha256').update(content).digest('hex') !== selection.sha256) throw new ResourceBrokerError('RESOURCE_CHANGED');
    checkSignal(signal);
    return { selectionId: selection.id, content: new TextDecoder('utf-8', { fatal: true }).decode(content), mimeType: selection.mimeType, sha256: selection.sha256 };
  } finally { await handle.close(); }
}

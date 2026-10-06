import { extname } from 'node:path';
import { fileTypeFromBuffer } from 'file-type';
import { validateOfficeContainer } from './office.js';
import { inspectMedia, MEDIA_MIME_TYPES } from './media.js';

export class FileValidationError extends Error {}
export function safeFilename(filename: string): string {
  if (!filename || filename.length > 180 || /[\x00-\x1f\x7f/\\:]/.test(filename) || filename === '.' || filename === '..' || filename.startsWith('.')) throw new FileValidationError('Unsafe filename');
  return filename;
}
const extensions: Record<string, string[]> = {
  'application/pdf': ['.pdf'], 'image/png': ['.png'], 'image/jpeg': ['.jpg', '.jpeg'],
  'image/webp': ['.webp'], 'image/gif': ['.gif'], 'video/mp4': ['.mp4'],
  'video/quicktime': ['.mov'], 'video/webm': ['.webm'], 'audio/mpeg': ['.mp3'],
  'audio/wav': ['.wav'], 'audio/x-wav': ['.wav'], 'audio/flac': ['.flac'],
  'model/gltf-binary': ['.glb'], 'application/x-blender': ['.blend'],
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'],
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
};
const textExtensions: Record<string, string> = { '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json', '.gltf': 'model/gltf+json' };
export async function inspectFile(data: Buffer, filename: string, declaredMime: string, maxBytes: number): Promise<string> {
  safeFilename(filename);
  if (!data.length || data.length > maxBytes) throw new FileValidationError('File is empty or exceeds the upload limit');
  const extension = extname(filename).toLowerCase();
  const zip = data.length >= 4 && [0x04034b50, 0x06054b50, 0x08074b50].includes(data.readUInt32LE(0));
  if (zip) {
    if (extension !== '.docx' && extension !== '.xlsx') throw new FileValidationError('Arbitrary archives are disabled');
    try { await validateOfficeContainer(data, extension === '.docx' ? 'docx' : 'xlsx'); }
    catch { throw new FileValidationError('Office file failed bounded container validation'); }
  }
  let detected: string | undefined;
  try { detected = (await fileTypeFromBuffer(data))?.mime; }
  catch { throw new FileValidationError('File signature is truncated or invalid'); }
  if (MEDIA_MIME_TYPES[extension]) {
    let media: string;
    try { media = inspectMedia(data, filename)!; } catch { throw new FileValidationError('Media failed bounded structural validation'); }
    const aliases: Record<string, string[]> = {
      '.m4a': ['audio/mp4', 'audio/x-m4a', 'video/mp4'], '.fbx': ['application/vnd.autodesk.fbx', 'application/x.autodesk.fbx', 'application/x-autodesk-fbx'],
      '.obj': ['model/obj', 'text/plain'],
    };
    const accepted = aliases[extension] ?? [media];
    if ((detected && !accepted.includes(detected)) || (!detected && extension !== '.obj')) throw new FileValidationError('Media content and extension do not match');
    const claimed = declaredMime.split(';')[0]?.trim().toLowerCase();
    if (claimed && claimed !== 'application/octet-stream' && !accepted.includes(claimed)) throw new FileValidationError('Declared MIME type does not match detected content');
    return media;
  }
  if (data.subarray(0, 7).toString() === 'BLENDER') detected = 'application/x-blender';
  if (detected) {
    if (!extensions[detected]?.includes(extension)) throw new FileValidationError('File content and extension do not match, or this format is not supported');
    if ((extension === '.docx' || extension === '.xlsx') && !zip) throw new FileValidationError('Office file is not a supported ZIP container');
  } else if (textExtensions[extension]) {
    let content: string;
    try { content = new TextDecoder('utf-8', { fatal: true }).decode(data); }
    catch { throw new FileValidationError('Text file is not valid UTF-8'); }
    if (/[\x00-\x08\x0e-\x1f]/.test(content)) throw new FileValidationError('Binary content is not allowed in text files');
    if (extension === '.json' || extension === '.gltf') {
      try { JSON.parse(content); } catch { throw new FileValidationError('JSON file is invalid'); }
    }
    detected = textExtensions[extension];
  } else throw new FileValidationError('Unrecognized file format; archives and executables are disabled');
  const claimed = declaredMime.split(';')[0]?.trim().toLowerCase();
  if (claimed && claimed !== 'application/octet-stream' && claimed !== detected && !(claimed === 'text/plain' && textExtensions[extension])) throw new FileValidationError('Declared MIME type does not match detected content');
  return detected;
}

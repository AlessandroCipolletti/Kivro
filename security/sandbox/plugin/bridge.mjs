import { request } from 'node:http';

// A fixed in-container endpoint only. Unlike fetch's implicit headers timeout,
// this explicit bound can accommodate a confirmed Docker freeze.
export function callToolBridge(body, signal, timeoutMs) {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 5000 || timeoutMs > 4500000) return Promise.reject(new Error('INVALID_BRIDGE_TIMEOUT'));
  const bytes = Buffer.from(JSON.stringify(body));
  if (bytes.length > 2 * 1024 * 1024) return Promise.reject(new Error('KIVRO_TOOL_REQUEST_LIMIT'));
  return new Promise((resolve, reject) => {
    const fail = () => reject(new Error('KIVRO_TOOL_DENIED'));
    const req = request({ hostname: '127.0.0.1', port: 18789, path: '/kivro/tool', method: 'POST', signal, agent: false,
      headers: { 'content-type': 'application/json', 'content-length': bytes.length } }, response => {
      if (response.statusCode !== 200) { response.destroy(); req.destroy(); fail(); return; }
      const chunks = []; let size = 0;
      response.on('data', chunk => {
        size += chunk.length;
        if (size > 16 * 1024 * 1024) { response.destroy(); req.destroy(); fail(); } else chunks.push(chunk);
      });
      response.on('error', fail);
      response.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { fail(); } });
    });
    const timer = setTimeout(() => { req.destroy(); fail(); }, timeoutMs);
    req.on('error', fail); req.on('close', () => clearTimeout(timer)); req.end(bytes);
  });
}

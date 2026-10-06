import { createHash, randomUUID } from 'node:crypto';
import { readdir, lstat, readlink, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { loadEnvironment, assertLocalEnvironment, root } from './common.js';
import type { CapabilityDTO, JobDTO, InputField, AssetDTO } from '../packages/contracts/src/index.js';

const delay = (ms: number) => new Promise(resolveDelay => setTimeout(resolveDelay, ms));
const hash = (data: Uint8Array | string) => createHash('sha256').update(data).digest('hex');
async function personalFingerprint() {
  const directory = join(homedir(), '.openclaw');
  const metadata: unknown[] = [];
  async function visit(path: string, relative: string, depth: number): Promise<void> {
    if (depth > 32 || metadata.length >= 100_000) throw new Error('Personal metadata snapshot exceeds its safety bound; no acceptance job was authorized by this check.');
    const info = await lstat(path);
    metadata.push({ path: relative, size: info.size, mode: info.mode, mtime: info.mtimeMs, ctime: info.ctimeMs,
      target: info.isSymbolicLink() ? await readlink(path) : undefined });
    // Inspect metadata only, without reading credentials or following symlinks.
    if (info.isDirectory()) for (const name of (await readdir(path)).sort()) await visit(join(path, name), `${relative}/${name}`, depth + 1);
  }
  try {
    await visit(directory, '.', 0);
    return hash(JSON.stringify(metadata));
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT' && metadata.length === 0) return 'absent'; throw error; }
}
async function main() {
  loadEnvironment(); assertLocalEnvironment();
  const api = process.env.API_URL ?? 'http://127.0.0.1:4000';
  const origin = process.env.WEB_ORIGIN ?? 'http://localhost:3000';
  const request = async <T>(path: string, options: RequestInit = {}, cookie?: string): Promise<T> => {
    const response = await fetch(`${api}/api${path}`, { ...options, headers: { Origin: origin, ...(cookie ? { Cookie: cookie } : {}), ...options.headers }, signal: AbortSignal.timeout(20_000) });
    const data = await response.json();
    if (!response.ok) throw new Error(`${path}: ${response.status} ${data.error?.code ?? ''} ${data.error?.message ?? ''}`);
    return data as T;
  };
  const login = async (role: string) => {
    const response = await fetch(`${api}/api/auth/dev-login`, { method: 'POST', headers: { Origin: origin, 'Content-Type': 'application/json' }, body: JSON.stringify({ role }), signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error('Local E2E requires explicitly enabled development account authentication.');
    const cookie = response.headers.getSetCookie().map(c => c.split(';')[0]).join('; ');
    const { user } = await response.json();
    return { cookie, user };
  };
  const readiness = await fetch(`${api}/ready`, { signal: AbortSignal.timeout(20_000) });
  if (!readiness.ok) throw new Error('API dependencies are not ready. Run pnpm dev:setup and pnpm dev.');
  const buyer = await login('buyer'), seller = await login('seller');
  if (buyer.user.id === seller.user.id) throw new Error('Buyer and seller must be distinct identities.');
  const capability = process.env.KIVRO_E2E_CAPABILITY_ID
    ? await request<CapabilityDTO>(`/capabilities/${encodeURIComponent(process.env.KIVRO_E2E_CAPABILITY_ID)}`, {}, buyer.cookie)
    : (await request<CapabilityDTO[]>('/capabilities', {}, buyer.cookie)).find(c => c.seller.id === seller.user.id && c.availability.canRunNow && ['MIXED', 'FILES'].includes(c.ioContract.output.type));
  if (!capability || !capability.availability.canRunNow) throw new Error('No real Worker-backed file-output capability is available. Pair the Worker, configure dedicated inference, approve and test the local fixture, then publish it. No mocked or host execution is accepted by this test.');
  if (capability.seller.id !== seller.user.id) throw new Error('The selected acceptance capability must belong to the separate development seller. No substitute capability was purchased.');
  const terms = await request<{ version: string; preliminary: boolean }>('/terms');
  if (!terms.preliminary) throw new Error('Accept the operator-reviewed terms in the web UI before real-provider acceptance; this script only accepts synthetic development terms.');
  await request('/account/terms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: terms.version }) }, buyer.cookie);
  const beforePersonal = await personalFingerprint();
  const marker = `KIVRO_E2E_${randomUUID()}`;
  const input: Record<string, unknown> = { ...(capability.examples[0]?.input ?? {}) };
  let uploadedInputs = 0;
  const upload = async (field: InputField) => {
    const extension = field.constraints?.allowedExtensions?.find(e => ['.txt', '.md', '.csv', '.json'].includes(e));
    if (!extension) throw new Error(`E2E fixture field ${field.key} needs a text/CSV/JSON-compatible file format.`);
    const content = extension === '.json' ? JSON.stringify({ reference: marker, revenue: 123 }) : extension === '.csv' ? `reference,revenue\n${marker},123\n` : `Reference: ${marker}\nWrite a report preserving this exact reference.\n`;
    const type = ({ '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.json': 'application/json' } as Record<string, string>)[extension];
    const body = new FormData(); body.set('file', new Blob([content], { type }), `e2e-input${extension}`);
    const asset = await request<AssetDTO>('/assets/upload', { method: 'POST', body }, buyer.cookie);
    input[field.key] = field.type === 'FILE' ? asset.id : [asset.id];
    uploadedInputs++;
  };
  for (const field of capability.ioContract.inputs) {
    if (['FILE', 'FILES'].includes(field.type)) { if (field.required || field.constraints?.allowedExtensions?.some(e => ['.txt', '.md', '.csv', '.json'].includes(e))) await upload(field); continue; }
    if (field.type === 'LONG_TEXT' || field.type === 'SHORT_TEXT') input[field.key] = 'Read the attached source document. Preserve its exact reference in your summary and generated report. Do not invent or omit the reference.';
    else if (input[field.key] === undefined) input[field.key] = field.default ?? (field.type === 'BOOLEAN' ? true : ['INTEGER', 'NUMBER'].includes(field.type) ? field.constraints?.minimum ?? 1 : field.constraints?.allowedValues?.[0]);
  }
  if (!uploadedInputs) throw new Error('Full local acceptance requires a capability that consumes an uploaded text/CSV/JSON document and produces a file.');
  const balance = await request<{ availableMinor: number }>('/wallet', {}, buyer.cookie);
  if (balance.availableMinor < 10_000) await request('/wallet/topup', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() }, body: JSON.stringify({ amountMinor: 10_000 }) }, buyer.cookie);
  const quote = await request<{ id: string }>(`/capabilities/${capability.id}/quote`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ executionMode: 'NOW' }) }, buyer.cookie);
  const idempotencyKey = randomUUID();
  const options = { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey }, body: JSON.stringify({ capabilityId: capability.id, input, executionMode: 'NOW', quoteId: quote.id }) };
  let job = await request<JobDTO>('/jobs', options, buyer.cookie);
  const duplicate = await request<JobDTO>('/jobs', options, buyer.cookie);
  if (duplicate.id !== job.id) throw new Error('Job creation idempotency failed.');
  console.log(`Real local job ${job.id}: ${job.state}`);
  const deadline = Date.now() + (capability.permissions.limits.timeoutSeconds + 60) * 1000;
  const observed = new Set([job.state]);
  while (!['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(job.state) && Date.now() < deadline) {
    await delay(1000); job = await request<JobDTO>(`/jobs/${job.id}`, {}, buyer.cookie);
    if (!observed.has(job.state)) { observed.add(job.state); console.log(`${job.id}: ${job.state}`); }
  }
  if (job.state !== 'SUCCEEDED' || job.paymentState !== 'SETTLED') throw new Error(`Real execution did not settle successfully: ${job.state} (${job.error ?? 'no result'}).`);
  if (!job.output?.assets?.length) throw new Error('The full local acceptance fixture must produce a downloadable file.');
  let delivered = job.output.text ?? '';
  for (const asset of job.output.assets) {
    const response = await fetch(`${api}/api/assets/${asset.id}/download`, { headers: { Cookie: buyer.cookie }, redirect: 'follow', signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error('Buyer cannot download the result.');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (hash(bytes) !== asset.sha256 || bytes.length !== asset.sizeBytes) throw new Error('Delivered file integrity mismatch.');
    delivered += bytes.toString('utf8');
    const anonymous = await fetch(`${api}/api/assets/${asset.id}/download`, { redirect: 'manual', signal: AbortSignal.timeout(20_000) });
    if (anonymous.ok || anonymous.status === 302) throw new Error('Anonymous asset access was allowed.');
  }
  if (!delivered.includes(marker)) throw new Error('Delivered output did not preserve the unique input reference.');
  const wallet = await request<{ ledger: { jobId?: string; type: string }[] }>('/wallet', {}, buyer.cookie);
  if (wallet.ledger.filter(e => e.jobId === job.id && e.type === 'JOB_CAPTURE').length !== 1) throw new Error('Expected exactly one job capture.');
  const sellerWallet = await request<{ ledger: { jobId?: string; type: string }[] }>('/wallet', {}, seller.cookie);
  if (sellerWallet.ledger.filter(e => e.jobId === job.id && e.type === 'SELLER_EARNING').length !== 1) throw new Error('Expected exactly one seller earning.');
  if (await personalFingerprint() !== beforePersonal) throw new Error('Personal OpenClaw metadata changed during acceptance; investigate before accepting the run.');
  await mkdir(resolve(root, '.local'), { recursive: true });
  await writeFile(resolve(root, '.local/e2e-local-result.json'), JSON.stringify({ passed: true, at: new Date().toISOString(), jobId: job.id, buyerId: buyer.user.id, sellerId: seller.user.id, states: [...observed], inputFiles: uploadedInputs, outputFiles: job.output.assets.length, personalOpenClawMetadataUnchanged: true }, null, 2));
  console.log('PASS: real sandbox/OpenClaw, input consumption, generated file delivery, distinct identities, private assets, exactly-once settlement and unchanged personal OpenClaw metadata.');
}
main().catch(error => { console.error(`Local acceptance FAILED: ${error.message}`); process.exitCode = 1; });

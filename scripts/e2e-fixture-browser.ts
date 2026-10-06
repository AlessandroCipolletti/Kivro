// Real Next/Chromium buyer path for the deterministic local runtime fixture.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection, createServer } from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, expect, type Browser, type BrowserServer, type Page, type Response as BrowserResponse } from '@playwright/test';
import { AssetDTOSchema, JobDTOSchema, getPriceTier, type AssetDTO, type CapabilityDTO, type JobDTO } from '../packages/contracts/src/index.js';
import { sha256 } from '../packages/crypto/src/index.ts';

export async function fixtureWebOrigin(): Promise<string> {
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => { reservation.once('error', reject); reservation.listen(0, '127.0.0.1', resolve); });
  const address = reservation.address();
  assert(address && typeof address === 'object');
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()));
  return `http://127.0.0.1:${address.port}`;
}

async function bounded<T>(task: Promise<T>, milliseconds: number, code: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try { return await Promise.race([task, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(code)), milliseconds); })]); }
  finally { clearTimeout(timer); }
}

function observe<T>(promise: Promise<T>): Promise<T> {
  // An earlier UI action can fail before the awaited response is reached.
  // Keep that later browser-close rejection from escaping fixture cleanup.
  void promise.catch(() => undefined);
  return promise;
}

async function portOpen(origin: string): Promise<boolean> {
  const url = new URL(origin);
  return new Promise(resolve => {
    const socket = createConnection({ host: url.hostname, port: Number(url.port) });
    const finish = (open: boolean) => { socket.destroy(); resolve(open); };
    socket.once('connect', () => finish(true)); socket.once('error', () => finish(false));
    socket.setTimeout(1000, () => finish(true));
  });
}

export class FixtureBrowser {
  private server?: ChildProcess;
  private serverExit?: Promise<void>;
  private serverFailed = false;
  private browser?: Browser;
  private browserServer?: BrowserServer;
  private page?: Page;
  private abort?: () => void;
  private serverLog = '';
  private purchaseRequests = 0;
  private observedErrors: string[] = [];
  private phase = 'next-start';
  private readonly channel = process.env.KIVRO_BROWSER_CHANNEL ?? 'chrome';
  private upload?: { ticketId: string; assetId: string; sha256: string; sizeBytes: number; s3PutStatus: number };
  private consent?: { quoteId: string; purchaseStartedAt: number; purchaseRespondedAt: number; idempotencyKey: string };

  constructor(readonly origin: string, private readonly signal: AbortSignal) {}

  async start(apiUrl: string, cookie: string): Promise<void> {
    assert.equal(new URL(this.origin).hostname, '127.0.0.1');
    assert.equal(new URL(apiUrl).hostname, '127.0.0.1');
    const webDirectory = fileURLToPath(new URL('../apps/web/', import.meta.url));
    const requireWeb = createRequire(new URL('../apps/web/package.json', import.meta.url));
    this.server = spawn(process.execPath, [requireWeb.resolve('next/dist/bin/next'), 'dev', '--hostname', '127.0.0.1', '--port', new URL(this.origin).port], {
      cwd: webDirectory, stdio: ['ignore', 'pipe', 'pipe'], detached: true,
      env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR,
        NODE_ENV: 'development', NEXT_TELEMETRY_DISABLED: '1', API_INTERNAL_URL: apiUrl },
    });
    const record = (chunk: Buffer) => { this.serverLog = (this.serverLog + chunk.toString()).slice(-8000); };
    this.server.stdout!.on('data', record); this.server.stderr!.on('data', record);
    this.serverExit = new Promise(resolve => {
      this.server!.once('exit', () => { this.serverFailed = true; resolve(); });
      this.server!.once('error', () => { this.serverFailed = true; resolve(); });
    });
    const deadline = Date.now() + 120_000;
    let ready = false;
    while (Date.now() < deadline) {
      this.check();
      try {
        const response = await fetch(`${this.origin}/api/terms`, { signal: AbortSignal.any([this.signal, AbortSignal.timeout(3000)]) });
        if (response.ok && typeof (await response.json()).version === 'string') { ready = true; break; }
      } catch { /* Initial compilation can outlast a probe; no alternate API is used. */ }
      await delay(250);
    }
    if (!ready) throw new Error('FIXTURE_BROWSER_NEXT_START_TIMEOUT');
    this.phase = 'chromium-start';
    this.browserServer = await chromium.launchServer({ channel: this.channel, headless: true, timeout: 30_000 });
    this.browser = await chromium.connect(this.browserServer.wsEndpoint(), { timeout: 15_000 });
    const context = await this.browser.newContext({ baseURL: this.origin, acceptDownloads: true, viewport: { width: 1365, height: 900 } });
    const session = cookie.split('; ').find(value => value.startsWith('kivro_session='));
    if (!session) throw new Error('FIXTURE_BROWSER_SESSION_MISSING');
    await context.addCookies([{ name: 'kivro_session', value: session.slice('kivro_session='.length), url: this.origin, httpOnly: true, sameSite: 'Lax' }]);
    this.page = await context.newPage();
    this.page.setDefaultTimeout(30_000); this.page.setDefaultNavigationTimeout(90_000);
    this.page.on('pageerror', () => { this.observedErrors.push('UNCAUGHT_PAGE_ERROR'); });
    this.page.on('request', request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/jobs') this.purchaseRequests++; });
    this.page.on('response', response => {
      if (response.status() >= 400 && new URL(response.url()).origin === this.origin && new URL(response.url()).pathname.startsWith('/api/')) {
        this.observedErrors.push(`API_${response.status()}_${new URL(response.url()).pathname.replace(/[a-f0-9-]{36}/g, ':id')}`);
      }
    });
    this.abort = () => { void this.browser?.close().catch(() => undefined); this.signalServer('SIGTERM'); };
    this.signal.addEventListener('abort', this.abort, { once: true });
    this.check();
  }

  private check(): void {
    if (this.signal.aborted) throw new Error('FIXTURE_CANCELLED');
    if (this.serverFailed) throw new Error('FIXTURE_BROWSER_NEXT_EXITED');
    if (this.observedErrors.length) throw new Error(`FIXTURE_BROWSER_${this.observedErrors[0]}`);
  }

  private response(path: string, method = 'POST'): Promise<BrowserResponse> {
    return observe(this.page!.waitForResponse(response => new URL(response.url()).origin === this.origin &&
      new URL(response.url()).pathname === path && response.request().method() === method, { timeout: 60_000 }));
  }

  async uploadSource(capability: CapabilityDTO, marker: string, s3Origin: string): Promise<AssetDTO> {
    this.check();
    this.phase = 'capability-page';
    const page = this.page!;
    await page.goto(`/capabilities/${capability.id}`);
    await expect(page.getByRole('heading', { name: capability.title, exact: true })).toBeVisible();
    const checkout = page.getByRole('region', { name: 'Create a job', exact: true });
    await expect(checkout.getByRole('button', { name: 'Review job', exact: true })).toBeVisible();
    const ticketResponse = this.response('/api/assets/uploads');
    const finalizeResponse = observe(page.waitForResponse(response => new URL(response.url()).origin === this.origin &&
      /^\/api\/assets\/uploads\/[a-f0-9-]{36}\/finalize$/.test(new URL(response.url()).pathname) && response.request().method() === 'POST', { timeout: 60_000 }));
    const storageResponse = observe(page.waitForResponse(response => new URL(response.url()).origin === s3Origin && response.request().method() === 'PUT', { timeout: 60_000 }));
    // Input bytes enter through the real file picker, checksum, presign, PUT and finalize code.
    this.phase = 'direct-upload-finalize';
    await checkout.getByLabel(/^Source\s*\*/).setInputFiles({ name: 'source.txt', mimeType: 'text/plain', buffer: Buffer.from(marker) });
    const ticket = await ticketResponse, put = await storageResponse, finalized = await finalizeResponse;
    assert(ticket.ok()); assert(put.ok()); assert(finalized.ok());
    const intent = await ticket.json() as { id: string; uploadUrl: string; method: string };
    assert.equal(intent.method, 'PUT'); assert.equal(new URL(intent.uploadUrl).origin, s3Origin);
    assert.equal(put.request().url(), intent.uploadUrl);
    assert.equal(new URL(finalized.url()).pathname, `/api/assets/uploads/${intent.id}/finalize`);
    const asset = AssetDTOSchema.parse(await finalized.json());
    assert.equal(asset.filename, 'source.txt'); assert.equal(asset.sha256, sha256(marker)); assert.equal(asset.sizeBytes, Buffer.byteLength(marker));
    await expect(checkout.getByRole('button', { name: 'Remove source.txt', exact: true })).toBeVisible();
    await expect(checkout.getByRole('button', { name: 'Review job', exact: true })).toBeEnabled();
    assert.equal(this.purchaseRequests, 0);
    this.upload = { ticketId: intent.id, assetId: asset.id, sha256: asset.sha256, sizeBytes: asset.sizeBytes, s3PutStatus: put.status() };
    this.check();
    this.phase = 'quote-and-unchecked-consent';
    return asset;
  }

  async purchase(capability: CapabilityDTO, asset: AssetDTO, assertUnpurchased: () => Promise<void>,
    onCreated: (job: JobDTO) => void): Promise<{ job: JobDTO; body: Record<string, unknown>; idempotencyKey: string }> {
    this.check();
    const page = this.page!, checkout = page.getByRole('region', { name: 'Create a job', exact: true });
    const quoteResponse = this.response(`/api/capabilities/${capability.id}/quote`);
    await checkout.getByRole('button', { name: 'Review job', exact: true }).click();
    const response = await quoteResponse; assert(response.ok());
    const quote = await response.json() as { id: string; priceSnapshot: { buyerPriceMinor: number }; expiresAt: string };
    assert.equal(quote.priceSnapshot.buyerPriceMinor, getPriceTier(capability.priceTierId).buyerPriceMinor);
    assert(Date.parse(quote.expiresAt) > Date.now());
    await expect(checkout.getByRole('heading', { name: 'Confirm your job', exact: true })).toBeVisible();
    const consent = checkout.getByRole('checkbox', { name: 'I approve this job, its price, timing and declared permissions.', exact: true });
    const purchase = checkout.getByRole('button', { name: /^Run now for / });
    await expect(consent).not.toBeChecked(); await expect(purchase).toBeDisabled();
    assert.equal(this.purchaseRequests, 0); await assertUnpurchased();
    await consent.check(); await expect(purchase).toBeEnabled();
    // Checking consent itself must not create a job or reserve credits.
    assert.equal(this.purchaseRequests, 0); await assertUnpurchased();
    const created = this.response('/api/jobs');
    const purchaseStartedAt = Date.now();
    this.phase = 'consented-purchase';
    await purchase.click();
    const result = await created, purchaseRespondedAt = Date.now(); assert(result.ok());
    const job = JobDTOSchema.parse(await result.json());
    onCreated(job);
    const body = result.request().postDataJSON() as Record<string, unknown>;
    assert.equal(body.capabilityId, capability.id); assert.equal(body.quoteId, quote.id);
    assert.equal(body.executionMode, 'NOW'); assert.deepEqual(body.input, { source: asset.id });
    const idempotencyKey = result.request().headers()['idempotency-key']; assert(idempotencyKey);
    assert.equal(this.purchaseRequests, 1);
    await page.waitForURL(`${this.origin}/jobs/${job.id}`);
    await expect(page.getByRole('heading', { name: capability.title, exact: true })).toBeVisible();
    this.consent = { quoteId: quote.id, purchaseStartedAt, purchaseRespondedAt, idempotencyKey };
    this.check();
    return { job, body, idempotencyKey };
  }

  async download(job: JobDTO, asset: AssetDTO, expected: string, s3Origin: string): Promise<Record<string, unknown>> {
    this.check();
    this.phase = 'rendered-result';
    const page = this.page!;
    await expect(page.locator('.job-state-bar')).toContainText('Completed', { timeout: 30_000 });
    await expect(page.locator('.job-state-bar')).toContainText('Paid');
    await expect(page.getByRole('region', { name: 'Summary', exact: true })).toContainText(String(job.output?.fields?.summary), { timeout: 30_000 });
    const report = page.getByRole('region', { name: 'Report', exact: true });
    const link = report.getByRole('link', { name: `Download ${asset.filename}`, exact: true });
    await expect(link).toBeVisible();
    await expect(link).toHaveAttribute('href', `/api/assets/${asset.id}/download`);
    const downloadEvent = observe(page.waitForEvent('download', { timeout: 30_000 }));
    this.phase = 'native-result-download';
    await link.click();
    // Native attachment downloads are not ordinary page responses in Chromium.
    // Verify the real download stream; the caller also correlates its API audit.
    const download = await downloadEvent;
    this.phase = 'native-download-bytes';
    const location = new URL(download.url());
    assert([this.origin, s3Origin].includes(location.origin)); assert(!location.username && !location.password);
    if (location.origin === this.origin) assert.equal(location.pathname, `/api/assets/${asset.id}/download`);
    assert.equal(download.suggestedFilename(), asset.filename);
    const stream = await bounded(download.createReadStream(), 20_000, 'FIXTURE_BROWSER_DOWNLOAD_STREAM_TIMEOUT');
    if (!stream) throw new Error('FIXTURE_BROWSER_DOWNLOAD_STREAM_MISSING');
    const chunks: Buffer[] = []; let size = 0;
    const collect = (async () => {
      for await (const part of stream) {
        const chunk = Buffer.from(part); size += chunk.length;
        if (size > 4096) throw new Error('FIXTURE_BROWSER_DOWNLOAD_TOO_LARGE');
        chunks.push(chunk);
      }
      return Buffer.concat(chunks);
    })();
    let data: Buffer;
    try { data = await bounded(collect, 20_000, 'FIXTURE_BROWSER_DOWNLOAD_TIMEOUT'); }
    finally { stream.destroy(); }
    assert.equal(await bounded(download.failure(), 5000, 'FIXTURE_BROWSER_DOWNLOAD_STATUS_TIMEOUT'), null);
    assert.equal(data.toString(), expected); assert.equal(data.length, asset.sizeBytes); assert.equal(sha256(data), asset.sha256);
    this.check();
    assert(this.upload && this.consent); assert.equal(this.purchaseRequests, 1);
    return { channel: this.channel, browserVersion: this.browser!.version(), headless: true,
      webOrigin: this.origin, actualNextApiProxy: true, sessionSource: 'actual-registration-cookie',
      upload: this.upload, quoteId: this.consent.quoteId, consentInitiallyUnchecked: true, purchaseDisabledBeforeConsent: true,
      jobsAndReservationsBeforeConsent: 0, consentAloneDoesNotPurchase: true, browserPurchaseRequests: this.purchaseRequests,
      purchaseStartedAt: this.consent.purchaseStartedAt, purchaseRespondedAt: this.consent.purchaseRespondedAt,
      resultRendered: true, completedAndPaidDisplayed: true, download: { filename: download.suggestedFilename(), sizeBytes: data.length, sha256: sha256(data),
        bytesBase64: data.toString('base64'), nativeDownloadOrigin: location.origin, storageOrigin: s3Origin },
      uncaughtPageErrors: 0, failedApiResponses: 0, routeMocks: 0 };
  }

  get purchaseWindow(): { startedAt: number; respondedAt: number } | undefined {
    return this.consent && { startedAt: this.consent.purchaseStartedAt, respondedAt: this.consent.purchaseRespondedAt };
  }

  private signalServer(signal: NodeJS.Signals): void {
    const child = this.server;
    if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
    try { process.kill(-child.pid, signal); }
    catch { try { child.kill(signal); } catch { /* The bounded exit check reports cleanup failure. */ } }
  }

  async close(): Promise<void> {
    if (this.abort) this.signal.removeEventListener('abort', this.abort);
    let closeError: unknown;
    try { if (this.browser) await bounded(this.browser.close(), 10_000, 'FIXTURE_BROWSER_CLOSE_TIMEOUT'); }
    catch (error) { closeError = error; }
    if (this.browserServer) {
      try { await bounded(this.browserServer.close(), 10_000, 'FIXTURE_BROWSER_PROCESS_CLOSE_TIMEOUT'); }
      catch {
        const child = this.browserServer.process();
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
        try { await bounded(this.browserServer.kill(), 5000, 'FIXTURE_BROWSER_PROCESS_KILL_TIMEOUT'); }
        catch (error) { closeError = error; }
      }
    }
    this.signalServer('SIGTERM');
    if (this.serverExit) {
      try { await bounded(this.serverExit, 10_000, 'FIXTURE_BROWSER_NEXT_STOP_TIMEOUT'); }
      catch { this.signalServer('SIGKILL'); await bounded(this.serverExit, 5000, 'FIXTURE_BROWSER_NEXT_KILL_TIMEOUT'); }
      const deadline = Date.now() + 3000;
      while (await portOpen(this.origin)) {
        if (Date.now() >= deadline) throw new Error('FIXTURE_BROWSER_NEXT_PORT_STILL_OPEN');
        await delay(100);
      }
    }
    if (closeError) throw closeError;
  }

  diagnostics(): Record<string, unknown> {
    // Never serialize HTTP headers, session cookies or signed storage URLs.
    return { phase: this.phase, browserErrors: this.observedErrors, nextExited: this.serverFailed,
      nextErrorLines: this.serverLog.split('\n').filter(line => /Error|EADDRINUSE|lock at/i.test(line)).slice(-5)
        .map(line => line.replace(/https?:\/\/\S+/g, '[url]').slice(0, 300)) };
  }
}

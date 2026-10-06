import { randomBytes } from 'node:crypto';
import { openSecret, sealSecret, type SealedSecret } from '@kivro/crypto';
import { runProcess } from '@kivro/openclaw-adapter';
import type { WorkerState } from './state.ts';

export class SecretStore {
  private key?: Buffer;
  constructor(readonly state: WorkerState) {}
  async initialize(create = false): Promise<void> {
    if (this.key) return;
    const supplied = process.env.KIVRO_WORKER_MASTER_KEY;
    if (supplied) {
      if (!/^[a-f0-9]{64}$/i.test(supplied)) throw new Error('MASTER_KEY_MUST_BE_32_BYTE_HEX');
      this.key = Buffer.from(supplied, 'hex'); return;
    }
    if (process.platform !== 'darwin') throw new Error('SET_KIVRO_WORKER_MASTER_KEY_OR_CONFIGURE_OS_KEYRING');
    const account = this.state.get<string>('localDeviceId')!;
    const found = await runProcess('/usr/bin/security', ['find-generic-password', '-s', 'io.kivro.worker.master', '-a', account, '-w']);
    if (found.code === 0 && /^[a-f0-9]{64}$/.test(found.stdout.trim())) { this.key = Buffer.from(found.stdout.trim(), 'hex'); return; }
    if (!create) throw new Error('WORKER_KEYCHAIN_KEY_NOT_CONFIGURED');
    const key = randomBytes(32);
    // Interactive stdin avoids exposing secret material in process arguments.
    const added = await runProcess('/usr/bin/security', ['-i'], { input: `add-generic-password -U -s io.kivro.worker.master -a ${account} -w ${key.toString('hex')}\n` });
    if (added.code !== 0) throw new Error('KEYCHAIN_WRITE_FAILED');
    const verify = await runProcess('/usr/bin/security', ['find-generic-password', '-s', 'io.kivro.worker.master', '-a', account, '-w']);
    if (verify.code !== 0 || verify.stdout.trim() !== key.toString('hex')) throw new Error('KEYCHAIN_VERIFY_FAILED');
    this.key = key;
  }
  async put(name: string, plaintext: string): Promise<void> {
    this.assertName(name); await this.initialize(true);
    if (!plaintext || plaintext.length > 16384) throw new Error('INVALID_SECRET');
    this.state.set(`secret:${name}`, sealSecret(plaintext, this.key!, `kivro:${this.state.get('localDeviceId')}:${name}`));
    this.state.transaction(() => {
      if (this.state.get<{ credentialRef: string }>('inference')?.credentialRef === name) this.state.delete('inferenceProof');
      for (const id of this.state.get<string[]>('capabilityIds') ?? []) {
        const capability = this.state.get<{ dependencies: { grants?: { credentialRefs?: string[] } }[] }>(`capability:${id}`);
        if (!capability?.dependencies.some(dependency => dependency.grants?.credentialRefs?.includes(name))) continue;
        this.state.delete(`capabilityProof:${id}`); this.state.set(`capabilityHealth:${id}`, { ready: false, checkedAt: Date.now() });
        this.state.set(`revalidationRequired:${id}`, 'CREDENTIAL_CHANGED'); this.state.audit('CREDENTIAL_REVALIDATION_REQUIRED', 'LOCAL', id);
      }
    });
  }
  async get(name: string): Promise<string> {
    this.assertName(name); await this.initialize();
    const sealed = this.state.get<SealedSecret>(`secret:${name}`); if (!sealed) throw new Error('SECRET_NOT_CONFIGURED');
    return openSecret(sealed, this.key!, `kivro:${this.state.get('localDeviceId')}:${name}`);
  }
  has(name: string): boolean { this.assertName(name); return !!this.state.get(`secret:${name}`); }
  private assertName(name: string): void { if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(name)) throw new Error('INVALID_SECRET_REFERENCE'); }
}

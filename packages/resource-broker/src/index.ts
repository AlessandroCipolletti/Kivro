import { z } from 'zod';
import { ResourceBrokerError, type JobResourceBudget, type LocalResource, type LocalResourceBrokerConfig,
  type ResourceApproval, type ResourceAuditEvent, type ResourceHealthResult, type ResourceRequest, type ResourceResult } from './types.ts';
import { ApprovalSchema, RequestSchema, ResourceSchema, assertClosure, boundedJson, compileResources,
  freeze, snapshotHash, type CompiledOperation } from './policy.ts';
import { checkSignal, readSelection } from './files.ts';
import { checkPostgresHealth, executePostgres } from './postgres.ts';

export * from './types.ts';
export { hashResourceConfiguration } from './policy.ts';
export const RESOURCE_HEALTH_TIMEOUT_MS = 5000;

const BudgetSchema = z.object({
  maxOperations: z.number().int().min(1).max(1000).default(32),
  maxRows: z.number().int().min(1).max(10000).default(1000),
  maxBytes: z.number().int().min(32).max(32 * 1024 ** 2).default(4 * 1024 ** 2),
  maxInputBytes: z.number().int().min(2).max(1024 ** 2).default(64 * 1024),
  maxDurationMs: z.number().int().min(1).max(3600_000).default(60_000),
}).strict();
interface JobUsage { operations: number; rows: number; bytes: number; inputBytes: number; deadline: number; active: boolean }

export class LocalResourceBroker {
  private readonly resources: Map<string, LocalResource>;
  private readonly approval: ResourceApproval;
  private readonly permissionsHash: string;
  private readonly dependenciesHash: string;
  private readonly compiled: Map<string, Map<string, CompiledOperation>>;
  private readonly budget: JobResourceBudget;
  private readonly secretResolver: LocalResourceBrokerConfig['secretResolver'];
  private readonly audit?: LocalResourceBrokerConfig['audit'];
  private readonly maxConcurrent: number;
  private readonly maxJobs: number;
  private readonly jobs = new Map<string, JobUsage>();
  private readonly active = new Map<AbortController, Promise<unknown>>();
  private healthController?: AbortController;
  private closed = false;

  constructor(config: LocalResourceBrokerConfig) {
    try {
      const resources = freeze(z.array(ResourceSchema).max(50).parse(structuredClone(config.resources)));
      this.approval = freeze(ApprovalSchema.parse(structuredClone(config.approval)));
      this.resources = new Map(resources.map(resource => [resource.id, resource]));
      this.compiled = compileResources(resources, this.approval);
      this.permissionsHash = snapshotHash(this.approval.permissions);
      this.dependenciesHash = snapshotHash(this.approval.dependencies);
      this.budget = freeze(BudgetSchema.parse(config.budget ?? {}));
      this.maxConcurrent = z.number().int().min(1).max(16).parse(config.maxConcurrentOperations ?? 4);
      this.maxJobs = z.number().int().min(1).max(10000).parse(config.maxTrackedJobs ?? 1000);
      if (typeof config.secretResolver !== 'function' || (config.audit !== undefined && typeof config.audit !== 'function')) throw new Error();
      this.secretResolver = config.secretResolver;
      this.audit = config.audit;
    } catch { throw new ResourceBrokerError('RESOURCE_CONFIGURATION_INVALID'); }
  }

  /** Host-only readiness probe. Never route this method to a sandbox tool. */
  async checkHealth(signal?: AbortSignal): Promise<ResourceHealthResult> {
    if (this.closed) throw new ResourceBrokerError('BROKER_CLOSED');
    if (signal?.aborted) throw new ResourceBrokerError('RESOURCE_CANCELLED');
    const configured = new Set(this.approval.grants.map(grant => grant.resourceId));
    if (this.approval.permissions.resources.some(resource => !configured.has(resource.id)) ||
      this.approval.dependencies.some(dependency => dependency.required && ['DATABASE', 'LOCAL_FILE'].includes(dependency.type) &&
        (!dependency.grants?.resources?.length || dependency.grants.resources.some(id => !configured.has(id))))) throw new ResourceBrokerError('RESOURCE_DENIED');
    if (this.healthController || this.active.size >= this.maxConcurrent) throw new ResourceBrokerError('RESOURCE_BUSY');
    const controller = new AbortController(), operationSignal = controller.signal;
    this.healthController = controller;
    const deadline = performance.now() + RESOURCE_HEALTH_TIMEOUT_MS;
    const onAbort = () => controller.abort(new ResourceBrokerError('RESOURCE_CANCELLED'));
    let rejectAbort!: (error: unknown) => void;
    const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
    const rejectOnAbort = () => rejectAbort(operationSignal.reason);
    operationSignal.addEventListener('abort', rejectOnAbort, { once: true });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    const timer = setTimeout(() => controller.abort(new ResourceBrokerError('RESOURCE_TIMEOUT')), RESOURCE_HEALTH_TIMEOUT_MS);
    const action = Promise.resolve().then(async () => {
      const resources: ResourceHealthResult['resources'] = [];
      for (const grant of [...this.approval.grants].sort((a, b) => a.resourceId < b.resourceId ? -1 : a.resourceId > b.resourceId ? 1 : 0)) {
        checkSignal(operationSignal);
        const resource = this.resources.get(grant.resourceId)!;
        assertClosure(resource, this.approval.permissions, this.approval.dependencies);
        const operations = [...new Set(grant.operations)].sort();
        if (resource.type === 'DATABASE') {
          const password = await this.secretResolver(resource.credentialRef, operationSignal);
          checkSignal(operationSignal);
          if (typeof password !== 'string' || !password.length || password.length > 16384) throw new ResourceBrokerError('RESOURCE_UNAVAILABLE');
          const remaining = Math.floor(deadline - performance.now());
          if (remaining <= 0) throw new ResourceBrokerError('RESOURCE_TIMEOUT');
          await checkPostgresHealth(resource, operations, password, remaining, operationSignal);
        } else {
          const contract = this.compiled.get(resource.id)!.get('read')!;
          const maxBytes = Math.min(resource.operations.read.limits.maxBytes, this.approval.permissions.limits.maxOutputBytes);
          for (const selection of resource.selections) {
            checkSignal(operationSignal);
            if (!contract.input({ selectionId: selection.id })) throw new ResourceBrokerError('INVALID_INPUT');
            const data = await readSelection(resource, { selectionId: selection.id }, maxBytes, operationSignal);
            this.validateResult(resource, 'read', data, maxBytes);
          }
        }
        resources.push({ resourceId: resource.id, operations });
      }
      checkSignal(operationSignal);
      return freeze({ ready: true as const, capabilityVersionId: this.approval.capabilityVersionId, checkedAt: new Date().toISOString(), resources });
    });
    this.active.set(controller, action);
    // Retain the slot if a resolver ignores cancellation; a timed-out pass must
    // never create connections later or accumulate unbounded overlapping work.
    void action.finally(() => { this.active.delete(controller); this.healthController = undefined; }).catch(() => {});
    try {
      const result = await Promise.race([action, aborted]);
      checkSignal(operationSignal);
      return result;
    } catch (error) {
      throw error instanceof ResourceBrokerError ? error : new ResourceBrokerError('RESOURCE_UNAVAILABLE');
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      operationSignal.removeEventListener('abort', rejectOnAbort);
    }
  }

  async execute(raw: ResourceRequest, signal?: AbortSignal): Promise<ResourceResult> {
    let event: ResourceAuditEvent = { jobId: 'invalid', resourceId: 'invalid', operation: 'invalid', outcome: 'DENIED', code: 'INVALID_INPUT' };
    let usage: JobUsage | undefined, controller: AbortController | undefined, timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    try {
      if (this.closed) throw new ResourceBrokerError('BROKER_CLOSED');
      const parsed = RequestSchema.safeParse(raw);
      if (!parsed.success) throw new ResourceBrokerError('INVALID_INPUT');
      const request = parsed.data;
      event = { jobId: request.jobId, resourceId: request.resourceId, operation: request.operation, outcome: 'DENIED', code: 'RESOURCE_DENIED' };
      if (snapshotHash(request.permissions) !== this.permissionsHash || snapshotHash(request.dependencies) !== this.dependenciesHash) throw new ResourceBrokerError('RESOURCE_DENIED');
      const resource = this.resources.get(request.resourceId), contract = this.compiled.get(request.resourceId)?.get(request.operation);
      const grant = this.approval.grants.find(item => item.resourceId === request.resourceId);
      if (!resource || !contract || !grant?.operations.includes(request.operation)) throw new ResourceBrokerError('RESOURCE_DENIED');
      assertClosure(resource, request.permissions, request.dependencies);
      if (signal?.aborted) throw new ResourceBrokerError('RESOURCE_CANCELLED');
      const input = boundedJson(request.input, Math.min(this.budget.maxInputBytes, request.permissions.limits.maxInputBytes), 'INVALID_INPUT');
      if (!contract.input(input.value)) throw new ResourceBrokerError('INVALID_INPUT');
      if (this.active.size >= this.maxConcurrent) throw new ResourceBrokerError('RESOURCE_BUSY');
      let job = this.jobs.get(request.jobId);
      if (!job) {
        if (this.jobs.size >= this.maxJobs) throw new ResourceBrokerError('RESOURCE_BUDGET_EXCEEDED');
        job = { operations: 0, rows: 0, bytes: 0, inputBytes: 0,
          deadline: performance.now() + Math.min(this.budget.maxDurationMs, request.permissions.limits.timeoutSeconds * 1000), active: false };
        this.jobs.set(request.jobId, job);
      }
      if (job.active) throw new ResourceBrokerError('RESOURCE_BUSY');
      const operation = resource.type === 'DATABASE' ? resource.operations[request.operation]! : resource.operations.read;
      const maxRows = Math.min(operation.limits.maxRows, this.budget.maxRows - job.rows);
      const maxBytes = Math.min(operation.limits.maxBytes, this.budget.maxBytes - job.bytes, request.permissions.limits.maxOutputBytes - job.bytes);
      const timeout = Math.floor(Math.min(operation.limits.timeoutMs, job.deadline - performance.now()));
      if (job.operations >= this.budget.maxOperations || maxRows < 1 || maxBytes < 32 ||
        job.inputBytes + input.bytes > Math.min(this.budget.maxInputBytes, request.permissions.limits.maxInputBytes) || timeout <= 0) throw new ResourceBrokerError('RESOURCE_BUDGET_EXCEEDED');
      // Reserve synchronously before the first await. Failed/cancelled operations
      // retain their reservation, so parallel failures cannot replenish budgets.
      job.operations++; job.rows += maxRows; job.bytes += maxBytes; job.inputBytes += input.bytes; job.active = true;
      usage = job;
      controller = new AbortController();
      const operationSignal = controller.signal;
      onAbort = () => controller!.abort(new ResourceBrokerError('RESOURCE_CANCELLED'));
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      let rejectAbort!: (error: unknown) => void;
      const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
      const rejectOnAbort = () => rejectAbort(operationSignal.reason);
      operationSignal.addEventListener('abort', rejectOnAbort, { once: true });
      timer = setTimeout(() => controller!.abort(new ResourceBrokerError('RESOURCE_TIMEOUT')), timeout);
      const action = (async () => {
        checkSignal(operationSignal);
        let data: unknown, password: string | undefined;
        if (resource.type === 'DATABASE') {
          password = await this.secretResolver(resource.credentialRef, operationSignal);
          checkSignal(operationSignal);
          if (typeof password !== 'string' || !password.length || password.length > 16384) throw new ResourceBrokerError('RESOURCE_UNAVAILABLE');
          data = await executePostgres(resource, resource.operations[request.operation]!, input.value as Record<string, unknown>, password, maxRows, maxBytes, timeout, operationSignal);
        } else data = await readSelection(resource, input.value, maxBytes, operationSignal);
        checkSignal(operationSignal);
        return this.validateResult(resource, request.operation, data, maxBytes, password);
      })();
      this.active.set(controller, action);
      event.outcome = 'FAILED';
      let result: ResourceResult;
      try { result = await Promise.race([action, aborted]); }
      finally { operationSignal.removeEventListener('abort', rejectOnAbort); }
      checkSignal(operationSignal);
      job.rows -= maxRows - result.metadata.rows;
      job.bytes -= maxBytes - result.metadata.bytes;
      event = { ...event, outcome: 'ALLOWED', code: 'OK', rows: result.metadata.rows, bytes: result.metadata.bytes };
      return result;
    } catch (error) {
      const safe = error instanceof ResourceBrokerError ? error : new ResourceBrokerError('RESOURCE_UNAVAILABLE');
      event.code = safe.code;
      throw safe;
    } finally {
      if (timer) clearTimeout(timer);
      if (onAbort) signal?.removeEventListener('abort', onAbort);
      if (controller) {
        // An uncooperative resolver keeps a bounded slot occupied; it can never
        // start a connection after cancellation or permit budget-reset retries.
        const action = this.active.get(controller);
        if (action) void action.finally(() => { this.active.delete(controller!); if (usage) usage.active = false; }).catch(() => {});
      }
      try { this.audit?.(freeze(event)); } catch { /* Audit callbacks cannot leak host errors into frames. */ }
    }
  }

  private validateResult(resource: LocalResource, operation: string, data: unknown, maxBytes: number, password?: string): ResourceResult {
    const validated = boundedJson(data, maxBytes, 'INVALID_OUTPUT');
    if (!this.compiled.get(resource.id)!.get(operation)!.output(validated.value)) throw new ResourceBrokerError('INVALID_OUTPUT');
    if ((password && validated.json.includes(JSON.stringify(password).slice(1, -1))) ||
      (resource.type === 'LOCAL_FILE' && resource.selections.some(file => validated.json.includes(file.path)))) throw new ResourceBrokerError('INVALID_OUTPUT');
    const rows = resource.type === 'DATABASE' ? (validated.value as unknown[]).length : 1;
    const result: ResourceResult = { data: validated.value, metadata: { resourceId: resource.id, operation,
      dataClasses: ['SELLER_PRIVATE'], untrusted: true, rows, bytes: 0 } };
    // Count the complete JSON frame payload, including metadata and its own byte count.
    for (let i = 0; i < 4; i++) result.metadata.bytes = Buffer.byteLength(JSON.stringify(result));
    boundedJson(result, maxBytes, 'INVALID_OUTPUT');
    return result;
  }

  close(): void {
    this.closed = true;
    for (const controller of this.active.keys()) controller.abort(new ResourceBrokerError('BROKER_CLOSED'));
  }
}

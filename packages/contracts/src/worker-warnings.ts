import { z } from 'zod';

export const WorkerWarningCodeSchema = z.enum([
  'WORKER_UPDATE_REQUIRED', 'WORKER_VERSION_REVOKED', 'OPENCLAW_UPDATE_REQUIRED', 'OPENCLAW_VERSION_REVOKED',
  'DEVICE_REVOKED', 'SANDBOX_NOT_READY', 'HEARTBEAT_EXPIRED', 'CAPABILITY_REVALIDATION_REQUIRED',
  'CAPABILITY_NOT_READY', 'CAPABILITY_SECURITY_BLOCKED', 'CATEGORY_BLOCKED',
  'SANDBOX_SELF_TEST_FAILED', 'UNEXPECTED_PERMISSION_USE', 'DEPENDENCY_PERMISSION_CHANGED',
  'NETWORK_POLICY_VIOLATION', 'CREDENTIAL_CONFIGURATION_UNSAFE', 'SECURITY_POLICY_OUTDATED',
  'DEPENDENCY_UNAVAILABLE', 'INFERENCE_UNAVAILABLE',
]);
export type WorkerWarningCode = z.infer<typeof WorkerWarningCodeSchema>;
export const WorkerWarningSignalSchema = z.object({
  code: z.enum(['SANDBOX_SELF_TEST_FAILED', 'UNEXPECTED_PERMISSION_USE', 'DEPENDENCY_PERMISSION_CHANGED',
    'NETWORK_POLICY_VIOLATION', 'CREDENTIAL_CONFIGURATION_UNSAFE', 'SECURITY_POLICY_OUTDATED',
    'DEPENDENCY_UNAVAILABLE', 'INFERENCE_UNAVAILABLE', 'CAPABILITY_REVALIDATION_REQUIRED']),
  capabilityVersionId: z.string().uuid().optional(),
}).strict();
export const WorkerWarningSignalsSchema = z.array(WorkerWarningSignalSchema).max(100);
export type WorkerWarningSignal = z.infer<typeof WorkerWarningSignalSchema>;

export const WorkerSecurityWarningSchema = z.object({
  id: z.string().min(1).max(180).regex(/^[A-Za-z0-9:_-]+$/), code: WorkerWarningCodeSchema,
  severity: z.enum(['INFO', 'WARNING', 'CRITICAL']), title: z.string().min(1).max(120),
  description: z.string().min(1).max(600), requiredAction: z.string().min(1).max(300),
  affectedEntity: z.object({ workerId: z.string().uuid(), capabilityId: z.string().uuid().nullable(), capabilityVersionId: z.string().uuid().nullable() }).strict(),
  detectedAt: z.string().datetime(), lastObservedAt: z.string().datetime(), detectedAtBasis: z.literal('FIRST_PLATFORM_OBSERVATION'),
  source: z.enum(['PLATFORM_STATE', 'WORKER_REPORT']), blocking: z.boolean(),
}).strict();
export type WorkerSecurityWarning = z.infer<typeof WorkerSecurityWarningSchema>;
export const WorkerWarningSnapshotSchema = z.object({
  schemaVersion: z.literal(1), observedAt: z.string().datetime(), items: z.array(WorkerSecurityWarningSchema).max(500),
  capabilityVersionsChecked: z.number().int().min(0).max(100), truncated: z.boolean(),
  coverage: z.object({
    capabilityScope: z.literal('BOUND_VERSIONS_ONLY'), localSignals: z.enum(['REPORTED', 'UNAVAILABLE', 'STALE']),
    ignoredSignalCount: z.number().int().min(0).max(100), deviceRevocationSchedule: z.literal('UNAVAILABLE'),
  }).strict(),
}).strict();
export type WorkerWarningSnapshot = z.infer<typeof WorkerWarningSnapshotSchema>;

type WarningText = Pick<WorkerSecurityWarning, 'severity' | 'title' | 'description' | 'requiredAction'>;
export const WORKER_WARNING_CATALOG: Readonly<Record<WorkerWarningCode, WarningText>> = Object.freeze({
  WORKER_UPDATE_REQUIRED: { severity: 'CRITICAL', title: 'Worker update required', description: 'The recorded Worker version does not satisfy the operator minimum. New execution is blocked by version policy.', requiredAction: 'Install an approved Worker release and rerun diagnostics.' },
  WORKER_VERSION_REVOKED: { severity: 'CRITICAL', title: 'Worker version revoked', description: 'The operator has revoked the recorded Worker version. New execution is blocked by version policy.', requiredAction: 'Install an approved release; do not override the version restriction.' },
  OPENCLAW_UPDATE_REQUIRED: { severity: 'CRITICAL', title: 'OpenClaw version not supported by policy', description: 'The recorded OpenClaw version is unknown or below the operator minimum. New execution is blocked.', requiredAction: 'Use an approved runtime and adapter, then rerun diagnostics and validation.' },
  OPENCLAW_VERSION_REVOKED: { severity: 'CRITICAL', title: 'OpenClaw version revoked', description: 'The operator has revoked the recorded OpenClaw version. New execution is blocked by version policy.', requiredAction: 'Install the approved runtime and sandbox update and revalidate capabilities.' },
  DEVICE_REVOKED: { severity: 'CRITICAL', title: 'Device credential revoked', description: 'This device has been revoked in the control plane. Its signed requests cannot authorize new execution.', requiredAction: 'Resolve the operator restriction and pair a new approved device identity.' },
  SANDBOX_NOT_READY: { severity: 'WARNING', title: 'Runtime readiness is not established', description: 'The cloud does not hold a current ready runtime report. This does not identify a particular failed self-test.', requiredAction: 'Run Worker diagnostics and resolve the reported readiness blockers.' },
  HEARTBEAT_EXPIRED: { severity: 'WARNING', title: 'Worker contact is unavailable', description: 'No fresh heartbeat is recorded. New execution cannot be assigned to this device.', requiredAction: 'Check the Worker connection and local diagnostics without resetting durable job state.' },
  CAPABILITY_REVALIDATION_REQUIRED: { severity: 'WARNING', title: 'Capability requires revalidation', description: 'This device lacks a current successful validation for the exact capability version and manifest.', requiredAction: 'Review the immutable version and run its full capability validation.' },
  CAPABILITY_NOT_READY: { severity: 'WARNING', title: 'Capability readiness is not established', description: 'This device has not reported the bound capability version healthy. The failing dependency is not identified by this flag.', requiredAction: 'Inspect capability diagnostics, required resources and dedicated inference.' },
  CAPABILITY_SECURITY_BLOCKED: { severity: 'CRITICAL', title: 'Capability blocked by operator', description: 'The capability has an active control-plane security restriction. New execution is blocked.', requiredAction: 'Contact the operator and resolve the restriction; do not republish to bypass it.' },
  CATEGORY_BLOCKED: { severity: 'CRITICAL', title: 'Capability category restricted', description: 'The capability category is blocked by the current operator security policy.', requiredAction: 'Review the operator policy and resolve the restriction before execution.' },
  SANDBOX_SELF_TEST_FAILED: { severity: 'CRITICAL', title: 'Worker reports sandbox self-test failure', description: 'The authenticated Worker reported an isolation self-test failure. This report is not an independent cloud probe.', requiredAction: 'Keep execution stopped, inspect local diagnostics and repeat the approved sandbox self-test.' },
  UNEXPECTED_PERMISSION_USE: { severity: 'CRITICAL', title: 'Worker reports unexpected permission use', description: 'The authenticated Worker reported an operation outside its declared permissions. No raw operation or job input is included.', requiredAction: 'Inspect the local security audit and revalidate the approved permission manifest.' },
  DEPENDENCY_PERMISSION_CHANGED: { severity: 'CRITICAL', title: 'Worker reports changed dependency permissions', description: 'The authenticated Worker reported that approved dependency or consent evidence changed.', requiredAction: 'Review the changed dependency, explicitly approve it where appropriate, and revalidate.' },
  NETWORK_POLICY_VIOLATION: { severity: 'CRITICAL', title: 'Worker reports network policy violation', description: 'The authenticated Worker reported an attempted operation outside the approved network policy. Destination and content are not exposed.', requiredAction: 'Review local policy events and the approved network declaration before resuming.' },
  CREDENTIAL_CONFIGURATION_UNSAFE: { severity: 'CRITICAL', title: 'Worker reports unsafe credential configuration', description: 'The authenticated Worker reported a dedicated credential or secret-store configuration failure. This is not a claim that a credential leaked.', requiredAction: 'Repair the dedicated credential configuration locally and rerun diagnostics; never share the secret.' },
  SECURITY_POLICY_OUTDATED: { severity: 'CRITICAL', title: 'Security validation evidence is outdated', description: 'Recorded validation evidence or the authenticated Worker report identifies an outdated security policy. The warning source identifies which evidence was observed.', requiredAction: 'Install the approved policy/runtime update and repeat required local validation.' },
  DEPENDENCY_UNAVAILABLE: { severity: 'WARNING', title: 'Worker reports unavailable dependency', description: 'The authenticated Worker reported a required local dependency unavailable. No private resource path or connection details are exposed.', requiredAction: 'Restore the approved resource or service and rerun capability diagnostics.' },
  INFERENCE_UNAVAILABLE: { severity: 'WARNING', title: 'Worker reports unavailable inference', description: 'The authenticated Worker reported dedicated inference unavailable. Provider cost, account balance and credential validity are not inferred.', requiredAction: 'Check dedicated inference configuration locally and run its explicit health test.' },
});

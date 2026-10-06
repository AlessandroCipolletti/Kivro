import { getPriceTier, type CapabilityDTO } from '@kivro/contracts';
import { AgentPolicyError, BuyerConstraintsSchema, TimingPolicySchema, type BuyerConstraints, type AgentTimingPolicy, type AgentRecommendation } from './types.js';
import { publicDiscoveryText } from './public-discovery.js';
import { matchOutputRequirements } from './contract-matching.js';

export function capabilityPrice(capability: CapabilityDTO): number {
  const tier = getPriceTier(capability.priceTierId);
  if (!tier?.enabled || !Number.isSafeInteger(tier.buyerPriceMinor) || tier.buyerPriceMinor < 0) throw new AgentPolicyError('INVALID_PRICE');
  return tier.buyerPriceMinor;
}

export function eligibleAt(capability: CapabilityDTO, timing: AgentTimingPolicy, now = new Date()): Date | null {
  const availability = capability.availability as CapabilityDTO['availability'] & { estimatedQueueWaitSeconds?: number };
  if (!Number.isFinite(capability.estimatedDurationSeconds) || capability.estimatedDurationSeconds < 0) return null;
  const denied = ['OFFLINE', 'PAUSED', 'SECURITY_BLOCKED', 'QUEUE_FULL', 'UNKNOWN_AVAILABILITY', 'UNKNOWN'];
  if (denied.includes(availability.status)) return null;
  let start: Date | null = null;
  if (availability.canRunNow && ['ONLINE', 'AVAILABLE', 'AVAILABLE_NOW', 'READY'].includes(availability.status)) start = now;
  if (availability.status === 'BUSY' && availability.canQueue === true && timing.mode === 'IMMEDIATE' &&
    Number.isFinite(availability.estimatedQueueWaitSeconds) && availability.estimatedQueueWaitSeconds! >= 0 &&
    availability.estimatedQueueWaitSeconds! <= timing.maxQueueWaitSeconds) {
    start = new Date(now.getTime() + availability.estimatedQueueWaitSeconds! * 1000);
  }
  if (!start && timing.mode !== 'IMMEDIATE' && availability.nextAvailableAt &&
    ['SCHEDULED_OFFLINE', 'SCHEDULED', 'BUSY'].includes(availability.status)) {
    const next = new Date(availability.nextAvailableAt);
    if (Number.isFinite(next.getTime()) && next >= now) start = next;
  }
  if (start && timing.mode === 'DEADLINE' && start.getTime() + capability.estimatedDurationSeconds * 1000 > Date.parse(timing.deadlineAt)) return null;
  return start;
}

/** A bounded BUSY queue is NOW procurement, never implicit future scheduling. */
export function executionModeFor(capability: CapabilityDTO, timing: AgentTimingPolicy): 'NOW' | 'SCHEDULED' {
  return capability.availability.canRunNow || (timing.mode === 'IMMEDIATE' && capability.availability.canQueue === true) ? 'NOW' : 'SCHEDULED';
}

export function candidateViolation(capability: CapabilityDTO, constraints: BuyerConstraints,
  timing?: AgentTimingPolicy, now = new Date()): string | null {
  if (capability.visibility !== 'PUBLIC') return 'NOT_PUBLIC';
  if (constraints.blockedSellers.includes(capability.seller.id)) return 'SELLER_BLOCKED';
  if (constraints.onlineOnly && (!capability.availability.canRunNow || capability.availability.status !== 'ONLINE')) return 'ONLINE_ONLY_CONSTRAINT';
  if (capability.dependencies.some(dep => dep.required && (!dep.approved || !dep.healthy))) return 'DEPENDENCY_UNAVAILABLE';
  let price: number;
  try { price = capabilityPrice(capability); } catch { return 'INVALID_PRICE'; }
  if (price > Math.min(constraints.maxTotalSpendMinor, constraints.maxPerJobSpendMinor ?? Infinity)) return 'BUDGET_EXCEEDED';
  if (constraints.minRating !== undefined && (capability.rating === null || capability.rating < constraints.minRating)) return 'RATING_CONSTRAINT';
  if (constraints.maxRuntimeSeconds !== undefined && capability.estimatedDurationSeconds > constraints.maxRuntimeSeconds) return 'RUNTIME_CONSTRAINT';
  if (constraints.noNetwork && capability.permissions.network.mode !== 'NONE') return 'PERMISSION_CONSTRAINT';
  if (constraints.outputTypes && !constraints.outputTypes.includes(capability.ioContract.output.type)) return 'OUTPUT_CONSTRAINT';
  if (constraints.requiredOutputFiles) {
    try {
      if (!matchOutputRequirements(capability.ioContract, { files: constraints.requiredOutputFiles.map(({ count, ...format }) => ({ ...format, minCount: count })) }).compatible) return 'OUTPUT_CONSTRAINT';
    } catch { return 'OUTPUT_CONSTRAINT'; }
  }
  if (timing && !eligibleAt(capability, timing, now)) return 'NOT_TIMING_ELIGIBLE';
  return null;
}

export function rankCandidates(capabilities: CapabilityDTO[], query: string, constraints: BuyerConstraints,
  timing?: AgentTimingPolicy, now = new Date()): CapabilityDTO[] {
  BuyerConstraintsSchema.parse(constraints);
  if (timing) TimingPolicySchema.parse(timing);
  const terms = queryTerms(query);
  const matches = new Map(capabilities.map(capability => [capability.id, matchedTerms(capability, terms).length]));
  const relevance = (c: CapabilityDTO): number => matches.get(c.id) ?? 0;
  const preference = (c: CapabilityDTO): number => {
    const index = constraints.preferredCapabilityIds?.indexOf(c.id) ?? -1;
    return index < 0 ? Infinity : index;
  };
  const score = (c: CapabilityDTO): number => {
    return relevance(c) * 10 +
      (c.availability.canRunNow ? 3 : 0) + (c.rating ?? 0) * Math.min(c.reviewCount / 10, 1) +
      (c.successRate ?? 0) / 100 - capabilityPrice(c) / Math.max(1, constraints.maxTotalSpendMinor);
  };
  return capabilities.filter(c => (!terms.length || relevance(c) > 0) && !candidateViolation(c, constraints, timing, now))
    .sort((a, b) => preference(a) - preference(b) || score(b) - score(a) || a.id.localeCompare(b.id));
}

function queryTerms(query: string): string[] {
  const stopWords = new Set(['the', 'and', 'for', 'with', 'please', 'need', 'want', 'can', 'you', 'find', 'best', 'under']);
  return [...new Set(query.toLowerCase().split(/[^\p{L}\p{N}_]+/u).filter(term => term.length > 2 && !stopWords.has(term)))].slice(0, 50);
}
function matchedTerms(capability: CapabilityDTO, terms: string[]): string[] {
  const searchable = publicDiscoveryText(capability);
  return terms.filter(term => searchable.includes(term));
}

/** Whitelisted catalog facts only; descriptions and inference output cannot manufacture rationale. */
export function describeRecommendation(capability: CapabilityDTO, query: string, constraints: BuyerConstraints,
  compared: CapabilityDTO[] = [], now = new Date()): AgentRecommendation {
  const amountMinor = capabilityPrice(capability), availability = capability.availability;
  const matches = matchedTerms(capability, queryTerms(query));
  const preferred = constraints.preferredCapabilityIds?.includes(capability.id) === true;
  const output = capability.ioContract.output;
  const fileFields = (output.fields ?? []).filter(field => ['FILE', 'FILES'].includes(field.type));
  const allowedMimeTypes = [...new Set([...(output.files?.allowedMimeTypes ?? []), ...fileFields.flatMap(field => field.constraints?.allowedMimeTypes ?? [])])].sort();
  const allowedExtensions = [...new Set([...(output.files?.allowedExtensions ?? []), ...fileFields.flatMap(field => field.constraints?.allowedExtensions ?? [])])].sort();
  const requiredInputs = capability.ioContract.inputs.filter(field => field.required).map(field => ({ key: field.key, type: field.type }));
  const tools = [...capability.permissions.tools].sort(), networkMode = capability.permissions.network.mode;
  const limitations = ['Runtime and availability are estimates at recommendation time, not a reserved execution slot.'];
  if (requiredInputs.length) limitations.push(`Requires buyer input: ${requiredInputs.map(field => `${field.key} (${field.type})`).join(', ')}.`);
  if (!allowedMimeTypes.length && !allowedExtensions.length) limitations.push(`The ${output.type} contract declares no downloadable file output.`);
  else {
    limitations.push(`File output is limited to the declared formats: ${allowedExtensions.join(', ')}; ${allowedMimeTypes.join(', ')}. Limits may differ by output field.`);
    if (output.files) limitations.push(`Combined output file limit: ${output.files.maxFiles} files, ${output.files.maxTotalSizeBytes} bytes.`);
  }
  if (!allowedMimeTypes.includes('application/pdf') || !allowedExtensions.includes('.pdf')) limitations.push('PDF file output is not declared by this contract.');
  if (capability.rating === null) limitations.push('No marketplace rating is available.');
  if (networkMode === 'NONE') limitations.push('Sandbox network access is disabled; this does not imply that seller inference runs locally.');
  else limitations.push('Declared external tool access does not authorize sending private inputs to external services.');
  const alternatives = compared.filter(other => other.id !== capability.id);
  const tradeoffs: string[] = [];
  if (alternatives.length) {
    const cheapest = Math.min(...alternatives.map(capabilityPrice));
    const fastest = Math.min(...alternatives.map(other => other.estimatedDurationSeconds));
    if (amountMinor > cheapest) tradeoffs.push(`Costs $${((amountMinor - cheapest) / 100).toFixed(2)} more than the least expensive compared match.`);
    if (capability.estimatedDurationSeconds > fastest) tradeoffs.push(`Estimated runtime is ${capability.estimatedDurationSeconds - fastest} seconds longer than the fastest compared match.`);
  }
  if (!availability.canRunNow) tradeoffs.push('Cannot start immediately; a separate timing choice and availability check are required.');
  if (networkMode !== 'NONE') tradeoffs.push(`Uses ${networkMode} tool network access rather than a network-disabled sandbox.`);
  const queueWait = availability.estimatedQueueWaitSeconds;
  const estimatedQueueWaitSeconds = typeof queueWait === 'number' && Number.isFinite(queueWait) && queueWait >= 0 ? queueWait : null;
  return {
    capabilityId: capability.id, capabilityVersionId: capability.versionId, capabilityTitle: capability.title, generatedAt: now.toISOString(),
    reason: `${preferred ? 'Buyer-preferred capability. ' : ''}${matches.length ? `Public catalog keywords match: ${matches.join(', ')}. ` : ''}Matches the selected catalog constraints.`,
    matchedTerms: matches, preferred,
    price: { currency: 'USD', amountMinor, label: `$${(amountMinor / 100).toFixed(2)} USD per job` },
    rating: { value: capability.rating, reviewCount: capability.reviewCount,
      label: capability.rating === null ? `Not rated (${capability.reviewCount} reviews)` : `${capability.rating.toFixed(1)}/5 (${capability.reviewCount} reviews)` },
    timing: { status: availability.status, estimatedRuntimeSeconds: capability.estimatedDurationSeconds, canRunNow: availability.canRunNow,
      canQueue: availability.canQueue === true, nextAvailableAt: availability.nextAvailableAt, estimatedQueueWaitSeconds,
      label: `${availability.status}; estimated runtime ${capability.estimatedDurationSeconds} seconds${estimatedQueueWaitSeconds === null ? '' : `; estimated queue wait ${estimatedQueueWaitSeconds} seconds`}` },
    permissions: { networkMode, tools, resourceCount: capability.permissions.resources.length,
      label: `Sandbox network: ${networkMode}; tools: ${tools.join(', ') || 'none'}; declared read-only resources: ${capability.permissions.resources.length}` },
    io: { requiredInputs, outputType: output.type, allowedMimeTypes, allowedExtensions,
      label: `${requiredInputs.length} required inputs; ${output.type} output${allowedExtensions.length ? ` (${allowedExtensions.join(', ')})` : ''}` },
    tradeoffs, limitations,
  };
}

// Defense-in-depth wall ceilings, not extra execution grants. The host owns
// active time and confirmed pause accounting and kills the entire container.
export function sandboxTiming(manifest) {
  if (!Number.isSafeInteger(manifest.timeoutSeconds) || manifest.timeoutSeconds < 5 || manifest.timeoutSeconds > 3600 || !Number.isSafeInteger(manifest.maxPauseMs) || manifest.maxPauseMs < 1000 || manifest.maxPauseMs > 900000) throw new Error('INVALID_EXECUTION_TIMING');
  return { wallSeconds: manifest.timeoutSeconds + Math.ceil(manifest.maxPauseMs / 1000), wallMs: manifest.timeoutSeconds * 1000 + manifest.maxPauseMs, bridgeMs: 65000 + manifest.maxPauseMs };
}

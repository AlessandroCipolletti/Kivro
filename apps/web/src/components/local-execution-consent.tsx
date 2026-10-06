import React from "react";

export function LocalExecutionConsent({ checked, onChange }: { checked: boolean; onChange: (value: boolean) => void }) {
  return <section aria-label="Local execution approval" className="stack">
    <h3>Jobs run on your Worker computer</h3>
    <p>Each buyer job uses a separate restricted OpenClaw environment and only the resources you explicitly approve. Your personal OpenClaw session is not used and your personal workspace is not shared.</p>
    <p>Inference uses your selected provider and model. You pay remote provider usage; local inference uses your computer, memory and electricity. Keeping the Worker computer available is your responsibility.</p>
    <label className="checkbox-row align-start"><input type="checkbox" checked={checked} onChange={event => onChange(event.target.checked)} /><span>I understand and approve local execution and seller-paid inference for this saved version.</span></label>
  </section>;
}

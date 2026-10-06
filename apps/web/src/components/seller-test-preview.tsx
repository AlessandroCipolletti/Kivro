"use client";
import { useRef, useState } from "react";
import { Download } from "lucide-react";
import { SELLER_TEST_MAX_FILES, SELLER_TEST_MAX_TOTAL_BYTES, type SellerTestAsset } from "@kivro/contracts/seller-test";
import { effectiveFileLimit } from "@kivro/contracts/file-limits";
import type { IOContract, SellerCapability } from "../lib/types";
import { initialInput } from "../lib/forms";
import { sellerTestAsset, sellerTestBundle, downloadJson } from "../lib/seller-test";
import { money } from "../lib/format";
import { useAction } from "../lib/hooks";
import { ContractForm } from "./contract-form";
import { Button, ErrorNotice, Notice } from "./ui";

export function SellerTestPreview({ title, summary, contract, priceMinor, saved, dirty }: { title: string; summary: string; contract: IOContract; priceMinor?: number; saved?: SellerCapability; dirty: boolean }) {
  const [input, setInput] = useState(() => initialInput(contract));
  const [busy, setBusy] = useState(false);
  const [assets, setAssets] = useState<SellerTestAsset[]>([]);
  const selected = useRef<SellerTestAsset[]>([]);
  const reserved = useRef({ count: 0, bytes: 0 });
  const action = useAction();
  const pinned = Boolean(saved && !dirty && saved.manifestHash);
  function changeInput(next: Record<string, unknown>) {
    setInput(next);
    const refs = new Set(contract.inputs.filter(field => ["FILE", "FILES"].includes(field.type)).flatMap(field => {
      const value = next[field.key]; return value == null ? [] : Array.isArray(value) ? value : [value];
    }));
    selected.current = selected.current.filter(asset => refs.has(asset.id)); setAssets(selected.current);
  }
  async function selectFiles(files: File[]) {
    if (!saved || !pinned) throw new Error("Save and refresh this exact version before selecting local test files.");
    const size = files.reduce((sum, file) => sum + file.size, 0);
    const limit = effectiveFileLimit(SELLER_TEST_MAX_TOTAL_BYTES, saved.permissions.limits.maxInputBytes, saved.executionFileLimits?.inputBytes);
    if (selected.current.length + reserved.current.count + files.length > SELLER_TEST_MAX_FILES || selected.current.reduce((sum, file) => sum + file.sizeBytes, 0) + reserved.current.bytes + size > limit) throw new Error("Selected local files exceed this saved Worker's test limits. Remove selections or reopen the preview.");
    if (files.some(file => file.size > (saved.executionFileLimits?.singleFileBytes ?? 8 * 1024 ** 2))) throw new Error("A selected file exceeds the effective Worker file limit.");
    reserved.current.count += files.length; reserved.current.bytes += size;
    try {
      const added: SellerTestAsset[] = [];
      for (const file of files) added.push(await sellerTestAsset(file));
      selected.current = [...selected.current, ...added]; setAssets(selected.current);
      return added.map(({ contentBase64: _content, ...asset }) => asset);
    } finally { reserved.current.count -= files.length; reserved.current.bytes -= size; }
  }
  return <div className="preview-pane"><h2>{title || "Untitled capability"}</h2><p className="muted">{summary}</p><div className="checkout-price"><strong>{money(priceMinor)}</strong><span>per job</span></div>
    <ContractForm contract={contract} values={input} onChange={changeInput} assets={assets.map(({ contentBase64: _content, ...asset }) => asset)} selectLocalFiles={selectFiles} uploadsEnabled={pinned} onBusy={setBusy} executionFileLimits={pinned ? saved?.executionFileLimits : undefined} />
    <h3 className="section-title">What you receive</h3><p className="small muted">{contract.output.description}</p>
    <section className="page-section"><h3>Local Worker test</h3><Notice>{pinned ? `This test targets saved version ${saved!.version}. Only files you choose here are included in the downloaded bundle. No purchase is created and files stay in this browser until you run the test on your Worker.` : "Save this exact draft and refresh its manifest hash before exporting a local test. Previewing does not run a job."}</Notice>
      {pinned && <p className="small mono">Version: {saved!.versionId}<br />Manifest: {saved!.manifestHash}</p>}
      <ErrorNotice error={action.error} /><Button disabled={!pinned || busy} busy={action.pending} onClick={() => void action.run(async () => { if (!saved || !pinned) return; const bundle = sellerTestBundle(saved, input, assets); downloadJson(bundle, `kivro-${saved.slug}-v${saved.version}-test.json`); })}><Download size={15} />Export local test bundle</Button>
    </section>
  </div>;
}

"use client";
import React, { useEffect, useState } from "react";
import { Download, ExternalLink, File } from "lucide-react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AssetDTO, JobOutput, OutputContract, OutputField } from "@kivro/contracts";
import { bytes, dateTime } from "../lib/format";
import { extraResultFields, fieldAssets, jobAssetUrl, namedResultFields, resultHref, type AssetUrlResolver } from "../lib/results";

export function ResultAsset({ asset, resolveUrl = jobAssetUrl }: { asset: AssetDTO; resolveUrl?: AssetUrlResolver }): React.ReactElement {
  const url = resolveUrl(asset);
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [url]);
  return <div className="result-asset">{url && !failed && ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(asset.mimeType) && <img src={url} alt={asset.filename} loading="lazy" onError={() => setFailed(true)} />}{url && !failed && ["video/mp4", "video/webm", "video/quicktime"].includes(asset.mimeType) && <video controls preload="metadata" src={url} aria-label={asset.filename} onError={() => setFailed(true)} />}{url && !failed && ["audio/wav", "audio/x-wav", "audio/mpeg", "audio/mp4"].includes(asset.mimeType) && <audio controls preload="metadata" src={url} aria-label={asset.filename} onError={() => setFailed(true)} />}<div className="file-row"><File size={19} /><div><strong>{asset.filename}</strong><small>{asset.mimeType} / {bytes(asset.sizeBytes)}</small></div>{url && <a href={url} download={asset.filename} className="icon-button" aria-label={`Download ${asset.filename}`} title="Download"><Download size={18} /></a>}</div>{failed && <p className="field-error">Preview unavailable. The file may be revoked, expired or unsupported by this browser.</p>}{!url && <p className="small muted">No current published download is available.</p>}{asset.expiresAt && <p className="small muted">Cloud file expires {dateTime(asset.expiresAt)}.</p>}<details><summary>File integrity</summary><p className="small mono">SHA-256: {asset.sha256}</p></details></div>;
}

export function SafeMarkdown({ children, assets = [], resolveUrl = jobAssetUrl }: { children: string; assets?: AssetDTO[]; resolveUrl?: AssetUrlResolver }) {
  return <div className="result-markdown"><Markdown skipHtml remarkPlugins={[remarkGfm]} urlTransform={value => resultHref(value, assets, resolveUrl) || ""} components={{
    a: ({ href, children }) => { const safe = href ? resultHref(href, assets, resolveUrl) : undefined; return safe ? <a href={safe} target={safe.startsWith("#") ? undefined : "_blank"} rel="noopener noreferrer nofollow" className="text-link">{children}</a> : <span>{children}</span>; },
    img: ({ src, alt }) => { const asset = src && assets.find(item => resolveUrl(item) === src && ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(item.mimeType)); return asset ? <img src={resolveUrl(asset)} alt={alt || asset.filename} loading="lazy" /> : <span className="muted small">{alt ? `Image: ${alt}` : "External image omitted"}</span>; },
    h1: ({ children }) => <h3>{children}</h3>, h2: ({ children }) => <h4>{children}</h4>,
    table: ({ children }) => <div className="result-table"><table>{children}</table></div>,
    input: ({ checked }) => <input type="checkbox" checked={Boolean(checked)} readOnly disabled />,
  }}>{children}</Markdown></div>;
}

function NamedValue({ field, value, assets, resolveUrl }: { field: OutputField; value: unknown; assets: AssetDTO[]; resolveUrl: AssetUrlResolver }) {
  if (field.type === "FILE" || field.type === "FILES") {
    const resolved = fieldAssets(value, assets, field.type === "FILES");
    return <>{resolved.assets.map(asset => <ResultAsset key={asset.id} asset={asset} resolveUrl={resolveUrl} />)}{resolved.missing && <p className="field-error">One or more declared result files are unavailable.</p>}</>;
  }
  if (field.type === "MARKDOWN" && typeof value === "string") return <SafeMarkdown assets={assets} resolveUrl={resolveUrl}>{value}</SafeMarkdown>;
  if (field.type === "BOOLEAN" && typeof value === "boolean") return <p>{value ? "Yes" : "No"}</p>;
  if (["INTEGER", "NUMBER"].includes(field.type) && typeof value === "number") return <p className="tabular">{String(value)}</p>;
  if (field.type === "URL" && typeof value === "string") { const href = resultHref(value); return href ? <a className="text-link result-url" href={href} target="_blank" rel="noopener noreferrer nofollow">{value}<ExternalLink size={14} /></a> : <p className="prewrap">{value}</p>; }
  if (field.type === "JSON" || typeof value === "object") return <pre>{JSON.stringify(value, null, 2)}</pre>;
  return <p className="prewrap">{String(value)}</p>;
}

export function JobResult({ output, contract, resolveUrl = jobAssetUrl }: { output: JobOutput; contract?: OutputContract; resolveUrl?: AssetUrlResolver }) {
  const assets = output.assets || [], fields = namedResultFields(output, contract), extra = extraResultFields(output, contract);
  const assignedAssets = new Set(fields.filter(item => ["FILE", "FILES"].includes(item.field.type)).flatMap(item => fieldAssets(item.value, assets, item.field.type === "FILES").assets.map(asset => asset.id)));
  return <div className="result-content">
    {contract?.description && <p className="small muted">{contract.description}</p>}
    {output.text !== undefined && <pre className="result-text">{output.text}</pre>}
    {output.json !== undefined && <pre>{JSON.stringify(output.json, null, 2)}</pre>}
    {fields.map(({ field, value, present }) => <section key={field.key} className="named-result" aria-label={field.label}><h3>{field.label}</h3>{field.description && <p className="small muted">{field.description}</p>}{present ? <NamedValue field={field} value={value} assets={assets} resolveUrl={resolveUrl} /> : <p className={field.required ? "field-error" : "small muted"}>{field.required ? "Required result was not delivered." : "Not supplied."}</p>}</section>)}
    {Object.keys(extra).length > 0 && <details open={!contract}><summary>{contract ? "Additional result fields" : "Result fields / contract unavailable"}</summary><pre>{JSON.stringify(extra, null, 2)}</pre></details>}
    {assets.filter(asset => !assignedAssets.has(asset.id)).map(asset => <ResultAsset key={asset.id} asset={asset} resolveUrl={resolveUrl} />)}
  </div>;
}

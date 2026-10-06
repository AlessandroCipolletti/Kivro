import { describe, expect, it } from "vitest";
import { sellerTestAsset, sellerTestBundle } from "../src/lib/seller-test";
import { defaultWorkerPermissions } from "../src/lib/worker-policy";
import type { IOContract } from "../src/lib/types";

const contract: IOContract = { schemaVersion: 1, inputs: [{ key: "source", label: "Source file", type: "FILE", required: true, order: 0, constraints: { allowedExtensions: [".txt"], allowedMimeTypes: ["text/plain"], maxFileSizeBytes: 1024 } }], output: { type: "TEXT", description: "Result", required: true } };
const saved = { versionId: "b0000000-0000-4000-8000-000000000001", manifestHash: "a".repeat(64), ioContract: contract, permissions: defaultWorkerPermissions() };
describe("explicit pinned local test export", () => {
  it("hashes selected bytes and exports only referenced files with exact saved identity", async () => {
    const chosen = await sellerTestAsset(new File(["Selected bytes"], "chosen.txt", { type: "text/plain" }));
    const unused = await sellerTestAsset(new File(["Private unused bytes"], "unused.txt", { type: "text/plain" }));
    const bundle = sellerTestBundle(saved, { source: chosen.id }, [chosen, unused]);
    expect(bundle.capabilityVersionId).toBe(saved.versionId); expect(bundle.manifestHash).toBe(saved.manifestHash);
    expect(bundle.assets).toEqual([chosen]); expect(atob(chosen.contentBase64)).toBe("Selected bytes");
    expect(JSON.stringify(bundle)).not.toMatch(/Private unused|permission|credential|downloadUrl|path/);
  });
  it("refuses missing frozen hash, missing selected bytes and lowered effective limits", async () => {
    const asset = await sellerTestAsset(new File(["Selected bytes"], "chosen.txt", { type: "text/plain" }));
    expect(() => sellerTestBundle({ ...saved, manifestHash: undefined }, { source: asset.id }, [asset])).toThrow("frozen manifest hash");
    expect(() => sellerTestBundle(saved, { source: asset.id }, [])).toThrow();
    expect(() => sellerTestBundle({ ...saved, executionFileLimits: { singleFileBytes: 4, inputBytes: 1024, outputBytes: 1024 } }, { source: asset.id }, [asset])).toThrow("effective Worker file limit");
    expect(() => sellerTestBundle({ ...saved, executionFileLimits: { singleFileBytes: 1024, inputBytes: 20, outputBytes: 1024 } }, { source: asset.id }, [asset])).toThrow("local test limit");
  });
  it("rejects oversized, unsafe and inconsistent media before export", async () => {
    await expect(sellerTestAsset(new File([new Uint8Array(8 * 1024 ** 2 + 1)], "large.txt", { type: "text/plain" }))).rejects.toThrow("8 MiB");
    await expect(sellerTestAsset(new File(["Text"], "secret..txt", { type: "text/plain" }))).rejects.toThrow("Unsafe filename");
    await expect(sellerTestAsset(new File(["Text"], "source.exe"))).rejects.toThrow("reviewed Worker format");
    await expect(sellerTestAsset(new File(["Text"], "source.txt", { type: "image/png" }))).rejects.toThrow("matching media type");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { finalizeUpload, MAX_DIRECT_UPLOAD_BYTES, stageUpload } from "../src/lib/uploads";

const intent = { id: "f0000000-0000-4000-8000-000000000001", uploadUrl: "http://storage.local/bucket/signed?signature=opaque", method: "PUT", headers: { "content-type": "text/plain" }, expiresAt: new Date(Date.now() + 120_000).toISOString(), uploadUrlExpiresAt: new Date(Date.now() + 60_000).toISOString() };
const asset = { id: intent.id, filename: "source.txt", mimeType: "text/plain", sizeBytes: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
afterEach(() => vi.unstubAllGlobals());
describe("direct browser upload protocol", () => {
  it("hashes the exact file, sends only the signed headers to storage and finalizes separately", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response(intent)).mockResolvedValueOnce(new Response(null, { status: 200 })).mockResolvedValueOnce(response(asset));
    vi.stubGlobal("fetch", fetch);
    const file = new File(["abc"], "source.txt", { type: "text/plain" });
    const phase = vi.fn();
    expect(await stageUpload(file, new AbortController().signal, phase)).toEqual(intent);
    const body = JSON.parse(fetch.mock.calls[0][1].body);
    expect(body).toEqual({ filename: "source.txt", mimeType: "text/plain", sizeBytes: 3, sha256: "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad" });
    expect(fetch.mock.calls[1]).toEqual([intent.uploadUrl, expect.objectContaining({ body: file, method: "PUT", headers: intent.headers, credentials: "omit", redirect: "error", referrerPolicy: "no-referrer" })]);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await finalizeUpload(intent.id)).toEqual(asset);
    expect(fetch.mock.calls[2][0]).toBe(`/api/assets/uploads/${intent.id}/finalize`);
    expect(phase.mock.calls.map(args => args[0])).toEqual(["Calculating file checksum", "Preparing secure upload", "Uploading to storage"]);
  });
  it("keeps storage upload and retryable finalization errors separate", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ error: { code: "UPLOAD_PROCESSING", message: "Still verifying." } }, 409)).mockResolvedValueOnce(response(asset));
    vi.stubGlobal("fetch", fetch);
    await expect(finalizeUpload(intent.id)).rejects.toMatchObject({ code: "UPLOAD_PROCESSING" });
    expect(await finalizeUpload(intent.id)).toEqual(asset);
    expect(fetch.mock.calls.map(args => args[0])).toEqual([`/api/assets/uploads/${intent.id}/finalize`, `/api/assets/uploads/${intent.id}/finalize`]);
  });
  it("rejects an oversized file before allocating a hash buffer or calling the API", async () => {
    const arrayBuffer = vi.fn(), fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    await expect(stageUpload({ size: MAX_DIRECT_UPLOAD_BYTES + 1, arrayBuffer } as unknown as File, new AbortController().signal, vi.fn())).rejects.toThrow("100 MiB");
    expect(arrayBuffer).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
  });
  it("refuses credential headers and never finalizes a failed storage PUT", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ ...intent, headers: { Authorization: "secret" } })); vi.stubGlobal("fetch", fetch);
    const file = new File(["data"], "source.txt", { type: "text/plain" });
    await expect(stageUpload(file, new AbortController().signal, vi.fn())).rejects.toMatchObject({ code: "INVALID_RESPONSE" }); expect(fetch).toHaveBeenCalledTimes(1);
    fetch.mockReset().mockResolvedValueOnce(response(intent)).mockResolvedValueOnce(new Response(null, { status: 403 }));
    await expect(stageUpload(file, new AbortController().signal, vi.fn())).rejects.toThrow("Storage upload failed (403)"); expect(fetch).toHaveBeenCalledTimes(2);
  });
  it("rejects an expired signed URL even while its finalization ticket remains valid", async () => {
    const fetch = vi.fn().mockResolvedValueOnce(response({ ...intent, uploadUrlExpiresAt: new Date(Date.now() - 1000).toISOString() })); vi.stubGlobal("fetch", fetch);
    await expect(stageUpload(new File(["data"], "source.txt", { type: "text/plain" }), new AbortController().signal, vi.fn())).rejects.toThrow("upload link has expired");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

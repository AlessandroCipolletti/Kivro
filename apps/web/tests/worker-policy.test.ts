import { describe, expect, it } from "vitest";
import { assertWorkerPermissions } from "../../../packages/openclaw-adapter/src/policy";
import { SUPPORTED_EXECUTION_TOOLS, WORKER_FILE_FORMATS, type IOContract } from "@kivro/contracts";
import { defaultWorkerPermissions, filePresets, workerCompatibilityIssues, WORKER_BYTE_LIMIT } from "../src/lib/worker-policy";

describe("worker-compatible seller configuration", () => {
  const permissions = () => { const p = defaultWorkerPermissions(); p.inference.model = "seller-model"; return p; };
  const fileContract = (preset = filePresets.Documents): IOContract => ({
    schemaVersion: 1,
    inputs: [{ key: "source", label: "Source", type: "FILE", required: true, order: 0, constraints: { ...preset, maxFiles: 1, maxFileSizeBytes: WORKER_BYTE_LIMIT } }],
    output: { type: "FILES", description: "Result files", required: true,
      files: { ...preset, maxFiles: 1, maxTotalSizeBytes: WORKER_BYTE_LIMIT },
      fields: [{ key: "result", label: "Result", type: "FILE", required: true, order: 0, constraints: { ...preset, maxFiles: 1, maxFileSizeBytes: WORKER_BYTE_LIMIT } }] },
  });
  it("uses defaults accepted by the actual adapter", () => {
    expect(() => assertWorkerPermissions(permissions())).not.toThrow();
    expect(workerCompatibilityIssues(permissions())).toEqual([]);
    expect(permissions().limits.maxInputBytes).toBe(WORKER_BYTE_LIMIT);
  });
  it("accepts reviewed native Anthropic without inventing a production model", () => {
    expect(defaultWorkerPermissions().inference.model).toBe("");
    const p = permissions(); p.inference.provider = "anthropic";
    expect(workerCompatibilityIssues(p)).toEqual([]);
    expect(() => assertWorkerPermissions(p)).not.toThrow();
    p.inference.provider = "unreviewed-native";
    expect(workerCompatibilityIssues(p).join(" ")).toContain("inference transports");
    expect(() => assertWorkerPermissions(p)).toThrow();
  });
  it("surfaces unsupported resource and legacy execution bounds", () => {
    const p = permissions(); p.limits.memoryMb = 512; p.limits.maxInputBytes = 25 * 1024 ** 2;
    p.resources = [{ id: "old-resource", type: "PRIVATE_API", access: "READ_ONLY" }];
    expect(workerCompatibilityIssues(p)).toHaveLength(3);
    expect(() => assertWorkerPermissions(p)).toThrow();
  });
  it("accepts the canonical media/resource wrappers and checks network prerequisites", () => {
    expect(SUPPORTED_EXECUTION_TOOLS).toEqual(expect.arrayContaining(["resource.read", "blender.render", "ffmpeg.transcode"]));
    const p = permissions(); p.tools = ["resource.read", "blender.render", "ffmpeg.transcode"];
    expect(workerCompatibilityIssues(p)).toEqual([]);
    expect(() => assertWorkerPermissions(p)).not.toThrow();
    p.tools.push("research.fetch");
    expect(workerCompatibilityIssues(p).join(" ")).toContain("Public research broker");
  });
  it("catches input/output file restrictions exceeding the worker limit", () => {
    const p = permissions();
    expect(workerCompatibilityIssues(p, { schemaVersion: 1, inputs: [{ key: "file", label: "File", type: "FILE", order: 0, required: true, constraints: { ...filePresets.Documents, maxFileSizeBytes: 25 * 1024 ** 2 } }], output: { type: "FILES", description: "Files", required: true, files: { allowedExtensions: [".pdf"], allowedMimeTypes: ["application/pdf"], maxFiles: 1, maxTotalSizeBytes: 100 * 1024 ** 2 } } })).toHaveLength(2);
  });
  it("offers only reviewed worker formats across input and output presets", () => {
    expect(Object.fromEntries(Object.entries(filePresets).map(([name, preset]) => [name, preset.allowedExtensions]))).toEqual({
      Images: [".jpg", ".jpeg", ".png", ".webp"], Video: [".mp4", ".mov", ".webm"], Audio: [".wav", ".mp3", ".m4a"],
      Documents: [".pdf", ".txt", ".md"], Data: [".csv", ".json"], "3D / Blender": [".blend", ".obj", ".fbx"],
    });
    for (const preset of Object.values(filePresets)) {
      expect(preset.allowedMimeTypes).toEqual([...new Set(preset.allowedExtensions.map(extension => WORKER_FILE_FORMATS[extension]))]);
      expect(workerCompatibilityIssues(permissions(), fileContract(preset))).toEqual([]);
    }
  });
  it("blocks unsupported custom input, envelope and named-output formats", () => {
    const contract = fileContract();
    contract.inputs[0].constraints = { allowedExtensions: [".docx"], allowedMimeTypes: ["application/vnd.openxmlformats-officedocument.wordprocessingml.document"] };
    contract.output.files = { ...contract.output.files!, allowedExtensions: [".flac"], allowedMimeTypes: ["audio/flac"] };
    contract.output.fields![0].constraints = { allowedExtensions: [".gif"], allowedMimeTypes: ["image/gif"] };
    expect(workerCompatibilityIssues(permissions(), contract)).toEqual(expect.arrayContaining([
      "Input Source: .docx is unsupported by the current worker.",
      "Output files: .flac is unsupported by the current worker.",
      "Output Result: .gif is unsupported by the current worker.",
    ]));
  });
  it("surfaces shared extension and MIME mismatches in readiness", () => {
    const contract = fileContract();
    contract.inputs[0].constraints = { allowedExtensions: [".pdf"], allowedMimeTypes: ["text/plain"] };
    expect(workerCompatibilityIssues(permissions(), contract)).toEqual([
      "Input Source: .pdf requires application/pdf.",
      "Input Source: text/plain has no supported declared extension.",
    ]);
  });
});

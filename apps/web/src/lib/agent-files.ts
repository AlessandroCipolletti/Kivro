import type { AgentChatResponseDTO, AgentConversationResponseDTO } from "@kivro/contracts/responses";

export type RequiredOutputFile = NonNullable<AgentConversationResponseDTO["messages"][number]["requiredOutputFiles"]>[number];
export interface OutputFileDraft { id: string; extension: string; mimeType: string; count: string }
export type AgentContractMatch = NonNullable<AgentChatResponseDTO["contractMatches"]>[number];
export type ContractMatchIssue = AgentContractMatch["issues"][number];

export function requiredOutputFiles(rows: OutputFileDraft[]): RequiredOutputFile[] | undefined {
  if (!rows.length) return undefined;
  if (rows.length > 20) throw new Error("Request at most 20 output formats.");
  const seen = new Set<string>();
  const files = rows.map((row, index) => {
    const raw = row.extension.trim().toLowerCase(), extension = raw ? raw.startsWith(".") ? raw : `.${raw}` : undefined;
    const mimeType = row.mimeType.trim().toLowerCase() || undefined;
    const count = Number(row.count);
    if (!extension && !mimeType) throw new Error(`Output format ${index + 1}: enter an extension or MIME type.`);
    if (extension && (extension.length > 40 || !/^\.[a-z0-9.]+$/.test(extension))) throw new Error(`Output format ${index + 1}: enter a file extension, such as .pdf.`);
    if (mimeType && (mimeType.length > 150 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(mimeType))) throw new Error(`Output format ${index + 1}: enter a MIME type, such as application/pdf.`);
    if (!Number.isInteger(count) || count < 1 || count > 20) throw new Error(`Output format ${index + 1}: file count must be an integer from 1 to 20.`);
    const selector = `${extension || ""}:${mimeType || ""}`;
    if (seen.has(selector)) throw new Error("Combine duplicate output formats by increasing their file count.");
    seen.add(selector);
    return { ...(extension ? { extension } : {}), ...(mimeType ? { mimeType } : {}), count };
  });
  if (files.reduce((sum, file) => sum + file.count, 0) > 20) throw new Error("Request at most 20 output files in total.");
  return files;
}

const issueText: Record<ContractMatchIssue["code"], string> = {
  INVALID_INPUT: "This input does not meet the contract.", INACTIVE_INPUT: "This input is inactive for the selected options.",
  MISSING_INPUT: "Provide the required input.", FILE_COUNT_REQUIRED: "More input files are required.", FILE_NOT_ACCEPTED: "This file does not meet the input format or size limits.",
  FILE_ASSIGNMENT_IMPOSSIBLE: "The attached files cannot be assigned to this contract.", AMBIGUOUS_FILE_ASSIGNMENT: "Choose which input receives this file.",
  CONDITIONAL_INPUT_UNRESOLVED: "Choose the controlling input before assigning files.", MATCHING_LIMIT: "Automatic matching reached its limit; review the input fields manually.",
  OUTPUT_TYPE_UNSUPPORTED: "The requested output type is not supported.", OUTPUT_FILE_UNSUPPORTED: "The requested output format is not supported.",
  OUTPUT_COUNT_UNSUPPORTED: "The requested output file count exceeds the contract.", OUTPUT_SIZE_UNSUPPORTED: "The requested output size is not supported.",
  OUTPUT_NOT_GUARANTEED: "Allowed formats and maximum counts do not guarantee the requested deliverables.",
};
export function contractIssueText(issue: ContractMatchIssue): string { return issueText[issue.code] || "Review this contract requirement before purchase."; }

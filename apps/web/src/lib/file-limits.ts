import { FILE_SAFETY_CEILINGS, effectiveFileLimit } from "@kivro/contracts/file-limits";
import type { CapabilityDTO, InputField } from "./types";

export function effectiveInputField(field: InputField, limits?: CapabilityDTO["executionFileLimits"]): InputField {
  if (!["FILE", "FILES"].includes(field.type)) return field;
  return { ...field, constraints: { ...field.constraints,
    maxFileSizeBytes: effectiveFileLimit(limits?.singleFileBytes ?? FILE_SAFETY_CEILINGS.workerFileBytes, field.constraints?.maxFileSizeBytes),
    maxTotalSizeBytes: effectiveFileLimit(limits?.inputBytes ?? FILE_SAFETY_CEILINGS.workerInputBytes, field.constraints?.maxTotalSizeBytes),
  } };
}

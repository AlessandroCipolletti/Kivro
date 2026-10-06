export function observedTime(milliseconds: number | null): string {
  if (milliseconds === null) return "No samples";
  const seconds = milliseconds / 1000;
  if (seconds < 60) return `${Number(seconds.toFixed(3))} sec`;
  const minutes = Math.floor(seconds / 60), remainder = Number((seconds % 60).toFixed(3));
  return `${minutes} min${remainder ? ` ${remainder} sec` : ""}`;
}
export function observedCoverage(ratio: number | null): string {
  return ratio === null ? "Not measured" : `${(ratio * 100).toFixed(1)}% observed`;
}

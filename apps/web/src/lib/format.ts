export function money(minor: number | null | undefined) {
  return minor == null ? "Unavailable" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(minor / 100);
}
export function dateTime(value?: string | null) {
  if (!value) return "Not available";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Not available" : new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", timeZoneName: "short" }).format(date);
}
export function duration(seconds: number) {
  if (seconds < 60) return `${Math.round(seconds)} sec`;
  if (seconds < 3600) return `${Math.ceil(seconds / 60)} min`;
  return `${Math.floor(seconds / 3600)} hr ${Math.round((seconds % 3600) / 60)} min`;
}
export function bytes(value: number) { return value >= 1048576 ? `${(value / 1048576).toFixed(1)} MB` : `${Math.ceil(value / 1024)} KB`; }
export function label(value: string) { return value.toLowerCase().split(/[_-]/).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(" "); }
export const terminalStates = new Set(["SUCCEEDED", "FAILED", "CANCELLED", "TIMED_OUT"]);
export function safeAssetUrl(id: string) { return `/api/assets/${encodeURIComponent(id)}/download`; }
export function decimalToMinor(value: string): number | null {
  if (!/^\d+(\.\d{1,2})?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const amount = Number(whole) * 100 + Number(fraction.padEnd(2, "0"));
  return Number.isSafeInteger(amount) ? amount : null;
}

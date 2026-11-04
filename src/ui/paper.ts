// Default paper size: US Letter where it's the norm, A4 everywhere else.
const LETTER_REGIONS = ["US", "CA", "MX", "PH", "CL", "CO", "VE", "GT", "PR", "CR", "PA", "DO", "SV", "NI"];

export function defaultPaper(lang = typeof navigator === "undefined" ? "en-US" : navigator.language): { label: string; size: [number, number] } {
  const region = /[-_]([A-Za-z]{2})\b/.exec(lang)?.[1]?.toUpperCase();
  return region && LETTER_REGIONS.includes(region) ? { label: "Letter", size: [612, 792] } : { label: "A4", size: [595, 842] };
}

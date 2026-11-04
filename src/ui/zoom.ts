// Zoom model. `zoom` 1.0 means "actual size": one PDF inch is one screen inch at 96 DPI.
export const PT_TO_CSS = 96 / 72;
export const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 6, 8];
export const MIN_ZOOM = ZOOM_STEPS[0];
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1];

/** "auto" fits the width but never goes above AUTO_MAX, so wide windows stay comfortable to read. */
export const AUTO_MAX = 1.25;

export type ZoomMode = { kind: "auto" } | { kind: "fit-width" } | { kind: "fit-page" } | { kind: "custom"; zoom: number };

export function stepZoom(current: number, direction: 1 | -1): number {
  if (direction > 0) return ZOOM_STEPS.find((z) => z > current + 1e-6) ?? MAX_ZOOM;
  return [...ZOOM_STEPS].reverse().find((z) => z < current - 1e-6) ?? MIN_ZOOM;
}

export function clampZoom(z: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
}

export function formatZoom(z: number): string {
  return `${Math.round(z * 100)}%`;
}

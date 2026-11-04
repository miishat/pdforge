// Conversions between page space (PDF points, y down, MuPDF bounds) and the rotated, scaled view.
import type { PageSize, Rect, ViewRotation } from "../core/types";

export function rotatedSize(size: PageSize, rotation: ViewRotation): PageSize {
  return rotation % 180 === 0 ? size : { width: size.height, height: size.width };
}

/** Page-space point → view point in points (before scaling), for a page of unrotated `size`. */
export function toView([x, y]: [number, number], size: PageSize, rotation: ViewRotation): [number, number] {
  switch (rotation) {
    case 0:
      return [x, y];
    case 90:
      return [size.height - y, x];
    case 180:
      return [size.width - x, size.height - y];
    case 270:
      return [y, size.width - x];
  }
}

/** View point in points → page-space point. Inverse of toView. */
export function toPage([vx, vy]: [number, number], size: PageSize, rotation: ViewRotation): [number, number] {
  switch (rotation) {
    case 0:
      return [vx, vy];
    case 90:
      return [vy, size.height - vx];
    case 180:
      return [size.width - vx, size.height - vy];
    case 270:
      return [size.width - vy, vx];
  }
}

/** Page-space rect → CSS-pixel rect within the page element. */
export function rectToView(r: Rect, size: PageSize, rotation: ViewRotation, scale: number): Rect {
  const a = toView([r[0], r[1]], size, rotation);
  const b = toView([r[2], r[3]], size, rotation);
  return [Math.min(a[0], b[0]) * scale, Math.min(a[1], b[1]) * scale, Math.max(a[0], b[0]) * scale, Math.max(a[1], b[1]) * scale];
}

export function rotate(r: ViewRotation, by: 90 | -90): ViewRotation {
  return (((r + by) % 360) + 360) % 360 as ViewRotation;
}

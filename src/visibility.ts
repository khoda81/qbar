import type { VisibilityFunction } from "./types.js";

export interface SmoothVisibilityOptions {
  /** Pixel spacing at or below which a tick is fully hidden. */
  hiddenAt?: number;
  /** Pixel spacing at or above which a tick is fully opaque. */
  opaqueAt?: number;
}

export function smoothstep(
  edge0: number,
  edge1: number,
  value: number,
): number {
  if (edge1 <= edge0) {
    return value <= edge0 ? 0 : 1;
  }

  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function smoothVisibility(
  options: SmoothVisibilityOptions = {},
): VisibilityFunction {
  const hiddenAt = options.hiddenAt ?? 24;
  const opaqueAt = options.opaqueAt ?? 64;

  if (
    !Number.isFinite(hiddenAt) ||
    !Number.isFinite(opaqueAt) ||
    hiddenAt < 0 ||
    opaqueAt <= hiddenAt
  ) {
    throw new RangeError(
      "visibility thresholds must be finite and satisfy 0 <= hiddenAt < opaqueAt",
    );
  }

  return (pixelSpacing) => smoothstep(hiddenAt, opaqueAt, pixelSpacing);
}

export const defaultVisibility = smoothVisibility();

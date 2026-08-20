// What a designer asks of a chip offered for one of their designs.
//
// This is the tile's copy of `backend/Requirements.mo`, and it exists so the
// store can tell you an offer will bounce before you spend six hundred million
// cycles finding out. The peer's answer is still the authority: it runs the same
// arithmetic over the art we actually send it. Both sides must agree, so any
// change here belongs in that file too.
//
// A chip's palette is not the measure of its colors. A palette may declare
// sixty-four entries and paint three of them, and two entries may hold the same
// color, so colors are counted over the pixels the way an eye would count
// them.

import { MAX_PALETTE } from "./palette.ts";

export type NsfwRule = "any" | "disallowed" | "required";

export type TradeRequirements = {
  /** Hold a qualifying offer for the designer rather than completing it. */
  approval: boolean;
  minColors: number | null;
  /** Percent of the offered chip one color may cover, at most. */
  maxCoverage: number | null;
  nsfw: NsfwRule;
};

export const MIN_COLORS_FLOOR = 2;
export const MIN_COLORS_CEILING = MAX_PALETTE;
export const MAX_COVERAGE_FLOOR = 1;
export const MAX_COVERAGE_CEILING = 99;

export type Metrics = {
  /** Distinct colors the art actually paints. */
  colors: number;
  /** Pixels held by the single most-used color. */
  topColorPixels: number;
  totalPixels: number;
};

/** A design nobody has to satisfy. */
export function openRequirements(): TradeRequirements {
  return { approval: false, minColors: null, maxCoverage: null, nsfw: "any" };
}

/** True when a design asks for nothing at all and swaps freely. */
export function isOpen(requirements: TradeRequirements): boolean {
  return (
    !requirements.approval &&
    requirements.minColors === null &&
    requirements.maxCoverage === null &&
    requirements.nsfw === "any"
  );
}

/** True when a design refuses offers on their artwork, approval aside. */
export function isRestrictive(requirements: TradeRequirements): boolean {
  return (
    requirements.minColors !== null ||
    requirements.maxCoverage !== null ||
    requirements.nsfw !== "any"
  );
}

export function measure(pixels: Uint8Array, palette: string[]): Metrics {
  const counts = new Map<string, number>();
  let total = 0;
  for (const index of pixels) {
    const color = palette[index];
    // Validated art never indexes past its palette; a stray index is left
    // uncounted rather than counted as a color that is not there.
    if (color === undefined) continue;
    counts.set(color, (counts.get(color) ?? 0) + 1);
    total += 1;
  }
  let top = 0;
  for (const count of counts.values()) if (count > top) top = count;
  return { colors: counts.size, topColorPixels: top, totalPixels: total };
}

export type FailureCode =
  | "min_colors"
  | "max_coverage"
  | "nsfw_disallowed"
  | "nsfw_required";

/**
 * The reason an offer fails, or null when it satisfies every requirement.
 * `approval` is not consulted: it decides what happens to an offer that already
 * qualifies, not whether it qualifies.
 */
export function check(
  requirements: TradeRequirements,
  offered: Metrics,
  offeredNsfw: boolean,
): FailureCode | null {
  if (requirements.minColors !== null && offered.colors < requirements.minColors) {
    return "min_colors";
  }
  if (requirements.maxCoverage !== null) {
    // Cross-multiplied so no rounding decides a trade: 303 of 757 pixels is
    // over 40% and fails a 40% cap, however the tile chooses to print it.
    if (offered.topColorPixels * 100 > requirements.maxCoverage * offered.totalPixels) {
      return "max_coverage";
    }
  }
  if (requirements.nsfw === "disallowed" && offeredNsfw) return "nsfw_disallowed";
  if (requirements.nsfw === "required" && !offeredNsfw) return "nsfw_required";
  return null;
}

/**
 * Whether a requirement set is one a designer could have meant. A minimum of one
 * color and a cap of a hundred percent are satisfied by every chip that exists,
 * so they are refused rather than stored as restrictions that do not restrict.
 */
export function valid(requirements: TradeRequirements): boolean {
  if (requirements.minColors !== null) {
    if (!Number.isInteger(requirements.minColors)) return false;
    if (
      requirements.minColors < MIN_COLORS_FLOOR ||
      requirements.minColors > MIN_COLORS_CEILING
    ) {
      return false;
    }
  }
  if (requirements.maxCoverage !== null) {
    if (!Number.isInteger(requirements.maxCoverage)) return false;
    if (
      requirements.maxCoverage < MAX_COVERAGE_FLOOR ||
      requirements.maxCoverage > MAX_COVERAGE_CEILING
    ) {
      return false;
    }
  }
  return true;
}

/** The requirements as a reader would list them, most concrete first. */
export function describe(requirements: TradeRequirements): string[] {
  const parts: string[] = [];
  if (requirements.minColors !== null) {
    parts.push(`${requirements.minColors} colors or more`);
  }
  if (requirements.maxCoverage !== null) {
    parts.push(`no color over ${requirements.maxCoverage}%`);
  }
  if (requirements.nsfw === "disallowed") parts.push("nothing tagged NSFW");
  if (requirements.nsfw === "required") parts.push("NSFW chips only");
  if (requirements.approval) parts.push("designer approves");
  return parts;
}

/** Why this particular chip was refused, phrased about the chip. */
export function failureMessage(code: FailureCode): string {
  switch (code) {
    case "min_colors":
      return "uses too few colors";
    case "max_coverage":
      return "has one color covering too much of it";
    case "nsfw_disallowed":
      return "is tagged NSFW";
    case "nsfw_required":
      return "is not tagged NSFW";
  }
}

/** The measured coverage as a percentage, for display rather than for judging. */
export function coveragePercent(metrics: Metrics): number {
  if (metrics.totalPixels === 0) return 0;
  return Math.round((metrics.topColorPixels * 100) / metrics.totalPixels);
}

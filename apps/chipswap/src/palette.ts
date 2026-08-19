// Palette colours. The wire form is exactly "#rrggbb" in lowercase, which is
// what the backend validates, so anything else is rejected rather than guessed.

export const MAX_PALETTE = 64;

export type Rgb = { r: number; g: number; b: number };

const HEX_COLOR = /^#[0-9a-f]{6}$/;

export function isHexColor(value: string): boolean {
  return HEX_COLOR.test(value);
}

export function parseHexColor(value: string): Rgb {
  if (!isHexColor(value)) {
    throw new Error(`Expected a lowercase #rrggbb colour, received "${value}"`);
  }
  return {
    r: Number.parseInt(value.slice(1, 3), 16),
    g: Number.parseInt(value.slice(3, 5), 16),
    b: Number.parseInt(value.slice(5, 7), 16),
  };
}

export function formatHexColor(rgb: Rgb): string {
  const channel = (value: number) =>
    Math.max(0, Math.min(255, Math.round(value)))
      .toString(16)
      .padStart(2, "0");
  return `#${channel(rgb.r)}${channel(rgb.g)}${channel(rgb.b)}`;
}

/** Linear blend; the ratio clamps so a slider can never invent a colour. */
export function blendColors(left: string, right: string, ratio: number): string {
  const from = parseHexColor(left);
  const to = parseHexColor(right);
  const t = Math.max(0, Math.min(1, ratio));
  return formatHexColor({
    r: from.r + (to.r - from.r) * t,
    g: from.g + (to.g - from.g) * t,
    b: from.b + (to.b - from.b) * t,
  });
}

/** Readable foreground for a swatch, so labels stay legible on any colour. */
export function contrastColor(value: string): string {
  const { r, g, b } = parseHexColor(value);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.55 ? "#0e141a" : "#f2f5f7";
}

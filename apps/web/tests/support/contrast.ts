function channels(color: string): number[] {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (hex) {
    const value = hex[1].length === 3 ? [...hex[1]].map(character => character.repeat(2)).join("") : hex[1];
    return [0, 2, 4].map(offset => Number.parseInt(value.slice(offset, offset + 2), 16));
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)(?:\s*,\s*([\d.]+))?\s*\)$/.exec(color.trim());
  if (!rgb || rgb[4] !== undefined && Number(rgb[4]) !== 1) throw new Error(`Expected an opaque sRGB color: ${color}`);
  return rgb.slice(1, 4).map(Number);
}

function luminance(color: string): number {
  const [red, green, blue] = channels(color).map(channel => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return red * 0.2126 + green * 0.7152 + blue * 0.0722;
}

export function contrastRatio(foreground: string, background: string): number {
  const first = luminance(foreground), second = luminance(background);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

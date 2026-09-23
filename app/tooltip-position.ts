/** Place the card toward the canvas center from the pointer, keeping an edge margin. */
export function tooltipPosition(
  x: number,
  y: number,
  width: number,
  height: number,
  cardWidth: number,
  cardHeight: number,
) {
  const left = x < width / 2 ? x + 16 : x - cardWidth - 16;
  const top = y < height / 2 ? y + 16 : y - cardHeight - 16;
  return {
    left: Math.max(8, Math.min(left, width - cardWidth - 8)),
    top: Math.max(8, Math.min(top, height - cardHeight - 8)),
  };
}

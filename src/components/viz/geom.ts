/** Points for a triangular arrowhead whose tip is at (x2, y2). */
export function arrowHead(x1: number, y1: number, x2: number, y2: number, size = 8): string {
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const corner = (a: number) =>
    `${(x2 - size * Math.cos(a)).toFixed(1)},${(y2 - size * Math.sin(a)).toFixed(1)}`;
  return `${x2},${y2} ${corner(angle - 0.4)} ${corner(angle + 0.4)}`;
}

/** Lets a diagram shrink to 70% of its natural width on narrow screens before it scrolls. */
export function fit(width: number): string {
  return `width:clamp(${Math.round(width * 0.7)}px,100%,${width}px);height:auto`;
}

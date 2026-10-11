// Geometry shared by the static <Graph> and the interactive <GraphDemo>.

export type Name = string | number;
export type Edge = [Name, Name, Name?];

const UNIT = 84;
const R = 19;
const PAD = 14;

export function layoutGraph(
  nodes: Record<string, [number, number]>,
  edges: Edge[],
  directed: boolean,
  /** Extra room above the graph, for labels over the top row. */
  top = 0,
) {
  // Long names get a wider pill; short ones stay circular.
  const half = (name: string) => Math.max(R, name.length * 4.5 + 10);
  const left = PAD + Math.max(...Object.keys(nodes).map(half));
  const points = Object.fromEntries(
    Object.entries(nodes).map(([name, [col, row]]) => [
      name,
      { name, x: left + col * UNIT, y: PAD + top + R + row * UNIT, hw: half(name), r: R },
    ]),
  );
  const all = Object.values(points);
  const width = Math.max(...all.map((p) => p.x + p.hw)) + PAD;
  const height = Math.max(...all.map((p) => p.y)) + R + PAD;

  const lines = edges.map(([from, to, weight]) => {
    const a = points[String(from)];
    const b = points[String(to)];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const ux = (b.x - a.x) / length;
    const uy = (b.y - a.y) / length;
    // Distance from a node's centre to its outline along this direction.
    const edge = (hw: number) => Math.min(hw / Math.abs(ux || 1e-9), R / Math.abs(uy || 1e-9));
    const tip = { x: b.x - ux * (edge(b.hw) + 2), y: b.y - uy * (edge(b.hw) + 2) };
    return {
      from: String(from),
      to: String(to),
      x1: a.x + ux * edge(a.hw),
      y1: a.y + uy * edge(a.hw),
      // Stop the line short of the arrowhead so the tip stays sharp.
      x2: directed ? tip.x - ux * 6 : b.x - ux * edge(b.hw),
      y2: directed ? tip.y - uy * 6 : b.y - uy * edge(b.hw),
      tip,
      weight,
      // Sit the weight just off the midpoint, on the line's normal.
      wx: (a.x + b.x) / 2 - uy * 11,
      wy: (a.y + b.y) / 2 + ux * 11,
    };
  });

  return { points: all, lines, width, height };
}

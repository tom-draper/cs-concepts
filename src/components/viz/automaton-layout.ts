// Geometry for state diagrams: circles for states, a double ring for accepting
// ones, an arrow into the start state, loops and bowed arrows.
import type { Machine } from '../../lib/theory';
import { arrowHead } from './geom';

const UNIT = 96;
const R = 21;
const PAD = 12;

export function layoutAutomaton(machine: Machine) {
  const points = Object.fromEntries(
    Object.entries(machine.states).map(([name, [col, row]]) => [
      name,
      { name, x: col * UNIT, y: row * UNIT, r: R, accept: machine.accept.includes(name) },
    ]),
  );
  const pair = (from: string, to: string) =>
    machine.edges.some(([a, b]) => a === to && b === from);
  const n = (v: number) => v.toFixed(1);

  const arrows = machine.edges.map(([from, to, label, bend]) => {
    const a = points[from];
    const b = points[to];
    if (from === to) {
      // A loop over the top of the state.
      const dx = R * 0.47;
      const dy = R * 0.88;
      const tip = { x: a.x + dx + 1, y: a.y - dy - 2 };
      const control = { x: a.x + 27, y: a.y - R - 36 };
      const back = Math.hypot(tip.x - control.x, tip.y - control.y);
      const end = {
        x: tip.x + ((control.x - tip.x) / back) * 6,
        y: tip.y + ((control.y - tip.y) / back) * 6,
      };
      return {
        from,
        to,
        label,
        d: `M${n(a.x - dx)} ${n(a.y - dy)}C${n(a.x - 27)} ${n(control.y)} ${n(control.x)} ${n(control.y)} ${n(end.x)} ${n(end.y)}`,
        head: arrowHead(control.x, control.y, tip.x, tip.y, 9),
        lx: a.x,
        ly: a.y - R - 38,
      };
    }
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    const ux = (b.x - a.x) / length;
    const uy = (b.y - a.y) / length;
    // Two states joined both ways get a bow each, so the arrows do not overlap.
    const bow = bend ?? (pair(from, to) ? 15 : 0);
    const midX = (a.x + b.x) / 2;
    const midY = (a.y + b.y) / 2;
    const control = { x: midX + uy * bow * 2, y: midY - ux * bow * 2 };
    const toward = (p: { x: number; y: number }, distance: number) => {
      const d = Math.hypot(control.x - p.x, control.y - p.y);
      return { x: p.x + ((control.x - p.x) / d) * distance, y: p.y + ((control.y - p.y) / d) * distance };
    };
    const start = toward(a, R);
    const tip = toward(b, R + 2);
    const end = toward(b, R + 8);
    return {
      from,
      to,
      label,
      d: `M${n(start.x)} ${n(start.y)}Q${n(control.x)} ${n(control.y)} ${n(end.x)} ${n(end.y)}`,
      head: arrowHead(control.x, control.y, tip.x, tip.y, 9),
      // Sit the label just outside the middle of the curve.
      lx: (start.x + end.x) / 4 + control.x / 2 + uy * 11,
      ly: (start.y + end.y) / 4 + control.y / 2 - ux * 11,
    };
  });

  const first = points[machine.start];
  const entry = { x1: first.x - R - 30, x2: first.x - R - 8, y: first.y, head: arrowHead(first.x - R - 30, first.y, first.x - R - 2, first.y, 9) };

  const all = Object.values(points);
  const xs = [entry.x1, ...all.flatMap((p) => [p.x - R, p.x + R]), ...arrows.flatMap((a) => [a.lx - a.label.length * 4, a.lx + a.label.length * 4])];
  const ys = [...all.flatMap((p) => [p.y - R, p.y + R]), ...arrows.flatMap((a) => [a.ly - 9, a.ly + 9])];
  const minX = Math.min(...xs) - PAD;
  const minY = Math.min(...ys) - PAD;
  const width = Math.max(...xs) + PAD - minX;
  const height = Math.max(...ys) + PAD - minY;

  return { points: all, arrows, entry, width, height, viewBox: `${n(minX)} ${n(minY)} ${n(width)} ${n(height)}` };
}

// Shortest-path search on a grid of open cells and walls, for <GridSearch>.

export interface GridResult {
  /** Cells taken off the frontier, as indices `row * cols + col`. */
  explored: number[];
  /** The route found, start to goal, or empty if there is none. */
  path: number[];
}

/**
 * Searches from start to goal moving up, down, left or right. With `heuristic`
 * false this is Dijkstra's algorithm (plain breadth-first search here, as every
 * step costs 1); with it true it is A* using the Manhattan distance.
 */
export function gridSearch(
  cols: number,
  rows: number,
  walls: Set<number>,
  start: number,
  goal: number,
  heuristic: boolean,
): GridResult {
  const estimate = (cell: number) =>
    heuristic
      ? Math.abs((cell % cols) - (goal % cols)) + Math.abs(Math.floor(cell / cols) - Math.floor(goal / cols))
      : 0;
  const cost = new Map([[start, 0]]);
  const from = new Map<number, number>();
  const open = [start];
  const closed = new Set<number>();
  const explored: number[] = [];

  while (open.length) {
    // Lowest cost-so-far plus estimate first; among ties, the cell nearest the goal.
    let best = 0;
    for (let i = 1; i < open.length; i++) {
      const a = cost.get(open[i])! + estimate(open[i]);
      const b = cost.get(open[best])! + estimate(open[best]);
      if (a < b || (a === b && estimate(open[i]) < estimate(open[best]))) best = i;
    }
    const cell = open.splice(best, 1)[0];
    if (closed.has(cell)) continue;
    closed.add(cell);
    explored.push(cell);
    if (cell === goal) {
      const path = [goal];
      while (path[0] !== start) path.unshift(from.get(path[0])!);
      return { explored, path };
    }
    const col = cell % cols;
    const neighbours = [
      col > 0 ? cell - 1 : -1,
      col < cols - 1 ? cell + 1 : -1,
      cell - cols,
      cell + cols,
    ];
    for (const next of neighbours) {
      if (next < 0 || next >= cols * rows || walls.has(next) || closed.has(next)) continue;
      const through = cost.get(cell)! + 1;
      if (through < (cost.get(next) ?? Infinity)) {
        cost.set(next, through);
        from.set(next, cell);
        open.push(next);
      }
    }
  }
  return { explored, path: [] };
}

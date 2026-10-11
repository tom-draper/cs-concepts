// Runs a graph algorithm and records each step, for <GraphDemo>.

export type GraphAlgorithm =
  | 'bfs'
  | 'dfs'
  | 'dijkstra'
  | 'topo'
  | 'bellman-ford'
  | 'kruskal'
  | 'prim';

export interface GraphSpec {
  nodes: string[];
  edges: [string, string, number?][];
  directed: boolean;
}

export interface GraphStep {
  /** The vertex being processed right now. */
  current?: string;
  /** Vertices that are finished. */
  done: string[];
  /** Vertices discovered and waiting. */
  frontier: string[];
  /** Edges the algorithm has chosen. */
  tree: [string, string][];
  /** Edges that no longer matter. */
  gone: [string, string][];
  /** The edge being examined right now. */
  active?: [string, string];
  /** Text shown above each vertex. */
  labels: Record<string, string>;
  note: string;
  panels: [label: string, value: string][];
}

type Adjacency = Map<string, { to: string; weight: number }[]>;

function adjacency({ nodes, edges, directed }: GraphSpec): Adjacency {
  const adj: Adjacency = new Map(nodes.map((n) => [n, []]));
  for (const [from, to, weight = 1] of edges) {
    adj.get(from)!.push({ to, weight });
    if (!directed) adj.get(to)!.push({ to: from, weight });
  }
  // Visit neighbours in a fixed order so the walkthrough is predictable.
  for (const list of adj.values()) list.sort((a, b) => nodes.indexOf(a.to) - nodes.indexOf(b.to));
  return adj;
}

const list = (names: string[]) =>
  names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
const row = (names: string[]) => names.join('  ') || 'empty';

function bfs(spec: GraphSpec, start: string): GraphStep[] {
  const adj = adjacency(spec);
  const steps: GraphStep[] = [];
  const distance = new Map([[start, 0]]);
  const queue = [start];
  const done: string[] = [];
  const tree: [string, string][] = [];
  const snap = (note: string, current?: string) =>
    steps.push({
      current,
      done: [...done],
      frontier: [...queue],
      tree: [...tree],
      gone: [],
      labels: Object.fromEntries([...distance].map(([n, d]) => [n, String(d)])),
      note,
      panels: [
        ['Queue', row(queue)],
        ['Visited', row(done)],
      ],
    });

  snap(`Start at ${start}: mark it as seen and put it in the queue. The numbers count edges from the start.`);
  while (queue.length) {
    const u = queue.shift()!;
    const fresh = adj.get(u)!.map((e) => e.to).filter((v) => !distance.has(v));
    for (const v of fresh) {
      distance.set(v, distance.get(u)! + 1);
      queue.push(v);
      tree.push([u, v]);
    }
    done.push(u);
    snap(
      `Take ${u} from the front of the queue. ` +
        (fresh.length
          ? `Its unseen neighbour${fresh.length > 1 ? 's' : ''} ${list(fresh)} join${fresh.length > 1 ? '' : 's'} the back.`
          : 'All of its neighbours have been seen already.'),
      u,
    );
  }
  snap('The queue is empty. Every reachable vertex has been visited, nearest first.');
  return steps;
}

function dfs(spec: GraphSpec, start: string): GraphStep[] {
  const adj = adjacency(spec);
  const steps: GraphStep[] = [];
  const order: string[] = [];
  const path: string[] = [];
  const done: string[] = [];
  const tree: [string, string][] = [];
  const snap = (note: string, current?: string) =>
    steps.push({
      current,
      done: [...done],
      frontier: path.filter((n) => n !== current),
      tree: [...tree],
      gone: [],
      labels: Object.fromEntries(order.map((n, i) => [n, String(i + 1)])),
      note,
      panels: [
        ['Path', path.join(' → ') || 'empty'],
        ['Visited', row(order)],
      ],
    });

  const visit = (u: string, parent?: string) => {
    order.push(u);
    path.push(u);
    snap(
      parent
        ? `Go deeper, from ${parent} to ${u}.` +
          (order.length === 2 ? ' The numbers show the order of first visits.' : '')
        : `Start at ${u}.`,
      u,
    );
    for (const { to } of adj.get(u)!) {
      if (order.includes(to)) continue;
      tree.push([u, to]);
      visit(to, u);
    }
    path.pop();
    done.push(u);
    snap(
      `${u} has no unvisited neighbours left. ` +
        (parent ? `Back up to ${parent}.` : 'That was the start, so the search is over.'),
      parent,
    );
  };
  visit(start);
  return steps;
}

function dijkstra(spec: GraphSpec, start: string): GraphStep[] {
  const adj = adjacency(spec);
  const steps: GraphStep[] = [];
  const dist = new Map(spec.nodes.map((n) => [n, n === start ? 0 : Infinity]));
  const prev = new Map<string, string>();
  const done: string[] = [];
  const snap = (note: string, current?: string) =>
    steps.push({
      current,
      done: [...done],
      frontier: spec.nodes.filter((n) => dist.get(n)! < Infinity && !done.includes(n) && n !== current),
      tree: [...prev].map(([to, from]) => [from, to]),
      gone: [],
      labels: Object.fromEntries([...dist].map(([n, d]) => [n, d === Infinity ? '∞' : String(d)])),
      note,
      panels: [['Settled', row(done)]],
    });

  snap(`Every vertex starts at ∞, meaning "no route known", except ${start}, which is 0 from itself.`);
  for (;;) {
    const open = spec.nodes.filter((n) => !done.includes(n) && dist.get(n)! < Infinity);
    if (!open.length) break;
    const u = open.reduce((best, n) => (dist.get(n)! < dist.get(best)! ? n : best));
    const changes: string[] = [];
    for (const { to, weight } of adj.get(u)!) {
      if (done.includes(to)) continue;
      const through = dist.get(u)! + weight;
      if (through < dist.get(to)!) {
        changes.push(
          dist.get(to) === Infinity
            ? `${to} is reached at ${through}`
            : `${to} improves from ${dist.get(to)} to ${through}`,
        );
        dist.set(to, through);
        prev.set(to, u);
      }
    }
    done.push(u);
    snap(
      `Settle ${u} at ${dist.get(u)}: it is the closest unsettled vertex, so no shorter route to it can exist. ` +
        (changes.length ? `Through ${u}, ${changes.join('; ')}.` : `Nothing improves through ${u}.`),
      u,
    );
  }
  snap('Every reachable vertex is settled. The highlighted edges are the shortest routes from the start.');
  return steps;
}

function topo(spec: GraphSpec): GraphStep[] {
  const adj = adjacency(spec);
  const steps: GraphStep[] = [];
  const waiting = new Map(spec.nodes.map((n) => [n, 0]));
  for (const [, to] of spec.edges) waiting.set(to, waiting.get(to)! + 1);
  const ready = spec.nodes.filter((n) => waiting.get(n) === 0);
  const order: string[] = [];
  const gone: [string, string][] = [];
  const snap = (note: string, current?: string) =>
    steps.push({
      current,
      done: [...order],
      frontier: [...ready],
      tree: [],
      gone: [...gone],
      labels: Object.fromEntries(
        spec.nodes.filter((n) => !order.includes(n)).map((n) => [n, String(waiting.get(n))]),
      ),
      note,
      panels: [
        ['Ready', row(ready)],
        ['Order', order.join(' → ') || 'empty'],
      ],
    });

  snap(`Count the arrows pointing into each vertex. Those with a count of 0 depend on nothing and are ready: ${list(ready)}.`);
  while (ready.length) {
    const u = ready.shift()!;
    order.push(u);
    const freed: string[] = [];
    for (const { to } of adj.get(u)!) {
      gone.push([u, to]);
      waiting.set(to, waiting.get(to)! - 1);
      if (waiting.get(to) === 0) {
        ready.push(to);
        freed.push(to);
      }
    }
    snap(
      `Output ${u} and remove its outgoing arrows. ` +
        (freed.length ? `That frees ${list(freed)}.` : 'Nothing new becomes ready.'),
      u,
    );
  }
  snap(
    order.length === spec.nodes.length
      ? 'Every vertex has been output. In this order, every arrow points forwards.'
      : 'Some vertices never became ready, so the graph contains a cycle and has no valid order.',
  );
  return steps;
}

function bellmanFord(spec: GraphSpec, start: string): GraphStep[] {
  const steps: GraphStep[] = [];
  const dist = new Map(spec.nodes.map((n) => [n, n === start ? 0 : Infinity]));
  const prev = new Map<string, string>();
  const show = (d: number) => (d === Infinity ? '∞' : String(d));
  let round = 0;
  const snap = (note: string, active?: [string, string]) =>
    steps.push({
      current: active?.[1],
      done: [],
      frontier: spec.nodes.filter((n) => dist.get(n)! < Infinity && n !== active?.[1]),
      tree: [...prev].map(([to, from]) => [from, to]),
      gone: [],
      active,
      labels: Object.fromEntries([...dist].map(([n, d]) => [n, show(d)])),
      note,
      panels: [['Round', round ? `${round} of at most ${spec.nodes.length - 1}` : 'not started']],
    });
  const relaxAll = (record: boolean) => {
    let changed = false;
    for (const [from, to, weight = 1] of spec.edges) {
      const through = dist.get(from)! + weight;
      if (through < dist.get(to)!) {
        changed = true;
        if (!record) return true;
        const before = dist.get(to)!;
        dist.set(to, through);
        prev.set(to, from);
        snap(
          `Edge ${from} → ${to}: ${show(dist.get(from)!)} + ${weight < 0 ? `(${weight})` : weight} = ${through}, ` +
            (before === Infinity ? `the first route to ${to}.` : `better than ${before}. Update ${to}.`),
          [from, to],
        );
      }
    }
    return changed;
  };

  snap(`Every vertex starts at ∞ except ${start}. Each round tries every edge once, in a fixed order.`);
  for (round = 1; round < spec.nodes.length; round++) {
    if (!relaxAll(true)) {
      snap(`Round ${round}: no edge improved anything, so the distances are final. Stop early.`);
      return steps;
    }
    snap(`End of round ${round}.`);
  }
  round = spec.nodes.length - 1;
  snap(
    relaxAll(false)
      ? 'An edge can still improve a distance after the last round. The graph has a negative cycle, so no shortest paths exist.'
      : 'All rounds are done. The distances are final.',
  );
  return steps;
}

function kruskal(spec: GraphSpec): GraphStep[] {
  const steps: GraphStep[] = [];
  const group = new Map(spec.nodes.map((n) => [n, n]));
  const find = (n: string): string => (group.get(n) === n ? n : find(group.get(n)!));
  const tree: [string, string][] = [];
  const gone: [string, string][] = [];
  let total = 0;
  const snap = (note: string, active?: [string, string]) =>
    steps.push({
      done: spec.nodes.filter((n) => tree.some(([a, b]) => a === n || b === n)),
      frontier: [],
      tree: [...tree],
      gone: [...gone],
      active,
      labels: {},
      note,
      panels: [
        ['Edges chosen', `${tree.length} of ${spec.nodes.length - 1}`],
        ['Total weight', String(total)],
      ],
    });

  const sorted = [...spec.edges].sort((a, b) => (a[2] ?? 1) - (b[2] ?? 1));
  snap('Sort the edges by weight. Consider them from cheapest to most expensive.');
  for (const [a, b, weight = 1] of sorted) {
    if (tree.length === spec.nodes.length - 1) {
      gone.push([a, b]);
      continue;
    }
    if (find(a) === find(b)) {
      gone.push([a, b]);
      snap(`${a}–${b} (weight ${weight}): ${a} and ${b} are already connected, so this edge would make a cycle. Skip it.`, [a, b]);
    } else {
      group.set(find(a), find(b));
      tree.push([a, b]);
      total += weight;
      snap(`${a}–${b} (weight ${weight}): joins two separate groups. Take it.`, [a, b]);
    }
  }
  snap(`${tree.length} edges connect all ${spec.nodes.length} vertices. The minimum spanning tree has total weight ${total}.`);
  return steps;
}

function prim(spec: GraphSpec, start: string): GraphStep[] {
  const adj = adjacency(spec);
  const steps: GraphStep[] = [];
  const inside = [start];
  const tree: [string, string][] = [];
  let total = 0;
  const border = () =>
    spec.nodes.filter((n) => !inside.includes(n) && adj.get(n)!.some((e) => inside.includes(e.to)));
  const snap = (note: string, current?: string, active?: [string, string]) =>
    steps.push({
      current,
      done: inside.filter((n) => n !== current),
      frontier: border(),
      tree: [...tree],
      gone: [],
      active,
      labels: {},
      note,
      panels: [
        ['In the tree', row(inside)],
        ['Total weight', String(total)],
      ],
    });

  snap(`Start with just ${start} in the tree.`, start);
  while (inside.length < spec.nodes.length) {
    let best: { from: string; to: string; weight: number } | undefined;
    for (const from of inside) {
      for (const { to, weight } of adj.get(from)!) {
        if (!inside.includes(to) && (!best || weight < best.weight)) best = { from, to, weight };
      }
    }
    if (!best) break;
    inside.push(best.to);
    tree.push([best.from, best.to]);
    total += best.weight;
    snap(
      `The cheapest edge leaving the tree is ${best.from}–${best.to} (weight ${best.weight}). Add ${best.to}.`,
      best.to,
      [best.from, best.to],
    );
  }
  snap(`Every vertex is in the tree. Its total weight is ${total}.`);
  return steps;
}

export function traceGraph(algorithm: GraphAlgorithm, spec: GraphSpec, start: string): GraphStep[] {
  if (algorithm === 'bfs') return bfs(spec, start);
  if (algorithm === 'dfs') return dfs(spec, start);
  if (algorithm === 'dijkstra') return dijkstra(spec, start);
  if (algorithm === 'bellman-ford') return bellmanFord(spec, start);
  if (algorithm === 'kruskal') return kruskal(spec);
  if (algorithm === 'prim') return prim(spec, start);
  return topo(spec);
}

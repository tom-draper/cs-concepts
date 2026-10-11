// Runs a graph algorithm and records each step, for <GraphDemo>.

export type GraphAlgorithm = 'bfs' | 'dfs' | 'dijkstra' | 'topo';

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

export function traceGraph(algorithm: GraphAlgorithm, spec: GraphSpec, start: string): GraphStep[] {
  if (algorithm === 'bfs') return bfs(spec, start);
  if (algorithm === 'dfs') return dfs(spec, start);
  if (algorithm === 'dijkstra') return dijkstra(spec, start);
  return topo(spec);
}

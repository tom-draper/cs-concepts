// Models behind the distributed systems widgets: a partitioned cluster,
// quorums, logical clocks, heartbeats, leader-based replication, partitioning,
// a hash ring, Raft, a CRDT counter and gossip. Also the message sequences for
// two-phase commit and Paxos.
import type { Sequence } from './networking';

/** A small repeatable random number generator, so the widgets behave the same on every visit. */
export function seeded(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 4294967296;
  };
}

/** FNV-1a, a simple 32-bit string hash. */
export function hash(text: string): number {
  let value = 2166136261;
  for (const char of text) {
    value ^= char.charCodeAt(0);
    value = Math.imul(value, 16777619) >>> 0;
  }
  // A final scramble, so short similar strings land far apart.
  value ^= value >>> 15;
  value = Math.imul(value, 2246822519) >>> 0;
  return (value ^ (value >>> 13)) >>> 0;
}

/* ---------- CAP ---------- */

/** Three replicas of one value. A partition cuts node A off from B and C. */
export class CapCluster {
  nodes = ['A', 'B', 'C'].map((name) => ({ name, value: 'v0', stamp: 0 }));
  partitioned = false;
  mode: 'CP' | 'AP' = 'CP';
  private clock = 0;

  /** Indices of the nodes that node `i` can currently reach, itself included. */
  private side(i: number) {
    if (!this.partitioned) return [0, 1, 2];
    return i === 0 ? [0] : [1, 2];
  }

  private refused(i: number) {
    // A consistent system only answers from a side that holds a majority.
    return this.mode === 'CP' && this.side(i).length < 2;
  }

  write(i: number): { ok: boolean; value?: string } {
    if (this.refused(i)) return { ok: false };
    const value = `v${++this.clock}`;
    for (const j of this.side(i)) Object.assign(this.nodes[j], { value, stamp: this.clock });
    return { ok: true, value };
  }

  read(i: number): { ok: boolean; value?: string; stale?: boolean } {
    if (this.refused(i)) return { ok: false };
    const newest = Math.max(...this.nodes.map((node) => node.stamp));
    return { ok: true, value: this.nodes[i].value, stale: this.nodes[i].stamp < newest };
  }

  /** Reconnects the network. Diverged copies are resolved by keeping the latest write. */
  heal(): { discarded: string[] } {
    this.partitioned = false;
    const winner = this.nodes.reduce((a, b) => (b.stamp > a.stamp ? b : a));
    const discarded = [...new Set(this.nodes.filter((node) => node.value !== winner.value).map((node) => node.value))];
    for (const node of this.nodes) Object.assign(node, { value: winner.value, stamp: winner.stamp });
    return { discarded };
  }
}

/* ---------- Quorums ---------- */

export class Quorum {
  static readonly N = 5;
  /** The version each replica holds. */
  versions = Array(Quorum.N).fill(0);
  latest = 0;
  private random = seeded(11);

  private pick(count: number): number[] {
    const order = Array.from({ length: Quorum.N }, (_, i) => i);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
    return order.slice(0, count).sort();
  }

  /** A write is acknowledged once `w` replicas have it. The rest have not heard yet. */
  write(w: number): number[] {
    const picked = this.pick(w);
    this.latest++;
    for (const i of picked) this.versions[i] = this.latest;
    return picked;
  }

  /** A read asks `r` replicas and takes the newest answer. */
  read(r: number): { picked: number[]; version: number; stale: boolean } {
    const picked = this.pick(r);
    const version = Math.max(...picked.map((i) => this.versions[i]));
    return { picked, version, stale: version < this.latest };
  }
}

/* ---------- Logical clocks ---------- */

export interface ClockEvent {
  process: number;
  kind: 'local' | 'send' | 'receive';
  lamport: number;
  vector: number[];
  /** For a receive, the index of the matching send. */
  from?: number;
}

export class Clocks {
  static readonly N = 3;
  events: ClockEvent[] = [];
  private lamport = Array(Clocks.N).fill(0);
  private vector = Array.from({ length: Clocks.N }, () => Array(Clocks.N).fill(0));

  private tick(process: number, kind: ClockEvent['kind'], from?: number) {
    this.lamport[process]++;
    this.vector[process][process]++;
    this.events.push({ process, kind, lamport: this.lamport[process], vector: [...this.vector[process]], from });
    return this.events.length - 1;
  }

  local(process: number) {
    this.tick(process, 'local');
  }

  /** A message carries the sender's clocks. The receiver moves its own clocks past them. */
  send(from: number, to: number) {
    const sent = this.tick(from, 'send');
    const message = this.events[sent];
    this.lamport[to] = Math.max(this.lamport[to], message.lamport);
    this.vector[to] = this.vector[to].map((count, i) => Math.max(count, message.vector[i]));
    this.tick(to, 'receive', sent);
  }
}

/** Whether event `a` could have influenced event `b`, judged by their vector clocks. */
export function causalOrder(a: ClockEvent, b: ClockEvent): 'before' | 'after' | 'concurrent' | 'same' {
  const less = a.vector.some((count, i) => count < b.vector[i]);
  const more = a.vector.some((count, i) => count > b.vector[i]);
  return less && more ? 'concurrent' : less ? 'before' : more ? 'after' : 'same';
}

/* ---------- Failure detection ---------- */

export type HeartbeatScenario = 'healthy' | 'pause' | 'crash';

/** The length of one slot in the trace, in seconds. */
export const SLOT = 0.25;

/**
 * A node sends a heartbeat every second for twelve seconds. Returns, for each
 * quarter second, whether one arrived and whether the monitor suspects the node.
 */
export function heartbeatTrace(timeout: number, scenario: HeartbeatScenario) {
  const random = seeded(5);
  const crashAt = scenario === 'crash' ? 6.1 : Infinity;
  const arrivals: number[] = [];
  for (let sent = 0; sent < 12; sent++) {
    if (sent > crashAt) break;
    // Network delay varies. In the pause scenario the node freezes for a while at five seconds.
    const frozen = scenario === 'pause' && sent >= 5 && sent < 8;
    arrivals.push(frozen ? 8.2 + (sent - 5) * 0.02 : sent + 0.03 + random() * 0.18);
  }
  const slots = [];
  let false_ = 0;
  let detected: number | null = null;
  let suspected = false;
  for (let t = 0; t < 12; t += SLOT) {
    const end = t + SLOT;
    const last = Math.max(...arrivals.filter((time) => time <= end), 0);
    const suspect = end - last > timeout;
    const alive = end < crashAt;
    if (suspect && !suspected && alive) false_++;
    if (suspect && !alive && detected === null) detected = end - crashAt;
    suspected = suspect;
    slots.push({ beat: arrivals.some((time) => time > t && time <= end), suspect, alive });
  }
  return { slots, falseAlarms: false_, detected };
}

/* ---------- Replication ---------- */

export class ReplicaSet {
  mode: 'asynchronous' | 'synchronous' = 'asynchronous';
  /** Each node's copy of the data, as the list of writes it has applied. */
  logs: number[][] = [[], [], []];
  up = [true, true, true];
  leader = 0;
  private next = 1;

  followers() {
    return [0, 1, 2].filter((i) => i !== this.leader && this.up[i]);
  }

  /** The leader applies a write and acknowledges it, after telling the followers only in synchronous mode. */
  write(): number {
    const value = this.next++;
    this.logs[this.leader].push(value);
    if (this.mode === 'synchronous') this.catchUp();
    return value;
  }

  /** Followers apply everything the leader has. */
  catchUp() {
    for (const i of this.followers()) this.logs[i] = [...this.logs[this.leader]];
  }

  lag(i: number) {
    return this.logs[this.leader].length - this.logs[i].length;
  }

  /** The leader dies and the most up-to-date follower takes over. Returns the acknowledged writes that are gone. */
  failover(): { promoted: number; lost: number[] } | null {
    const candidates = this.followers();
    if (!candidates.length) return null;
    const old = this.leader;
    this.up[old] = false;
    const promoted = candidates.reduce((a, b) => (this.logs[b].length > this.logs[a].length ? b : a));
    const lost = this.logs[old].slice(this.logs[promoted].length);
    this.leader = promoted;
    this.next = (this.logs[promoted].at(-1) ?? 0) + 1;
    return { promoted, lost };
  }
}

/* ---------- Partitioning ---------- */

export const customerNames = [
  'Aaron', 'Abby', 'Adam', 'Alice', 'Amy', 'Anna', 'Ben', 'Carl', 'Dan', 'Emma', 'Jack', 'James',
  'Jane', 'John', 'Kate', 'Liam', 'Maria', 'Mark', 'Mary', 'Mia', 'Noah', 'Sam', 'Sara', 'Zoe',
];

export type PartitionScheme = 'range' | 'hash';

/** Which of `nodes` partitions each name lands in. */
export function partition(scheme: PartitionScheme, nodes: number): number[] {
  return customerNames.map((name) =>
    scheme === 'hash'
      ? hash(name) % nodes
      : // Equal slices of the alphabet, by first letter.
        Math.min(nodes - 1, Math.floor(((name.toUpperCase().charCodeAt(0) - 65) / 26) * nodes)),
  );
}

/** For range partitioning, the first and last letter each partition covers. */
export function letterRange(index: number, nodes: number): string {
  const first = Math.ceil((index * 26) / nodes);
  const last = Math.ceil(((index + 1) * 26) / nodes) - 1;
  return `${String.fromCharCode(65 + first)} to ${String.fromCharCode(65 + last)}`;
}

/* ---------- Consistent hashing ---------- */

export const ringKeys = Array.from({ length: 40 }, (_, i) => `key${i + 1}`);

/** A position on the ring, in degrees. */
export const ringAngle = (text: string) => hash(text) % 360;

/** Where each node sits on the ring. With virtual nodes, each appears at several points. */
export function ringPoints(nodes: string[], virtual: number): { node: string; angle: number }[] {
  return nodes
    .flatMap((node) => Array.from({ length: virtual }, (_, i) => ({ node, angle: ringAngle(`${node}#${i}`) })))
    .sort((a, b) => a.angle - b.angle);
}

/** A key belongs to the first node point at or after it, going clockwise. */
export function ringOwner(key: string, points: { node: string; angle: number }[]): string {
  const angle = ringAngle(key);
  return (points.find((point) => point.angle >= angle) ?? points[0]).node;
}

/** The owner of each key under plain `hash mod N`, for comparison. */
export const modOwner = (key: string, nodes: string[]) => nodes[hash(key) % nodes.length];

/* ---------- Raft ---------- */

export interface RaftNode {
  id: number;
  up: boolean;
  term: number;
  role: 'follower' | 'candidate' | 'leader';
  /** The term in which each log entry was created. */
  log: number[];
  /** How many entries from the start of the log are known to be committed. */
  commit: number;
}

/** A simplified Raft cluster: elections, log replication and commitment by majority. */
export class Raft {
  static readonly N = 5;
  nodes: RaftNode[] = Array.from({ length: Raft.N }, (_, id) => ({ id, up: true, term: 0, role: 'follower', log: [], commit: 0 }));

  leader() {
    return this.nodes.find((node) => node.up && node.role === 'leader');
  }

  private majority(count: number) {
    return count > Raft.N / 2;
  }

  /** A node's election timer fires. It starts an election and asks every reachable node for a vote. */
  timeout(id: number): { won: boolean; votes: number; refused: number } {
    const candidate = this.nodes[id];
    candidate.term = Math.max(...this.nodes.filter((node) => node.up).map((node) => node.term)) + 1;
    candidate.role = 'candidate';
    let votes = 1;
    let refused = 0;
    for (const voter of this.nodes) {
      if (voter === candidate || !voter.up) continue;
      // A vote is only given to a candidate whose log is at least as complete as the voter's own.
      const theirs = [candidate.log.at(-1) ?? 0, candidate.log.length];
      const mine = [voter.log.at(-1) ?? 0, voter.log.length];
      const current = theirs[0] > mine[0] || (theirs[0] === mine[0] && theirs[1] >= mine[1]);
      voter.term = candidate.term;
      if (voter.role === 'leader') voter.role = 'follower';
      if (current) votes++;
      else refused++;
    }
    const won = this.majority(votes);
    if (won) {
      for (const node of this.nodes) if (node.up) node.role = node === candidate ? 'leader' : 'follower';
      this.replicate();
    } else {
      candidate.role = 'follower';
    }
    return { won, votes, refused };
  }

  /** The leader brings every reachable follower's log into line with its own, then commits what a majority holds. */
  replicate() {
    const leader = this.leader();
    if (!leader) return;
    const reachable = this.nodes.filter((node) => node.up);
    for (const node of reachable) {
      node.log = [...leader.log];
      node.term = leader.term;
    }
    // Only an entry from the leader's own term may be committed by counting copies.
    if (this.majority(reachable.length) && leader.log.at(-1) === leader.term) {
      for (const node of reachable) node.commit = leader.log.length;
    }
  }

  /** A client sends a command to the leader. Returns whether it was committed. */
  request(): { accepted: boolean; committed: boolean } {
    const leader = this.leader();
    if (!leader) return { accepted: false, committed: false };
    leader.log.push(leader.term);
    this.replicate();
    return { accepted: true, committed: leader.commit === leader.log.length };
  }

  toggle(id: number) {
    const node = this.nodes[id];
    node.up = !node.up;
    if (!node.up) return;
    // A node that comes back starts as a follower, and an active leader soon repairs its log.
    node.role = 'follower';
    this.replicate();
  }
}

/* ---------- CRDTs ---------- */

/**
 * Two replicas of a counter, kept two ways at once: as a CRDT, where each
 * replica tracks how much each replica has added and removed, and as a plain
 * number where the latest write wins.
 */
export class Counters {
  /** `added[r][i]` is what replica `r` believes replica `i` has added in total. */
  added = [[0, 0], [0, 0]];
  removed = [[0, 0], [0, 0]];
  plain = [{ value: 0, stamp: 0 }, { value: 0, stamp: 0 }];
  /** What the count should be, if no update were lost. */
  truth = 0;
  private clock = 0;

  change(replica: number, delta: 1 | -1) {
    (delta > 0 ? this.added : this.removed)[replica][replica]++;
    this.plain[replica] = { value: this.plain[replica].value + delta, stamp: ++this.clock };
    this.truth += delta;
  }

  value(replica: number) {
    const sum = (list: number[]) => list.reduce((a, b) => a + b, 0);
    return sum(this.added[replica]) - sum(this.removed[replica]);
  }

  /** The replicas exchange state. The CRDT takes the larger of each tally, and the plain number takes the later write. */
  sync() {
    const merge = (tallies: number[][]) => {
      const merged = tallies[0].map((count, i) => Math.max(count, tallies[1][i]));
      tallies[0] = [...merged];
      tallies[1] = [...merged];
    };
    merge(this.added);
    merge(this.removed);
    const winner = this.plain[0].stamp >= this.plain[1].stamp ? this.plain[0] : this.plain[1];
    this.plain = [{ ...winner }, { ...winner }];
  }
}

/* ---------- Gossip ---------- */

export class Gossip {
  static readonly N = 36;
  /** The round in which each node first heard the rumour, or -1. */
  heard = Array(Gossip.N).fill(-1);
  round = 0;
  messages = 0;
  private random = seeded(3);

  constructor() {
    this.heard[14] = 0;
  }

  get informed() {
    return this.heard.filter((round) => round >= 0).length;
  }

  /** Every node that knows the rumour tells `fanout` others chosen at random. */
  step(fanout: number): number {
    this.round++;
    const tellers = this.heard.map((round, i) => (round >= 0 ? i : -1)).filter((i) => i >= 0);
    let fresh = 0;
    for (const teller of tellers) {
      for (let i = 0; i < fanout; i++) {
        let target = Math.floor(this.random() * (Gossip.N - 1));
        if (target >= teller) target++;
        this.messages++;
        if (this.heard[target] < 0) {
          this.heard[target] = this.round;
          fresh++;
        }
      }
    }
    return fresh;
  }
}

/* ---------- Message sequences ---------- */

export const distributedSequences = {
  '2pc-commit': {
    actors: ['coordinator', 'orders db', 'payments db'],
    steps: [
      { from: 0, to: 1, label: 'prepare', note: 'Phase one. The coordinator asks each participant whether it can commit its part.' },
      { from: 0, to: 2, label: 'prepare', note: 'Both participants are asked.' },
      { from: 1, to: 1, label: 'log it, hold locks', note: 'To answer yes, a participant must make sure it can commit whatever happens next. It writes the changes to its log and keeps its locks.' },
      { from: 1, to: 0, label: 'yes', note: 'A yes is a promise. From here the participant may not change its mind.' },
      { from: 2, to: 0, label: 'yes', note: 'Every participant has voted yes.' },
      { from: 0, to: 0, label: 'log: commit', note: 'The coordinator records the decision on disk. This is the moment the transaction commits.' },
      { from: 0, to: 1, label: 'commit', note: 'Phase two. The coordinator announces the decision.' },
      { from: 0, to: 2, label: 'commit', note: 'Each participant commits and releases its locks.' },
      { from: 1, to: 0, label: 'done', note: 'The coordinator can forget the transaction once everyone has confirmed.' },
      { from: 2, to: 0, label: 'done', note: 'Both databases changed, or neither would have.' },
    ],
  },
  '2pc-abort': {
    actors: ['coordinator', 'orders db', 'payments db'],
    steps: [
      { from: 0, to: 1, label: 'prepare', note: 'Phase one starts as before.' },
      { from: 0, to: 2, label: 'prepare', note: 'Both participants are asked.' },
      { from: 1, to: 0, label: 'yes', note: 'The orders database is ready and has promised.' },
      { from: 2, to: 0, label: 'no', note: 'The payments database cannot commit: the card was declined. One no is enough.' },
      { from: 0, to: 0, label: 'log: abort', note: 'The coordinator records the decision to abort.' },
      { from: 0, to: 1, label: 'abort', note: 'The orders database, which had voted yes, rolls back and releases its locks.' },
      { from: 0, to: 2, label: 'abort', note: 'Nothing was changed anywhere.' },
    ],
  },
  '2pc-stuck': {
    actors: ['coordinator', 'orders db', 'payments db'],
    steps: [
      { from: 0, to: 1, label: 'prepare', note: 'Phase one.' },
      { from: 0, to: 2, label: 'prepare', note: 'Both participants are asked.' },
      { from: 1, to: 0, label: 'yes', note: 'The orders database promises.' },
      { from: 2, to: 0, label: 'yes', note: 'The payments database promises.' },
      { from: 0, to: 0, label: 'crash', note: 'The coordinator fails before telling anyone the outcome.' },
      { from: 1, to: 1, label: 'waiting, locked', note: 'The orders database voted yes, so it may not abort. It has not heard commit, so it may not commit. It can only wait, holding its locks.' },
      { from: 2, to: 2, label: 'waiting, locked', note: 'The same is true here. Every other transaction that needs these rows is blocked until the coordinator comes back.' },
    ],
  },
  paxos: {
    actors: ['proposer', 'acceptor 1', 'acceptor 2', 'acceptor 3'],
    steps: [
      { from: 0, to: 1, label: 'prepare 5', note: 'The proposer picks a proposal number, 5, higher than any it has used, and asks the acceptors to promise.' },
      { from: 0, to: 2, label: 'prepare 5', note: 'The same request goes to every acceptor.' },
      { from: 0, to: 3, label: 'prepare 5', note: 'This one is lost on the way.', lost: true },
      { from: 1, to: 0, label: 'promise', note: 'Acceptor 1 promises to ignore any proposal numbered below 5. It would also report any value it had already accepted.' },
      { from: 2, to: 0, label: 'promise', note: 'Two of three have promised. That is a majority, which is all that is needed.' },
      { from: 0, to: 1, label: 'accept 5, x', note: 'No acceptor reported an earlier value, so the proposer is free to propose its own: x.' },
      { from: 0, to: 2, label: 'accept 5, x', note: 'The acceptors that promised are asked to accept.' },
      { from: 1, to: 0, label: 'accepted', note: 'Acceptor 1 has made no promise to a higher number since, so it accepts.' },
      { from: 2, to: 0, label: 'accepted', note: 'A majority has accepted x. The value is chosen, and no later proposal can choose anything else.' },
    ],
  },
} satisfies Record<string, Sequence>;

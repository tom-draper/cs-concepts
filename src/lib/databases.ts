// Models behind the database widgets: a small SQL engine over two sample
// tables, joins, an index lookup, an LSM tree, a write-ahead log, a query
// cost model, isolation anomalies and multi-version rows.

export type Value = string | number | null;
export type Row = Record<string, Value>;

export interface Table {
  columns: string[];
  rows: Row[];
}

export const tables: Record<string, Table> = {
  customers: {
    columns: ['id', 'name', 'city'],
    rows: [
      { id: 1, name: 'Ada', city: 'London' },
      { id: 2, name: 'Grace', city: 'New York' },
      { id: 3, name: 'Linus', city: 'Helsinki' },
      { id: 4, name: 'Alan', city: 'London' },
      { id: 5, name: 'Edsger', city: 'Austin' },
    ],
  },
  orders: {
    columns: ['id', 'customer_id', 'item', 'amount'],
    rows: [
      { id: 1, customer_id: 1, item: 'keyboard', amount: 80 },
      { id: 2, customer_id: 1, item: 'monitor', amount: 240 },
      { id: 3, customer_id: 2, item: 'laptop', amount: 1200 },
      { id: 4, customer_id: 3, item: 'mouse', amount: 25 },
      { id: 5, customer_id: 2, item: 'cable', amount: 10 },
      { id: 6, customer_id: null, item: 'desk', amount: 300 },
    ],
  },
};

/* ---------- SQL ---------- */

type Expr =
  | { kind: 'column'; table?: string; name: string }
  | { kind: 'literal'; value: Value }
  | { kind: 'aggregate'; fn: string; arg: Expr | null };

type Condition =
  | { kind: 'compare'; op: string; left: Expr; right: Expr }
  | { kind: 'and' | 'or'; left: Condition; right: Condition }
  | { kind: 'null'; expr: Expr; negated: boolean };

interface Source {
  table: string;
  alias: string;
}

interface Query {
  /** Null means `*`. */
  select: { expr: Expr; name: string }[] | null;
  from: Source;
  joins: (Source & { outer: boolean; on: Condition })[];
  where?: Condition;
  groupBy: Expr[];
  orderBy?: { expr: Expr; descending: boolean };
  limit?: number;
}

const reserved = ['SELECT', 'FROM', 'WHERE', 'JOIN', 'INNER', 'LEFT', 'OUTER', 'ON', 'GROUP', 'ORDER', 'BY', 'LIMIT', 'AND', 'OR', 'AS', 'IS', 'NOT', 'NULL', 'ASC', 'DESC'];
const aggregates = ['COUNT', 'SUM', 'AVG', 'MIN', 'MAX'];

function parseSql(sql: string, source: Record<string, Table>): Query {
  // A comment runs from -- to the end of the line.
  const tokens = (sql.match(/--[^\n]*|<=|>=|<>|!=|[(),.*=<>;]|'[^']*'|\d+(?:\.\d+)?|[A-Za-z_]\w*|\S/g) ?? []).filter((token) => !token.startsWith('--'));
  if (tokens[tokens.length - 1] === ';') tokens.pop();
  let at = 0;
  const upper = () => tokens[at]?.toUpperCase();
  const take = (word: string) => {
    if (upper() !== word) return false;
    at++;
    return true;
  };
  const expect = (word: string) => {
    if (!take(word)) throw new Error(`Expected ${word} but found ${tokens[at] ?? 'the end of the query'}.`);
  };
  const identifier = (what: string) => {
    const token = tokens[at];
    if (!token || !/^[A-Za-z_]\w*$/.test(token) || reserved.includes(token.toUpperCase())) {
      throw new Error(`Expected ${what} but found ${token ?? 'the end of the query'}.`);
    }
    at++;
    return token;
  };
  const expression = (): Expr => {
    const token = tokens[at];
    if (token === undefined) throw new Error('The query stops where a value was expected.');
    if (/^\d/.test(token)) return at++, { kind: 'literal', value: Number(token) };
    if (token.startsWith("'")) return at++, { kind: 'literal', value: token.slice(1, -1) };
    if (token.toUpperCase() === 'NULL') return at++, { kind: 'literal', value: null };
    if (aggregates.includes(token.toUpperCase()) && tokens[at + 1] === '(') {
      at += 2;
      const arg = tokens[at] === '*' ? (at++, null) : expression();
      expect(')');
      return { kind: 'aggregate', fn: token.toUpperCase(), arg };
    }
    const first = identifier('a column');
    if (tokens[at] !== '.') return { kind: 'column', name: first };
    at++;
    return { kind: 'column', table: first, name: identifier('a column name') };
  };
  const show = (expr: Expr): string =>
    expr.kind === 'column' ? expr.name : expr.kind === 'literal' ? String(expr.value) : `${expr.fn.toLowerCase()}`;
  const comparison = (): Condition => {
    if (tokens[at] === '(') {
      at++;
      const inner = condition();
      expect(')');
      return inner;
    }
    const left = expression();
    if (take('IS')) {
      const negated = take('NOT');
      expect('NULL');
      return { kind: 'null', expr: left, negated };
    }
    const op = tokens[at++];
    if (!['=', '!=', '<>', '<', '>', '<=', '>='].includes(op)) throw new Error(`Expected a comparison such as = or < but found ${op ?? 'the end of the query'}.`);
    return { kind: 'compare', op, left, right: expression() };
  };
  // AND binds tighter than OR.
  const conjunction = (): Condition => {
    let left = comparison();
    while (take('AND')) left = { kind: 'and', left, right: comparison() };
    return left;
  };
  const condition = (): Condition => {
    let left = conjunction();
    while (take('OR')) left = { kind: 'or', left, right: conjunction() };
    return left;
  };
  const from = (): Source => {
    const table = identifier('a table name').toLowerCase();
    if (!source[table]) throw new Error(`There is no table called ${table}. The tables are ${Object.keys(source).join(' and ')}.`);
    take('AS');
    const next = tokens[at];
    const alias = next && /^[A-Za-z_]\w*$/.test(next) && !reserved.includes(next.toUpperCase()) ? tokens[at++] : table;
    return { table, alias };
  };

  expect('SELECT');
  let select: Query['select'] = null;
  if (tokens[at] === '*') {
    at++;
  } else {
    select = [];
    do {
      const expr = expression();
      select.push({ expr, name: take('AS') ? identifier('a name') : show(expr) });
    } while (tokens[at] === ',' && ++at);
  }
  expect('FROM');
  const query: Query = { select, from: from(), joins: [], groupBy: [] };
  for (;;) {
    const outer = take('LEFT');
    if (outer) take('OUTER');
    else take('INNER');
    if (!take('JOIN')) {
      if (outer) throw new Error('Expected JOIN after LEFT.');
      break;
    }
    const joined = from();
    expect('ON');
    query.joins.push({ ...joined, outer, on: condition() });
  }
  if (take('WHERE')) query.where = condition();
  if (take('GROUP')) {
    expect('BY');
    do query.groupBy.push(expression());
    while (tokens[at] === ',' && ++at);
  }
  if (take('ORDER')) {
    expect('BY');
    const expr = expression();
    const descending = take('DESC');
    if (!descending) take('ASC');
    query.orderBy = { expr, descending };
  }
  if (take('LIMIT')) {
    if (!/^\d+$/.test(tokens[at] ?? '')) throw new Error('LIMIT needs a whole number.');
    query.limit = Number(tokens[at++]);
  }
  if (at < tokens.length) throw new Error(`Did not expect ${tokens[at]} here.`);
  return query;
}

/** One joined row: each table alias mapped to its row, or null on the empty side of an outer join. */
type Bindings = Record<string, Row | null>;

export interface QueryResult {
  columns: string[];
  rows: Value[][];
  /** Rows produced by FROM and JOIN, before filtering. */
  scanned: number;
}

/** Runs a SELECT over the sample tables, or the ones given, in the order the clauses are logically applied. */
export function runSql(sql: string, source: Record<string, Table> = tables): QueryResult {
  const query = parseSql(sql, source);
  const sources = [query.from, ...query.joins];
  const schema = new Map(sources.map((each) => [each.alias, source[each.table].columns]));
  if (schema.size !== sources.length) throw new Error('Two tables have the same name here. Give one an alias.');

  const column = (expr: Extract<Expr, { kind: 'column' }>, row: Bindings): Value => {
    if (expr.table) {
      const columns = schema.get(expr.table);
      if (!columns) throw new Error(`${expr.table} is not a table in this query.`);
      if (!columns.includes(expr.name)) throw new Error(`${expr.table} has no column called ${expr.name}.`);
      return row[expr.table]?.[expr.name] ?? null;
    }
    const owners = [...schema].filter(([, columns]) => columns.includes(expr.name));
    if (!owners.length) throw new Error(`There is no column called ${expr.name}.`);
    if (owners.length > 1) throw new Error(`${expr.name} is ambiguous. Write ${owners.map(([alias]) => `${alias}.${expr.name}`).join(' or ')}.`);
    return row[owners[0][0]]?.[expr.name] ?? null;
  };
  // An expression is evaluated over a group of rows. An ordinary row is a group of one.
  const evaluate = (expr: Expr, group: Bindings[]): Value => {
    if (expr.kind === 'literal') return expr.value;
    if (expr.kind === 'column') return group.length ? column(expr, group[0]) : null;
    const values = expr.arg ? group.map((row) => evaluate(expr.arg!, [row])).filter((value) => value !== null) : group;
    if (expr.fn === 'COUNT') return values.length;
    const numbers = values as number[];
    if (!numbers.length) return null;
    if (expr.fn === 'SUM') return numbers.reduce((a, b) => a + b, 0);
    if (expr.fn === 'AVG') return Math.round((numbers.reduce((a, b) => a + b, 0) / numbers.length) * 100) / 100;
    return numbers.reduce((a, b) => ((expr.fn === 'MIN' ? a < b : a > b) ? a : b));
  };
  const holds = (condition: Condition, row: Bindings): boolean => {
    if (condition.kind === 'and') return holds(condition.left, row) && holds(condition.right, row);
    if (condition.kind === 'or') return holds(condition.left, row) || holds(condition.right, row);
    if (condition.kind === 'null') return (evaluate(condition.expr, [row]) === null) !== condition.negated;
    const a = evaluate(condition.left, [row]);
    const b = evaluate(condition.right, [row]);
    // Any comparison with NULL is unknown, which filters the row out.
    if (a === null || b === null) return false;
    switch (condition.op) {
      case '=':
        return a === b;
      case '<':
        return a < b;
      case '>':
        return a > b;
      case '<=':
        return a <= b;
      case '>=':
        return a >= b;
      default:
        return a !== b;
    }
  };

  // FROM and JOIN
  let rows: Bindings[] = source[query.from.table].rows.map((row) => ({ [query.from.alias]: row }));
  for (const join of query.joins) {
    rows = rows.flatMap((row) => {
      const matches = source[join.table].rows.map((other) => ({ ...row, [join.alias]: other })).filter((both) => holds(join.on, both));
      return matches.length || !join.outer ? matches : [{ ...row, [join.alias]: null }];
    });
  }
  const scanned = rows.length;
  // WHERE
  if (query.where) rows = rows.filter((row) => holds(query.where!, row));
  // GROUP BY
  const select =
    query.select ??
    sources.flatMap((each) =>
      source[each.table].columns.map((name) => ({
        expr: { kind: 'column' as const, table: each.alias, name },
        name: sources.length > 1 ? `${each.alias}.${name}` : name,
      })),
    );
  const grouped = query.groupBy.length > 0 || select.some((item) => item.expr.kind === 'aggregate');
  let groups: Bindings[][];
  if (!grouped) {
    groups = rows.map((row) => [row]);
  } else if (!query.groupBy.length) {
    groups = [rows];
  } else {
    const byKey = new Map<string, Bindings[]>();
    for (const row of rows) {
      const key = JSON.stringify(query.groupBy.map((expr) => evaluate(expr, [row])));
      byKey.set(key, [...(byKey.get(key) ?? []), row]);
    }
    groups = [...byKey.values()];
  }
  // SELECT
  let output = groups.map((group) => ({ group, values: select.map((item) => evaluate(item.expr, group)) }));
  // ORDER BY, which may name an output column
  if (query.orderBy) {
    const { expr, descending } = query.orderBy;
    const named = expr.kind === 'column' && !expr.table ? select.findIndex((item) => item.name === expr.name) : -1;
    const key = (row: (typeof output)[number]) => (named >= 0 ? row.values[named] : evaluate(expr, row.group));
    output = [...output].sort((x, y) => {
      const a = key(x);
      const b = key(y);
      const order = a === b ? 0 : a === null ? -1 : b === null ? 1 : a < b ? -1 : 1;
      return descending ? -order : order;
    });
  }
  // LIMIT
  if (query.limit !== undefined) output = output.slice(0, query.limit);
  return { columns: select.map((item) => item.name), rows: output.map((row) => row.values), scanned };
}

/* ---------- Joins ---------- */

export type JoinKind = 'inner' | 'left' | 'right' | 'full' | 'cross';

export const joinKinds: JoinKind[] = ['inner', 'left', 'right', 'full', 'cross'];

/** Pairs of row indices from customers and orders. `null` marks the side with no match. */
export function joinPairs(kind: JoinKind): [number | null, number | null][] {
  const left = tables.customers.rows;
  const right = tables.orders.rows;
  if (kind === 'cross') return left.flatMap((_, i) => right.map((_, j): [number, number] => [i, j]));
  const pairs: [number | null, number | null][] = [];
  left.forEach((customer, i) => {
    const matches = right.map((order, j) => (order.customer_id === customer.id ? j : -1)).filter((j) => j >= 0);
    for (const j of matches) pairs.push([i, j]);
    if (!matches.length && (kind === 'left' || kind === 'full')) pairs.push([i, null]);
  });
  if (kind === 'right' || kind === 'full') {
    right.forEach((order, j) => {
      if (!left.some((customer) => customer.id === order.customer_id)) pairs.push([null, j]);
    });
  }
  return pairs;
}

/* ---------- Indexes ---------- */

/** People in the order they were inserted, which is the order they sit in the table. */
export const people: [name: string, age: number][] = [
  ['Mia', 34],
  ['Leo', 19],
  ['Zoe', 52],
  ['Sam', 27],
  ['Eve', 41],
  ['Max', 23],
  ['Ivy', 65],
  ['Ben', 30],
  ['Amy', 46],
  ['Tom', 21],
  ['Kim', 58],
  ['Dan', 38],
];

/** The index on age: every age in order, each pointing back at its row. */
export const ageIndex = people.map(([, age], row) => ({ age, row })).sort((a, b) => a.age - b.age);

/** Positions in the index that a binary search for `age` looks at, ending on the match. */
export function indexProbes(age: number): number[] {
  const probes: number[] = [];
  let low = 0;
  let high = ageIndex.length - 1;
  while (low <= high) {
    const middle = (low + high) >> 1;
    probes.push(middle);
    if (ageIndex[middle].age === age) break;
    if (ageIndex[middle].age < age) low = middle + 1;
    else high = middle - 1;
  }
  return probes;
}

/* ---------- LSM tree ---------- */

export const TOMBSTONE = 'deleted';

export class Lsm {
  static readonly LIMIT = 4;
  memtable = new Map<string, string>();
  /** Sorted, immutable files on disk, newest first. */
  files: { id: number; entries: [string, string][] }[] = [];
  private nextFile = 1;
  private versions = new Map<string, number>();

  /** Writes a fresh value for the key and returns it. Flushes if the memtable is full. */
  put(key: string, remove = false): { value: string; flushed: boolean } {
    const version = (this.versions.get(key) ?? 0) + 1;
    this.versions.set(key, version);
    const value = remove ? TOMBSTONE : `v${version}`;
    this.memtable.set(key, value);
    if (this.memtable.size < Lsm.LIMIT) return { value, flushed: false };
    this.files.unshift({ id: this.nextFile++, entries: [...this.memtable].sort(([a], [b]) => a.localeCompare(b)) });
    this.memtable = new Map();
    return { value, flushed: true };
  }

  /** Looks in the memtable and then each file from newest to oldest. */
  get(key: string): { value: string | null; searched: string[] } {
    const searched = ['the memtable'];
    if (this.memtable.has(key)) return { value: this.memtable.get(key)!, searched };
    for (const file of this.files) {
      searched.push(`file ${file.id}`);
      const found = file.entries.find(([each]) => each === key);
      if (found) return { value: found[1], searched };
    }
    return { value: null, searched };
  }

  /** Merges every file into one, keeping only the newest value of each key and dropping deletions. */
  compact(): { before: number; after: number } {
    const before = this.files.reduce((sum, file) => sum + file.entries.length, 0);
    const merged = new Map<string, string>();
    for (const file of [...this.files].reverse()) for (const [key, value] of file.entries) merged.set(key, value);
    const entries = [...merged].filter(([, value]) => value !== TOMBSTONE).sort(([a], [b]) => a.localeCompare(b));
    this.files = entries.length ? [{ id: this.nextFile++, entries }] : [];
    return { before, after: entries.length };
  }
}

/* ---------- Write-ahead log ---------- */

export interface LogRecord {
  lsn: number;
  tx: number;
  /** An update to one account, or the commit of the transaction. */
  change?: { key: string; before: number; after: number };
  /** Whether the record has reached the disk. */
  durable: boolean;
}

export class WalDatabase {
  disk: Record<string, number> = { A: 100, B: 100 };
  memory: Record<string, number> = { A: 100, B: 100 };
  log: LogRecord[] = [];
  /** The transaction in progress, if any. */
  open: number | null = null;
  private nextTx = 1;
  private nextLsn = 1;
  /** The last log record applied to each page, in memory and on disk. */
  private memoryLsn: Record<string, number> = { A: 0, B: 0 };
  private diskLsn: Record<string, number> = { A: 0, B: 0 };

  private append(tx: number, change?: LogRecord['change']) {
    this.log.push({ lsn: this.nextLsn++, tx, change, durable: false });
    if (change) this.memoryLsn[change.key] = this.nextLsn - 1;
  }

  /** Moves 10 from A to B inside the open transaction, starting one if needed. */
  transfer() {
    this.open ??= this.nextTx++;
    for (const [key, delta] of [['A', -10], ['B', 10]] as const) {
      // The log record is written before the page is touched.
      this.append(this.open, { key, before: this.memory[key], after: this.memory[key] + delta });
      this.memory[key] += delta;
    }
  }

  private flushLog() {
    for (const record of this.log) record.durable = true;
  }

  commit() {
    if (this.open === null) return;
    this.append(this.open);
    this.flushLog();
    this.open = null;
  }

  /**
   * Writes the in-memory pages to disk. The log must get there first. With no
   * transaction open, nothing in the log is needed any more and it is emptied.
   */
  checkpoint(): { truncated: number } {
    this.flushLog();
    this.disk = { ...this.memory };
    this.diskLsn = { ...this.memoryLsn };
    if (this.open !== null) return { truncated: 0 };
    const truncated = this.log.length;
    this.log = [];
    return { truncated };
  }

  /** Loses everything in memory, then recovers from the durable log. */
  crash(): { redone: number; undone: number; lost: number } {
    const lost = this.log.filter((record) => !record.durable).length;
    this.log = this.log.filter((record) => record.durable);
    const committed = new Set(this.log.filter((record) => !record.change).map((record) => record.tx));
    let redone = 0;
    let undone = 0;
    // Redo: repeat history for committed transactions, oldest first.
    for (const { lsn, tx, change } of this.log) {
      // A page records the last change it holds, so nothing is applied twice.
      if (change && committed.has(tx) && lsn > this.diskLsn[change.key]) {
        this.disk[change.key] = change.after;
        this.diskLsn[change.key] = lsn;
        redone++;
      }
    }
    // Undo: roll back anything from a transaction that never committed, newest first.
    for (const { lsn, tx, change } of [...this.log].reverse()) {
      if (change && !committed.has(tx) && lsn <= this.diskLsn[change.key]) {
        this.disk[change.key] = change.before;
        undone++;
      }
    }
    this.log = this.log.filter((record) => committed.has(record.tx));
    this.memory = { ...this.disk };
    this.memoryLsn = { ...this.diskLsn };
    this.open = null;
    return { redone, undone, lost };
  }
}

/* ---------- Query planning ---------- */

const ROWS_PER_PAGE = 20;

/** Estimated cost of two ways to find the rows matching a condition, in page reads. */
export function planCosts(rows: number, selectivity: number) {
  const pages = Math.ceil(rows / ROWS_PER_PAGE);
  const matches = Math.max(1, Math.round(rows * selectivity));
  const height = Math.max(1, Math.ceil(Math.log(rows) / Math.log(200)));
  // Reading pages in order is cheap. Jumping to a page out of order costs about four times as much.
  const scan = Math.round(pages + rows * 0.01);
  const index = Math.round(height + Math.min(matches, pages) * 4 + matches * 0.01);
  return { pages, matches, scan, index, best: index < scan ? ('index' as const) : ('scan' as const) };
}

/* ---------- Isolation ---------- */

export const isolationLevels = ['read uncommitted', 'read committed', 'repeatable read', 'serializable'] as const;
export type IsolationLevel = (typeof isolationLevels)[number];

/** One value per level in the order above, or one value for all of them. */
type PerLevel = string | [string, string, string, string];

export interface Anomaly {
  title: string;
  steps: { tx: 1 | 2; sql: string; result?: PerLevel }[];
  /** What it all added up to at each level. A leading `!` marks an anomaly. */
  outcome: PerLevel;
}

export const anomalies = {
  'dirty read': {
    title: 'Dirty read',
    steps: [
      { tx: 1, sql: 'UPDATE accounts SET balance = 50 WHERE id = 1' },
      { tx: 2, sql: 'SELECT balance FROM accounts WHERE id = 1', result: ['50', '100', '100', '100'] },
      { tx: 1, sql: 'ROLLBACK' },
    ],
    outcome: [
      '!Transaction 2 saw 50, a balance that was never committed and now never existed.',
      'Transaction 2 saw 100, the last committed value. Uncommitted changes are invisible.',
      'Transaction 2 saw 100, the last committed value.',
      'Transaction 2 saw 100, the last committed value.',
    ],
  },
  'non-repeatable read': {
    title: 'Non-repeatable read',
    steps: [
      { tx: 2, sql: 'SELECT balance FROM accounts WHERE id = 1', result: '100' },
      { tx: 1, sql: 'UPDATE accounts SET balance = 50 WHERE id = 1' },
      { tx: 1, sql: 'COMMIT' },
      { tx: 2, sql: 'SELECT balance FROM accounts WHERE id = 1', result: ['50', '50', '100', '100'] },
    ],
    outcome: [
      '!Transaction 2 read the same row twice and got 100, then 50.',
      '!Transaction 2 read the same row twice and got 100, then 50. Each statement sees the latest committed data, so the answer can change between them.',
      'Both reads returned 100. The transaction works from the data as it stood when it began.',
      'Both reads returned 100.',
    ],
  },
  phantom: {
    title: 'Phantom read',
    steps: [
      { tx: 2, sql: 'SELECT COUNT(*) FROM orders WHERE amount > 100', result: '3' },
      { tx: 1, sql: "INSERT INTO orders VALUES (7, 4, 'chair', 150)" },
      { tx: 1, sql: 'COMMIT' },
      { tx: 2, sql: 'SELECT COUNT(*) FROM orders WHERE amount > 100', result: ['4', '4', '4', '3'] },
    ],
    outcome: [
      '!The same query returned 3 rows, then 4. A new row appeared in the middle of the transaction.',
      '!The same query returned 3 rows, then 4.',
      '!The SQL standard allows this here: existing rows are stable, but a new row matching the condition can still appear. Many databases, PostgreSQL included, prevent it at this level anyway.',
      'Both queries returned 3. The transaction behaves as if it ran entirely before the insert.',
    ],
  },
  'lost update': {
    title: 'Lost update',
    steps: [
      { tx: 1, sql: 'SELECT balance FROM accounts WHERE id = 1', result: '100' },
      { tx: 2, sql: 'SELECT balance FROM accounts WHERE id = 1', result: '100' },
      { tx: 1, sql: 'UPDATE accounts SET balance = 110 WHERE id = 1' },
      { tx: 1, sql: 'COMMIT' },
      { tx: 2, sql: 'UPDATE accounts SET balance = 120 WHERE id = 1', result: ['ok', 'ok', 'error: retry', 'error: retry'] },
      { tx: 2, sql: 'COMMIT', result: ['', '', 'rolled back', 'rolled back'] },
    ],
    outcome: [
      '!One deposit of 10 and one of 20 left a balance of 120, not 130. The first deposit was overwritten.',
      '!One deposit of 10 and one of 20 left a balance of 120, not 130. Both transactions computed from the same stale 100.',
      'Transaction 2 was stopped because the row changed after it read it. It retries, reads 110 and writes 130.',
      'Transaction 2 was stopped and must retry. It then reads 110 and writes 130.',
    ],
  },
  'write skew': {
    title: 'Write skew',
    steps: [
      { tx: 1, sql: 'SELECT COUNT(*) FROM doctors WHERE on_call', result: '2' },
      { tx: 2, sql: 'SELECT COUNT(*) FROM doctors WHERE on_call', result: '2' },
      { tx: 1, sql: "UPDATE doctors SET on_call = false WHERE name = 'Alice'" },
      { tx: 2, sql: "UPDATE doctors SET on_call = false WHERE name = 'Bob'" },
      { tx: 1, sql: 'COMMIT' },
      { tx: 2, sql: 'COMMIT', result: ['ok', 'ok', 'ok', 'error: retry'] },
    ],
    outcome: [
      '!Nobody is on call. Each doctor checked that two were on call and then left.',
      '!Nobody is on call. Each transaction checked the rule and then changed a different row, so neither write conflicted.',
      '!Nobody is on call. Each transaction worked from its own consistent snapshot and wrote a different row, so a snapshot alone does not catch this.',
      'Transaction 2 was stopped. The database noticed that its decision depended on data transaction 1 changed. On retry it sees one doctor on call and stays.',
    ],
  },
} satisfies Record<string, Anomaly>;

export type AnomalyName = keyof typeof anomalies;

export const atLevel = (value: PerLevel | undefined, level: number) => (typeof value === 'string' || value === undefined ? value : value[level]);

/* ---------- Multi-version concurrency control ---------- */

export interface RowVersion {
  value: number;
  /** The transaction that wrote this version. */
  created: number;
  /** The transaction that replaced it, if any. */
  expired: number | null;
}

/** One row with a history of versions. Writers commit at once, and readers stay open. */
export class MvccRow {
  versions: RowVersion[] = [{ value: 100, created: 1, expired: null }];
  readers: number[] = [];
  private nextTx = 2;

  /** A reader's snapshot is fixed when it starts. */
  startReader() {
    this.readers.push(this.nextTx);
    return this.nextTx++;
  }

  finishReader(tx: number) {
    this.readers = this.readers.filter((each) => each !== tx);
  }

  /** A new transaction adds 10 and commits. The old version is kept, marked as expired. */
  write() {
    const tx = this.nextTx++;
    const current = this.versions[this.versions.length - 1];
    current.expired = tx;
    this.versions.push({ value: current.value + 10, created: tx, expired: null });
    return tx;
  }

  /** A version is visible to a transaction that started after it was written and before it was replaced. */
  visible(version: RowVersion, tx: number) {
    return version.created < tx && (version.expired === null || version.expired > tx);
  }

  seenBy(tx: number) {
    return this.versions.find((version) => this.visible(version, tx))!;
  }

  /** Removes versions that no open transaction can see. */
  vacuum(): { removed: number; kept: number } {
    const dead = this.versions.filter((version) => version.expired !== null);
    const needed = dead.filter((version) => this.readers.some((tx) => this.visible(version, tx)));
    this.versions = this.versions.filter((version) => version.expired === null || needed.includes(version));
    return { removed: dead.length - needed.length, kept: needed.length };
  }
}

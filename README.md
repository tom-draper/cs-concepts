# cs-concepts

A complete guide for Computer Science concepts: one page per concept, read front to back like a book.

Built with [Astro](https://astro.build) and served from GitHub Pages at <https://tom-draper.github.io/cs-concepts/>.

## Develop

```sh
pnpm install
pnpm dev        # http://localhost:4321/cs-concepts/
pnpm build      # static site + search index in dist/
pnpm preview    # serve dist/ (search only works here, not in dev)
```

## How the book is organised

| Path | What it is |
| --- | --- |
| `src/outline.ts` | The table of contents: parts, chapters, page titles and reading order. |
| `src/content/docs/<part>/<page>.mdx` | One file per concept. |
| `src/components/viz/` | Diagram components, rendered to inline SVG at build time. |
| `src/components/mdx.ts` | The components every page can use without importing. |

The outline lists every page the book intends to have. A page is **planned**
(greyed out in the sidebar) until its `.mdx` file exists; then it becomes a link
and joins the previous/next chain automatically.

## Adding a concept

1. Find the page in `src/outline.ts`, or add it. Its id is `<part-slug>/<slugified-title>`,
   for example `data-structures/b-trees`.
2. Create `src/content/docs/<id>.mdx`:

   ```mdx
   ---
   description: One sentence that says what it is and why it matters.
   difficulty: beginner # or intermediate, advanced
   ---

   Opening paragraph: the problem this concept solves.

   ## The picture
   ```

The title comes from the outline, and the description is shown under it, so start
the body with prose rather than a heading.

Link to other concepts with site-absolute paths: `[arrays](/data-structures/arrays/)`.
A link to a planned page renders as plain dotted text until that page is written.
A link to a page that is not in the outline fails the build.

### Page shape

The existing pages follow roughly this order, which is worth keeping:

1. The problem the concept solves, in a paragraph.
2. A picture of the structure.
3. Each operation as a worked example, step by step.
4. The costs (`<Ops>`).
5. A short implementation.
6. Trade-offs and where it is used in real systems.
7. Key takeaways.

### Components

```mdx
<ArrayViz values={[2, 5, 8, null]} highlight={[1]} alt={[2]} dim={[0]}
  pointers={{ lo: 0, hi: 2 }} addr={{ base: 0x1000, size: 4 }} caption="..." />

<LinkedList values={[12, 99, 37]} labels={{ head: 0 }} highlight={[1]} doubly />

<Tree root={{ k: 8, c: [{ k: 3, c: [1, 6] }, { k: 10, c: [null, 14] }] }}
  highlight={[8, 3]} alt={[6]} />

<Tree btree root={{ k: [10, 20], c: [[3, 7], [12, 15, 18], [25, 30]] }} />

<HashTable buckets={[['cat', 'act'], [], ['dog']]} highlight={0} alt={['act']}
  input={{ key: 'act', note: '312 % 8 = 0' }} />

<Ops items={[['Search', 'O(log n)'], ['Insert', 'O(1)', 'amortized']]} />

<Steps>
<Step title="First, ...">

Markdown and diagrams go here.

</Step>
</Steps>

<Aside type="tip" title="Rule of thumb">

Also `note` (the default) and `warning`.

</Aside>
```

`highlight` is the blue emphasis and `alt` the orange one. In a tree node, a
number is a leaf, an array is one multi-key node, `null` is an empty child slot
and `{ k, c }` is a node with children.

## Deploying

`.github/workflows/deploy.yml` builds and publishes on every push to `main`. In
the repository settings, set **Pages → Build and deployment → Source** to
**GitHub Actions**.

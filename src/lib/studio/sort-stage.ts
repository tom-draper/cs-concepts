// The sorting demo as a 3D scene: each value is a stack of voxel bricks
// standing on a pad on the studio board. Between steps the stacks move with
// the animation principles: they crouch before a jump (anticipation), stretch
// in the air and squash on landing, travel along arcs, overshoot and wobble
// (follow-through), and their upper bricks trail the lower ones (overlapping
// action).

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { SortStep } from '../sort-traces';
import { arc, clamp, easeOut, hop, lerp, overshoot, span, wobble } from './motion';
import { MONO, Studio, makeBoard, makeRuler, makeTag, textTexture, type Palette } from './studio';

const PITCH = 0.46;
const BRICK = 0.32;
const GAP = 0.014;

/**
 * Follow each value from one step to the next, so a stack that moves is drawn
 * as the same stack travelling rather than two stacks changing height.
 * Returns, for every step, which stack id stands in each slot.
 */
export function trackStacks(steps: SortStep[]): number[][] {
  const ids: number[][] = [steps[0].values.map((_, i) => i)];
  for (let s = 1; s < steps.length; s++) {
    const before = steps[s - 1].values;
    const after = steps[s].values;
    const prev = ids[s - 1];
    const next: Array<number | undefined> = after.map(() => undefined);
    const used = new Set<number>();
    const moved = new Set(steps[s].moved);
    // Anything that kept its value and was not written to stays put.
    after.forEach((value, i) => {
      if (value === before[i] && !moved.has(i)) {
        next[i] = prev[i];
        used.add(i);
      }
    });
    // A written slot takes the nearest unclaimed stack holding its value.
    after.forEach((value, i) => {
      if (next[i] !== undefined) return;
      let best = -1;
      before.forEach((v, j) => {
        if (v === value && !used.has(j) && (best < 0 || Math.abs(j - i) < Math.abs(best - i))) best = j;
      });
      if (best >= 0) {
        next[i] = prev[best];
        used.add(best);
      }
    });
    // Whatever is left changes height in place (merge sort copies values).
    const spare = prev.filter((_, j) => !used.has(j));
    ids.push(next.map((id) => id ?? spare.shift()!));
  }
  return ids;
}

interface Pose {
  slot: number;
  value: number;
}

type Tone = 'plain' | 'compare' | 'moved' | 'sorted';

export interface SortStageOptions {
  pivotLabel?: string;
}

export class SortStage {
  private studio: Studio;
  private n: number;
  private maxValue: number;
  private steps: SortStep[] = [];
  private ids: number[][] = [];
  private from = 0;
  private to = 0;
  private started = 0;
  private duration = 0.68;
  private now = 0;

  private bricks: THREE.InstancedMesh;
  private pads: THREE.InstancedMesh;
  private padTops: THREE.InstancedMesh;
  private labels: THREE.Sprite[] = [];
  private labelCache = new Map<string, THREE.Texture>();
  private colors: THREE.Color[] = [];
  private tag: ReturnType<typeof makeTag>;
  private tagX = 0;
  private tagShown = 0;
  private indexStrip: THREE.Mesh;
  private ruler: THREE.Mesh;
  private board: ReturnType<typeof makeBoard>;
  private unit: number;
  private matrix = new THREE.Matrix4();
  private scratch = new THREE.Color();

  constructor(host: HTMLElement, n: number, maxValue: number, { pivotLabel }: SortStageOptions = {}) {
    this.n = n;
    this.maxValue = maxValue;
    // Keep the tallest stack around the same height whatever the values are.
    this.unit = Math.min(0.12, 1.15 / maxValue);
    const width = n * PITCH + 0.9;
    const depth = 1.9;

    this.studio = new Studio(host, {
      distance: Math.max(5.6, width * 1.22),
      target: new THREE.Vector3(0, 0.3, 0.05),
      yaw: 24,
      pitch: 24,
      yawRange: 34,
      pitchRange: [8, 58],
      minAspect: 1.6,
      floor: { y: -0.9, width, depth },
    });
    const palette = this.studio.palette;
    const world = this.studio.world;

    this.board = makeBoard(width, depth, palette, {
      keys: [
        [-0.72, Math.round(width / 0.1)],
        [0.74, Math.round(width / 0.1)],
      ],
    });
    world.add(this.board.group);

    this.ruler = makeRuler(width - 0.3, palette, { depth: 0.18 });
    this.ruler.position.set(0, 0.004, -0.5);
    world.add(this.ruler);

    // A pad under every slot: an ink base with a white top, as in the reference.
    const padGeometry = new RoundedBoxGeometry(BRICK + 0.08, 0.05, BRICK + 0.08, 2, 0.015);
    this.pads = new THREE.InstancedMesh(
      padGeometry,
      new THREE.MeshStandardMaterial({ color: palette.ink, roughness: 0.55 }),
      n,
    );
    this.padTops = new THREE.InstancedMesh(
      new RoundedBoxGeometry(BRICK + 0.02, 0.02, BRICK + 0.02, 2, 0.008),
      new THREE.MeshStandardMaterial({ color: palette.board, roughness: 0.5 }),
      n,
    );
    this.pads.receiveShadow = this.padTops.receiveShadow = true;
    for (let i = 0; i < n; i++) {
      this.matrix.makeTranslation(this.slotX(i), 0.025, 0);
      this.pads.setMatrixAt(i, this.matrix);
      this.matrix.makeTranslation(this.slotX(i), 0.056, -0.012);
      this.padTops.setMatrixAt(i, this.matrix);
    }
    world.add(this.pads, this.padTops);

    // Slot numbers along the front edge.
    this.indexStrip = new THREE.Mesh(
      new THREE.PlaneGeometry(n * PITCH, 0.16),
      new THREE.MeshBasicMaterial({ transparent: true, toneMapped: false }),
    );
    this.indexStrip.rotation.x = -Math.PI / 2;
    this.indexStrip.position.set(0, 0.004, 0.4);
    world.add(this.indexStrip);
    this.drawIndexStrip(palette);

    const maxBricks = maxValue;
    this.bricks = new THREE.InstancedMesh(
      new RoundedBoxGeometry(BRICK, 1, BRICK, 3, 0.035),
      new THREE.MeshStandardMaterial({ roughness: 0.42, metalness: 0 }),
      n * maxBricks,
    );
    this.bricks.castShadow = true;
    this.bricks.receiveShadow = true;
    this.bricks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < n * maxBricks; i++) this.bricks.setColorAt(i, palette.tile);
    world.add(this.bricks);

    for (let id = 0; id < n; id++) {
      this.colors.push(palette.tile.clone());
      const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ depthWrite: false, toneMapped: false }));
      sprite.scale.set(0.3, 0.3 * 0.62, 1);
      sprite.renderOrder = 2;
      this.labels.push(sprite);
      world.add(sprite);
    }

    this.tag = makeTag(pivotLabel?.toUpperCase() ?? 'PIVOT', palette, { width: 0.62, pole: 0.28 });
    this.tag.group.visible = false;
    world.add(this.tag.group);

    this.studio.onTheme((next) => this.retheme(next));
    this.studio.start((t) => this.frame(t));
  }

  get canvas() {
    return this.studio.canvas;
  }

  /** Load a new run of the algorithm. */
  load(steps: SortStep[]) {
    this.steps = steps;
    this.ids = trackStacks(steps);
    this.from = this.to = 0;
    this.started = -Infinity;
  }

  /** Show step `index`, animating if it is next to the current one. */
  show(index: number) {
    const adjacent = Math.abs(index - this.to) === 1 && !this.studio.reducedMotion;
    this.from = adjacent ? this.to : index;
    this.to = index;
    this.started = this.now;
  }

  dispose() {
    this.studio.dispose();
    this.labelCache.forEach((texture) => texture.dispose());
  }

  private slotX(slot: number) {
    return (slot - (this.n - 1) / 2) * PITCH;
  }

  private pose(step: number, id: number): Pose {
    const slot = this.ids[step].indexOf(id);
    return { slot, value: this.steps[step].values[slot] };
  }

  private tone(step: SortStep, slot: number): Tone {
    if (step.compare.includes(slot)) return 'compare';
    if (step.moved.includes(slot)) return 'moved';
    if (step.sorted.includes(slot)) return 'sorted';
    return 'plain';
  }

  private toneColor(tone: Tone, out: boolean, palette: Palette) {
    const c = this.scratch;
    if (tone === 'compare') c.copy(palette.clay);
    else if (tone === 'moved') c.set(palette.dark ? '#f0a888' : '#efb49b');
    else if (tone === 'sorted') c.set(palette.dark ? '#5b5852' : '#2b2a27');
    else c.copy(palette.tile);
    // Stacks outside the range being worked on sink back into the board colour.
    if (out) c.lerp(palette.dark ? new THREE.Color('#1c1b19') : new THREE.Color('#dcd8cf'), 0.55);
    return c;
  }

  private frame(t: number) {
    const dt = t - this.now;
    this.now = t;
    if (!this.steps.length) return;
    const palette = this.studio.palette;
    const p = this.from === this.to ? 1 : clamp((t - this.started) / this.duration);
    const target = this.steps[this.to];
    const maxBricks = this.maxValue;
    const k = 1 - Math.exp(-dt * 14);

    for (let id = 0; id < this.n; id++) {
      const a = this.pose(this.from, id);
      const b = this.pose(this.to, id);
      const travels = a.slot !== b.slot;
      const compared = target.compare.includes(b.slot) && this.from !== this.to;
      const grows = a.value !== b.value && !travels;

      // Where the stack is and how it is squashed.
      let x = this.slotX(b.slot);
      let y = 0.066;
      let z = 0;
      let sy = 1;
      let sxz = 1;
      let lean = 0;
      if (travels) {
        const motion = hop(p);
        const dist = b.slot - a.slot;
        x = lerp(this.slotX(a.slot), this.slotX(b.slot), motion.travel);
        // Swapping pairs arc past each other: one towards the camera, one away.
        y += motion.lift * (0.42 + 0.06 * Math.abs(dist));
        z = motion.lift * (dist > 0 ? 0.42 : -0.42);
        sy = motion.scale.y;
        sxz = motion.scale.xz;
        // The top of the stack trails behind the base while it accelerates.
        const ahead = hop(Math.min(1, p + 0.02)).travel - motion.travel;
        lean = -clamp(ahead * dist * 12, -1, 1) * 0.35;
      } else if (compared) {
        // A small hop in place says "look at me".
        const motion = hop(p, { depth: 0.12 });
        y += motion.lift * 0.14;
        sy = motion.scale.y;
        sxz = motion.scale.xz;
      } else if (grows) {
        const u = span(p, 0.1, 1);
        sy = 1 + 0.12 * wobble(u, 2, 0.3);
        sxz = 1 / Math.sqrt(sy);
      }

      // Ease the colour towards this step's tone.
      const out = !!target.range && (b.slot < target.range[0] || b.slot > target.range[1]);
      const tone = this.tone(target, b.slot);
      this.colors[id].lerp(this.toneColor(tone, out, palette), this.from === this.to ? 1 : k);

      // Bricks: the lower ones keep up with the base, the upper ones lag.
      const shown = grows ? Math.max(a.value, b.value) : b.value;
      const h = this.unit;
      let top = y;
      for (let level = 0; level < maxBricks; level++) {
        const index = id * maxBricks + level;
        if (level >= shown) {
          this.matrix.makeScale(0, 0, 0);
          this.bricks.setMatrixAt(index, this.matrix);
          continue;
        }
        let scale = 1;
        let drop = 0;
        if (grows && level >= Math.min(a.value, b.value)) {
          // New bricks drop in one after another; spare ones shrink away.
          const order = level - Math.min(a.value, b.value);
          const u = span(p, 0.08 * order, 0.08 * order + 0.6);
          if (b.value > a.value) {
            drop = (1 - overshoot(u, 0.12)) * 0.7;
            scale = clamp(u * 3);
          } else {
            scale = 1 - easeOut(u);
          }
        }
        const frac = (level + 0.5) / maxBricks;
        const bx = x + lean * frac * frac;
        const by = y + (level * h + h / 2) * sy + drop;
        this.matrix
          .makeScale(sxz * scale, (h - GAP) * sy * scale, sxz * scale)
          .setPosition(bx, by, z);
        this.bricks.setMatrixAt(index, this.matrix);
        this.bricks.setColorAt(index, this.colors[id]);
        if (scale > 0.5) top = by + (h / 2) * sy;
      }

      const label = this.labels[id];
      const map = this.labelTexture(String(b.value), palette);
      if (label.material.map !== map) {
        label.material.map = map;
        label.material.needsUpdate = true;
      }
      label.position.set(x + lean, top + 0.2, z);
    }
    this.bricks.instanceMatrix.needsUpdate = true;
    if (this.bricks.instanceColor) this.bricks.instanceColor.needsUpdate = true;

    // The pivot flag follows its stack, hopping when it changes owner.
    if (target.pivot !== undefined) {
      const goal = this.slotX(target.pivot);
      if (!this.tag.group.visible) this.tagX = goal;
      this.tagX = lerp(this.tagX, goal, k);
      this.tagShown = lerp(this.tagShown, 1, k);
      this.tag.group.visible = true;
      const pid = this.ids[this.to][target.pivot];
      const height = this.steps[this.to].values[target.pivot] * this.unit;
      const bob = arc(span(p, 0, 0.6), 0.06);
      this.tag.group.position.set(this.tagX, 0.08 + height + 0.42 + bob, 0);
      this.tag.group.scale.setScalar(this.tagShown);
      this.labels[pid].visible = false;
    } else {
      this.tagShown = lerp(this.tagShown, 0, k);
      this.tag.group.scale.setScalar(this.tagShown);
      if (this.tagShown < 0.02) this.tag.group.visible = false;
    }
    this.labels.forEach((label, id) => {
      if (target.pivot === undefined || this.ids[this.to][target.pivot] !== id) label.visible = true;
    });
    // Keep the flag facing the camera.
    this.tag.group.quaternion.copy(this.studio.camera.quaternion);
  }

  private labelTexture(text: string, palette: Palette) {
    const key = `${text}:${palette.dark}`;
    let texture = this.labelCache.get(key);
    if (!texture) {
      texture = textTexture(
        (ctx, w, h) => {
          ctx.fillStyle = palette.boardCss;
          ctx.strokeStyle = palette.dark ? '#000' : '#1d1c1a';
          ctx.lineWidth = 6;
          ctx.beginPath();
          ctx.roundRect(4, 4, w - 8, h - 8, 14);
          ctx.fill();
          ctx.stroke();
          ctx.fillStyle = palette.text;
          ctx.font = `800 ${h * 0.56}px ${MONO}`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(text, w / 2, h / 2 + 3);
        },
        128,
        80,
      );
      this.labelCache.set(key, texture);
    }
    return texture;
  }

  private drawIndexStrip(palette: Palette) {
    const material = this.indexStrip.material as THREE.MeshBasicMaterial;
    material.map?.dispose();
    material.map = textTexture(
      (ctx, w, h) => {
        const cell = w / this.n;
        ctx.fillStyle = palette.text2;
        ctx.font = `700 ${h * 0.5}px ${MONO}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        for (let i = 0; i < this.n; i++) {
          ctx.fillText(`[${i}]`, cell * (i + 0.5), h / 2);
        }
      },
      Math.round(256 * this.n),
      Math.round((256 * 0.16) / PITCH),
    );
    material.needsUpdate = true;
  }

  private retheme(palette: Palette) {
    const world = this.studio.world;
    world.remove(this.board.group);
    this.board = makeBoard(this.n * PITCH + 0.9, 1.9, palette, {
      keys: [
        [-0.72, Math.round((this.n * PITCH + 0.9) / 0.1)],
        [0.74, Math.round((this.n * PITCH + 0.9) / 0.1)],
      ],
    });
    world.add(this.board.group);
    (this.pads.material as THREE.MeshStandardMaterial).color.copy(palette.ink);
    (this.padTops.material as THREE.MeshStandardMaterial).color.copy(palette.board);
    world.remove(this.ruler);
    this.ruler = makeRuler(this.n * PITCH + 0.6, palette, { depth: 0.18 });
    this.ruler.position.set(0, 0.004, -0.5);
    world.add(this.ruler);
    this.drawIndexStrip(palette);
    // Snap colours on the next frame.
    this.started = -Infinity;
    this.from = this.to;
  }
}

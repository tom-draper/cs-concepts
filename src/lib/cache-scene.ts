// The WebGL half of <CacheHierarchy>. The levels stand in a row leading away
// from the core, farther for slower, and each read is drawn as a request
// travelling out and a whole line travelling back.
import * as THREE from 'three';
import { levels, RAM, RAM_LINES, WORDS_PER_LINE, type Read } from './cache-hierarchy';
import { ease, glowTexture, PlateScene, type PlateOptions } from './plate-scene';

interface Options extends Omit<PlateOptions, 'fov' | 'autoRotate'> {
  onPick?: (word: number) => void;
}

// Where each level stands along the corridor, and how its slots are arranged.
const CORE_X = -5.8;
const stations = [
  { x: -3.9, cols: 1 },
  { x: -2.1, cols: 1 },
  { x: 0.3, cols: 2 },
  { x: 4.6, cols: 4 },
];
const CELL = { w: 0.17, h: 0.11, d: 0.24, gap: 0.035 };
const BAR_W = WORDS_PER_LINE * (CELL.w + CELL.gap);
const COL_W = BAR_W + 0.18;
const ROW_D = 0.36;
const FLY_Y = 0.75;
// The direction the camera looks from, relative to the middle of the row.
const VIEW = new THREE.Vector3(-0.25, 0.5, 0.83).normalize();

// Each memory line keeps one colour wherever it is copied, running through
// the three process inks.
const INKS = [new THREE.Color(0x3dd8f0), new THREE.Color(0xff5cab), new THREE.Color(0xffd54a)];
function lineInk(line: number) {
  const t = (line / (RAM_LINES - 1)) * (INKS.length - 1);
  const i = Math.min(Math.floor(t), INKS.length - 2);
  return INKS[i].clone().lerp(INKS[i + 1], t - i);
}
const EMPTY = new THREE.Color(0x2a3552);

interface Slot {
  origin: THREE.Vector3;
  cells: THREE.Mesh[];
  line: number | null;
}

interface Flight {
  read: Read;
  start: number;
  out: number;
  back: number;
  from: THREE.Vector3;
  to: THREE.Vector3;
  filled: Set<number>;
  done: () => void;
}

export class CacheScene extends PlateScene {
  private slots: Slot[][] = [];
  private cells: THREE.Mesh[] = [];
  private packet: THREE.Group;
  private bar = new THREE.Group();
  private flight?: Flight;
  private speed = 1;
  private hover: number | null = null;
  private hoverLabel: HTMLElement;
  private status: HTMLElement;
  private levelLabels: { el: HTMLElement; at: THREE.Vector3 }[] = [];
  private corePoint = new THREE.Vector3(CORE_X, FLY_Y, 0);
  private core: THREE.Mesh;

  constructor(host: HTMLElement, labelLayer: HTMLElement, options: Options) {
    super(host, labelLayer, { ...options, autoRotate: false, fov: [34, 40] });

    // Face the row from the core's end, so the levels recede as they slow down.
    this.controls.target.set(-0.4, 0, -1);
    this.controls.minDistance = 8;
    this.controls.maxDistance = 22;
    this.controls.maxPolarAngle = 1.35;

    this.scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x1a1030, 1.5));
    const key = new THREE.DirectionalLight(0xffffff, 2);
    key.position.set(-3, 8, 6);
    this.scene.add(key);

    const glow = glowTexture();
    this.buildBus();
    this.core = this.buildCore();
    stations.forEach((station, level) => this.buildStation(station, level));

    this.packet = new THREE.Group();
    this.packet.add(
      new THREE.Mesh(new THREE.SphereGeometry(0.09, 24, 12), new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 3, 3) })),
    );
    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glow, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    halo.scale.setScalar(0.8);
    this.packet.add(halo);
    this.packet.visible = false;

    const cellGeometry = new THREE.BoxGeometry(CELL.w, CELL.h, CELL.d);
    for (let i = 0; i < WORDS_PER_LINE; i++) {
      const cell = new THREE.Mesh(cellGeometry, new THREE.MeshStandardMaterial({ roughness: 0.4 }));
      cell.position.x = (i - (WORDS_PER_LINE - 1) / 2) * (CELL.w + CELL.gap);
      this.bar.add(cell);
    }
    this.bar.visible = false;
    this.scene.add(this.packet, this.bar);

    // The status line sits in a corner of the stage rather than in the scene.
    this.status = this.label('cache-status', '');
    this.hoverLabel = this.label('cache-hover', '');
    this.hoverLabel.hidden = true;

    if (options.interactive) {
      this.listenForPicks<number>(
        () => this.cells,
        (word) => options.onPick?.(word),
        (word) => (this.hover = word),
      );
    }
    this.ready();
  }

  /** Back the camera off until the whole row, core to RAM, fits across the stage. */
  protected resized(aspect: number) {
    const row = stations[RAM].x - CORE_X + 6;
    const halfFov = THREE.MathUtils.degToRad(this.camera.fov / 2);
    const distance = Math.max(11, row / (2 * Math.tan(halfFov) * aspect));
    this.camera.position.copy(this.controls.target).addScaledVector(VIEW, distance);
  }

  private label(className: string, html: string) {
    const el = document.createElement('span');
    el.className = className;
    el.innerHTML = html;
    this.labelLayer.append(el);
    return el;
  }

  private buildBus() {
    const bus = new THREE.Mesh(
      new THREE.BoxGeometry(stations[RAM].x - CORE_X, 0.015, 0.05),
      new THREE.MeshBasicMaterial({ color: 0x3a4870 }),
    );
    bus.position.set((stations[RAM].x + CORE_X) / 2, 0, 0);
    this.scene.add(bus);
  }

  private buildCore() {
    const core = new THREE.Mesh(
      new THREE.BoxGeometry(0.9, 0.22, 0.9),
      new THREE.MeshStandardMaterial({ color: 0x2b3657, emissive: 0x9fb4ff, emissiveIntensity: 0.15, roughness: 0.3, metalness: 0.4 }),
    );
    core.position.set(CORE_X, 0.11, 0);
    const edges = new THREE.LineSegments(
      new THREE.EdgesGeometry(core.geometry),
      new THREE.LineBasicMaterial({ color: 0xe6eaf4 }),
    );
    core.add(edges);
    this.scene.add(core);
    this.levelLabels.push({ el: this.label('cache-level', '<b>Core</b>'), at: new THREE.Vector3(CORE_X, 0, 0.95) });
    return core;
  }

  private buildStation({ x, cols }: (typeof stations)[number], level: number) {
    const count = levels[level].lines;
    const rows = Math.ceil(count / cols);
    const width = cols * COL_W + 0.2;
    const depth = rows * ROW_D + 0.25;

    const tray = new THREE.Mesh(
      new THREE.BoxGeometry(width, 0.05, depth),
      new THREE.MeshStandardMaterial({ color: 0x18213a, roughness: 0.8 }),
    );
    tray.position.set(x, 0, 0);
    tray.add(
      new THREE.LineSegments(new THREE.EdgesGeometry(tray.geometry), new THREE.LineBasicMaterial({ color: 0x3a4870 })),
    );
    this.scene.add(tray);

    const geometry = new THREE.BoxGeometry(CELL.w, CELL.h, CELL.d);
    const slots: Slot[] = [];
    for (let slot = 0; slot < count; slot++) {
      const col = slot % cols;
      const row = Math.floor(slot / cols);
      const origin = new THREE.Vector3(
        x + (col - (cols - 1) / 2) * COL_W,
        0.03 + CELL.h / 2,
        (row - (rows - 1) / 2) * ROW_D,
      );
      const cells = Array.from({ length: WORDS_PER_LINE }, (_, i) => {
        const cell = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ roughness: 0.4, transparent: true }));
        cell.position.copy(origin).setX(origin.x + (i - (WORDS_PER_LINE - 1) / 2) * (CELL.w + CELL.gap));
        cell.userData.flash = -1e9;
        this.scene.add(cell);
        this.cells.push(cell);
        return cell;
      });
      const entry: Slot = { origin, cells, line: null };
      this.paint(entry, level === RAM ? slot : null);
      slots.push(entry);
    }
    this.slots.push(slots);

    const { name, cycles } = levels[level];
    this.levelLabels.push({
      el: this.label('cache-level', `<b>${name}</b><small>${cycles} cycles</small>`),
      at: new THREE.Vector3(x, 0, depth / 2 + 0.4),
    });
  }

  private paint(slot: Slot, line: number | null) {
    slot.line = line;
    const ink = line === null ? EMPTY : lineInk(line);
    slot.cells.forEach((cell, i) => {
      const material = cell.material as THREE.MeshStandardMaterial;
      material.color.copy(ink);
      material.emissive.copy(line === null ? EMPTY : ink);
      material.opacity = line === null ? 0.5 : 1;
      cell.userData.pick = line === null ? undefined : line * WORDS_PER_LINE + i;
      cell.userData.base = line === null ? 0 : 0.3;
    });
  }

  private flash(slot: Slot, word: number, now: number) {
    for (const cell of slot.cells) cell.userData.flash = cell.userData.pick === word ? now : now - 250;
  }

  /** Finish any read still in the air, so the picture never falls behind the model. */
  private settle() {
    const f = this.flight;
    if (!f) return;
    this.land(f.read, performance.now());
    f.done();
  }

  /** Empty every cache, keeping RAM as it is. */
  clear() {
    this.settle();
    this.packet.visible = this.bar.visible = false;
    this.slots.slice(0, RAM).forEach((slots) => slots.forEach((slot) => this.paint(slot, null)));
    this.status.textContent = '';
    this.kick();
  }

  /** Animate one read. Resolves when the line has reached the core. */
  play(read: Read, instant: boolean, fast: boolean): Promise<void> {
    this.settle();
    this.speed = fast ? 4 : 1;
    const target = this.slots[read.servedBy][read.slot];
    this.status.innerHTML = `Reading word <b>${read.word}</b>`;
    if (instant || this.options.reducedMotion) {
      this.land(read, performance.now());
      this.kick();
      return Promise.resolve();
    }
    return new Promise((done) => {
      const time = (120 + read.cycles * 1.6) / this.speed;
      this.flight = {
        read,
        start: performance.now(),
        out: time,
        back: time,
        from: this.corePoint.clone(),
        to: target.origin.clone().setY(FLY_Y),
        filled: new Set(),
        done: () => {
          this.flight = undefined;
          done();
        },
      };
      this.kick();
    });
  }

  /** Apply a read's copies all at once. */
  private land(read: Read, now: number) {
    this.flash(this.slots[read.servedBy][read.slot], read.word, now);
    for (const fill of read.fills) {
      const slot = this.slots[fill.level][fill.slot];
      this.paint(slot, read.line);
      this.flash(slot, read.word, now);
    }
    this.finish(read, now);
  }

  private finish(read: Read, now: number) {
    this.core.userData.flash = now;
    this.status.innerHTML = `Word <b>${read.word}</b> from ${levels[read.servedBy].name}, ${read.cycles} cycles`;
    this.packet.visible = this.bar.visible = false;
  }

  protected frame(now: number) {
    const f = this.flight;
    if (f) {
      const t = now - f.start;
      const { read } = f;
      if (t < f.out) {
        this.packet.visible = true;
        this.packet.position.lerpVectors(f.from, f.to, ease(t / f.out));
      } else {
        if (!f.filled.has(-1)) {
          // The request arrives: the level that holds the line lights up.
          f.filled.add(-1);
          this.flash(this.slots[read.servedBy][read.slot], read.word, now);
          this.packet.visible = false;
          this.bar.visible = true;
          const ink = lineInk(read.line);
          this.bar.children.forEach((child, i) => {
            const material = (child as THREE.Mesh).material as THREE.MeshStandardMaterial;
            const wanted = read.line * WORDS_PER_LINE + i === read.word;
            material.color.copy(wanted ? new THREE.Color(0xffffff) : ink);
            material.emissive.copy(wanted ? new THREE.Color(0xffffff) : ink);
            material.emissiveIntensity = wanted ? 1.6 : 0.5;
          });
        }
        const u = Math.min(1, (t - f.out) / f.back);
        this.bar.position.lerpVectors(f.to, f.from, ease(u));
        // Drop a copy into each faster level as the line passes over it.
        for (const fill of read.fills) {
          if (f.filled.has(fill.level)) continue;
          if (this.bar.position.x <= stations[fill.level].x + 0.2) {
            f.filled.add(fill.level);
            const slot = this.slots[fill.level][fill.slot];
            this.paint(slot, read.line);
            this.flash(slot, read.word, now);
          }
        }
        if (u === 1) {
          this.finish(read, now);
          f.done();
        }
      }
    }

    for (const cell of this.cells) {
      const material = cell.material as THREE.MeshStandardMaterial;
      const glow = Math.max(0, 1 - (now - cell.userData.flash) / 600);
      material.emissiveIntensity = cell.userData.base + glow * 1.8;
      const lift = cell.userData.pick !== undefined && cell.userData.pick === this.hover ? 1.4 : 1;
      cell.scale.set(lift, lift + glow * 0.8, lift);
    }
    const coreGlow = Math.max(0, 1 - (now - (this.core.userData.flash ?? -1e9)) / 700);
    (this.core.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.15 + coreGlow * 1.2;
  }

  protected placeLabels() {
    for (const { el, at } of this.levelLabels) this.pin(el, at);
    const hovered = this.cells.find((c) => c.userData.pick === this.hover);
    this.hoverLabel.hidden = !hovered;
    if (hovered) {
      const word = this.hover!;
      this.hoverLabel.textContent = `Read word ${word}, line ${Math.floor(word / WORDS_PER_LINE)}`;
      this.pin(this.hoverLabel, hovered.position.clone().setY(0.55));
    }
  }
}

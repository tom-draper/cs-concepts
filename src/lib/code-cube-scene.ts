// The WebGL half of <CodeCube>. It draws whatever state it is handed and reports
// clicks on corners; the code logic lives in code-cube.ts.
//
// Every corner has a place in four dimensions, one axis per bit. Three-bit
// codes keep the fourth axis flat, which collapses the tesseract onto an
// ordinary cube. Switching to four bits pulls the two halves apart along the
// fourth axis, then turns them through it, and the result is projected into 3D
// the way a cube casts a square shadow.
import * as THREE from 'three';
import { cornersOf, decodesTo, nearest, walk, type Bits, type Code, type Outcome } from './code-cube';
import { ease, glowTexture, PlateScene, span, Trail, type PlateOptions } from './plate-scene';

export interface CubeState {
  code: Code;
  sent: string;
  /** Every word the packet has visited since it was sent, one flip apart. */
  path: string[];
  decoded: string | null;
  outcome: Outcome;
}

interface Options extends Omit<PlateOptions, 'fov'> {
  onPick?: (word: string) => void;
}

const STEP_MS = 420;
const MORPH_MS = 1600;
const VIEW_DISTANCE = 3;
const corners = cornersOf(4);
const OUTCOME_INK: Record<Outcome, string> = {
  intact: 'spark',
  corrected: 'good',
  detected: 'warn',
  undetected: 'bad',
  miscorrected: 'bad',
};

const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);
const weight = (word: string) => [...word].filter((b) => b === '1').length;
const smooth = (t: number) => {
  const c = Math.min(1, Math.max(0, t));
  return c * c * (3 - 2 * c);
};

interface Node {
  mesh: THREE.Mesh;
  halo: THREE.Sprite;
  hit: THREE.Mesh;
  label: HTMLElement;
  digits: HTMLElement;
}

interface Edge {
  /** The end with the bit clear. */
  a: string;
  b: string;
  bit: number;
  mesh: THREE.Mesh;
  tube: THREE.Mesh;
}

export class CodeCubeScene extends PlateScene {
  private cube = new THREE.Group();
  private glow = glowTexture();
  private nodes = new Map<string, Node>();
  private edges: Edge[] = [];
  private axisLabels: { el: HTMLElement; bit: number }[] = [];
  private sentRing: THREE.Mesh;
  private packet = new THREE.Group();
  private packetCore: THREE.Mesh;
  private packetHalo: THREE.Sprite;
  private trail: Trail;
  private echo: THREE.Mesh;
  private ties: THREE.Mesh[] = [];
  private arrows: { from: string; to: string; tube: THREE.Mesh; tip: THREE.Mesh }[] = [];
  private arrowMaterial = new THREE.MeshStandardMaterial({ roughness: 0.4 });

  private state?: CubeState;
  private bits: Bits = 3;
  private shownPath: string[] = [];
  private queue: string[] = [];
  private leg?: { from: string; to: string; start: number };
  private at = '0000';
  private echoStart = 0;
  private hover: string | null = null;
  private pointerInside = false;

  /** 0 is a flat cube, 1 a full tesseract. */
  private morph = 0;
  private morphFrom = 0;
  private morphStart = -1e9;
  /** How far the figure has turned through the fourth dimension, in radians. */
  private turn = 0;
  private turnSpeed = 0;
  private lastFrame = 0;
  private revealStart: number | null = null;
  private places = new Map<string, THREE.Vector3>();

  constructor(host: HTMLElement, labelLayer: HTMLElement, options: Options) {
    super(host, labelLayer, { ...options, fov: [32, 44] });

    // Off every body diagonal, so no two corners start out stacked on screen.
    this.camera.position.set(8.3, 3.5, 1.4);
    this.controls.minDistance = 6;
    this.controls.maxDistance = 16;
    this.key.position.set(3, 9, 4);
    this.scene.add(this.cube);
    this.shadowFloor(-1.9, 14);

    this.buildEdges();
    this.buildNodes();
    this.buildAxisLabels();

    this.sentRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.3, 0.018, 12, 64),
      new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.9 }),
    );
    this.cube.add(this.sentRing);

    this.packetCore = new THREE.Mesh(new THREE.SphereGeometry(0.1, 32, 16), new THREE.MeshBasicMaterial());
    this.packetHalo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, transparent: true, depthWrite: false }));
    this.packetHalo.scale.setScalar(0.9);
    this.packet.add(this.packetCore, this.packetHalo);
    this.cube.add(this.packet);
    this.trail = new Trail(this.cube, this.glow, 0.32);

    this.echo = new THREE.Mesh(new THREE.SphereGeometry(0.075, 16, 8), new THREE.MeshBasicMaterial());
    this.echo.visible = false;
    this.cube.add(this.echo);

    if (options.interactive) {
      this.listenForPicks<string>(
        () => [...this.nodes.values()].filter((n) => n.mesh.visible).map((n) => n.hit),
        (word) => options.onPick?.(word.slice(0, this.bits)),
        (word) => (this.hover = word),
      );
    }
    // Hold the turn through the fourth dimension while the pointer is over the
    // figure, so corners stay still long enough to click.
    const canvas = this.renderer.domElement;
    canvas.addEventListener('pointerenter', () => (this.pointerInside = true));
    canvas.addEventListener('pointerleave', () => (this.pointerInside = false));
    this.ready();
  }

  private buildEdges() {
    const geometry = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true);
    for (const a of corners) {
      for (let bit = 0; bit < 4; bit++) {
        if (a[bit] !== '0') continue;
        const b = a.slice(0, bit) + '1' + a.slice(bit + 1);
        // Flat ink, like a printed line, so the bit colours stay true on paper.
        const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ transparent: true }));
        mesh.castShadow = true;
        // A wide, faint tube shown when the edge lies inside one codeword's
        // decoding region.
        const tube = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }));
        this.cube.add(mesh, tube);
        this.edges.push({ a, b, bit, mesh, tube });
      }
    }
  }

  private buildNodes() {
    const geometry = new THREE.SphereGeometry(1, 40, 20);
    const hitGeometry = new THREE.SphereGeometry(0.3, 8, 6);
    for (const word of corners) {
      const mesh = new THREE.Mesh(
        geometry,
        new THREE.MeshPhysicalMaterial({ roughness: 0.25, clearcoat: 1, clearcoatRoughness: 0.2 }),
      );
      mesh.castShadow = true;
      const halo = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.glow, transparent: true, depthWrite: false }));
      halo.scale.setScalar(5);
      mesh.add(halo);
      const hit = new THREE.Mesh(hitGeometry, new THREE.MeshBasicMaterial({ visible: false }));
      hit.userData.pick = word;
      this.cube.add(mesh, hit);

      const label = document.createElement('span');
      label.className = 'cc-label';
      const digits = document.createElement('span');
      label.append(digits);
      this.labelLayer.append(label);
      this.nodes.set(word, { mesh, halo, hit, label, digits });
    }
  }

  private buildAxisLabels() {
    for (let bit = 0; bit < 4; bit++) {
      const el = document.createElement('span');
      el.className = `cc-axis b${bit + 1}`;
      el.textContent = `bit ${bit + 1}`;
      this.labelLayer.append(el);
      this.axisLabels.push({ el, bit });
    }
  }

  protected themed() {
    const dark = this.dark;
    const inks = [1, 2, 3, 4].map((i) => this.ink(`bit-${i}`));
    for (const edge of this.edges) {
      (edge.mesh.material as THREE.MeshBasicMaterial).color.copy(inks[edge.bit]);
      const tube = edge.tube.material as THREE.MeshBasicMaterial;
      tube.color.copy(this.ink('ink'));
      tube.opacity = dark ? 0.07 : 0.06;
    }
    const spark = this.ink('spark');
    (this.packetCore.material as THREE.MeshBasicMaterial).color.copy(dark ? new THREE.Color(3, 3, 3) : spark);
    const halo = this.packetHalo.material as THREE.SpriteMaterial;
    halo.color.copy(spark);
    halo.opacity = dark ? 0.8 : 0.35;
    halo.blending = dark ? THREE.AdditiveBlending : THREE.NormalBlending;
    halo.needsUpdate = true;
    this.trail.paint(spark, dark);
    (this.sentRing.material as THREE.MeshBasicMaterial).color.copy(this.ink('ink'));
    for (const node of this.nodes.values()) {
      const material = node.halo.material as THREE.SpriteMaterial;
      material.blending = dark ? THREE.AdditiveBlending : THREE.NormalBlending;
      material.needsUpdate = true;
    }
    if (this.state) this.paintNodes(this.state);
    this.paintVerdict();
  }

  /** Where a corner is in 3D right now: turned in 4D, then projected. */
  private place(word: string): THREE.Vector3 {
    const [x, y, z, w4] = [...word].map((b) => (b === '1' ? 1 : -1));
    const w = w4 * this.morph;
    // Turn in the x-w plane, then a little in the z-w plane.
    const c = Math.cos(this.turn);
    const s = Math.sin(this.turn);
    const x1 = x * c - w * s;
    const w1 = x * s + w * c;
    const c2 = Math.cos(this.turn * 0.6);
    const s2 = Math.sin(this.turn * 0.6);
    const z1 = z * c2 - w1 * s2;
    const w2 = z * s2 + w1 * c2;
    const scale = VIEW_DISTANCE / (VIEW_DISTANCE - w2);
    return new THREE.Vector3(x1 * scale, y * scale, z1 * scale);
  }

  /** The 4-bit corner where a word of the current code lives. */
  private corner(word: string) {
    return word.length === 4 ? word : `${word}0`;
  }

  /** Corners with bit 4 set only exist once the fourth dimension is out. */
  private presence(word: string) {
    return word[3] === '1' ? smooth(this.morph * 1.6) : 1;
  }

  set(state: CubeState) {
    const previous = this.state;
    this.state = state;
    const { code, sent, path } = state;
    const received = path.at(-1)!;

    if (code.bits !== this.bits) {
      this.bits = code.bits;
      this.morphFrom = this.morph;
      this.morphStart = this.options.reducedMotion ? -1e9 : performance.now();
    }

    // A new send, or a path that does not extend the one on screen, starts over.
    const extends_ =
      previous &&
      previous.sent === sent &&
      previous.code === code &&
      path.length >= this.shownPath.length &&
      this.shownPath.every((w, i) => path[i] === w);
    if (!extends_ || this.options.reducedMotion) {
      this.queue = [];
      this.leg = undefined;
      this.at = this.corner(received);
    } else {
      this.queue.push(...path.slice(this.shownPath.length).map((w) => this.corner(w)));
    }
    this.shownPath = path;

    const lit = new Set<string>();
    for (let i = 1; i < path.length; i++) lit.add(edgeKey(this.corner(path[i - 1]), this.corner(path[i])));
    const inside = (from: string, to: string) =>
      code.words.includes(from) && !code.words.includes(to) && decodesTo(code, to) === from;
    for (const edge of this.edges) {
      edge.mesh.userData.lit = lit.has(edgeKey(edge.a, edge.b));
      const a = edge.a.slice(0, code.bits);
      const b = edge.b.slice(0, code.bits);
      edge.tube.userData.on = a !== b && (inside(a, b) || inside(b, a));
    }

    this.paintNodes(state);

    for (const ring of this.ties) {
      ring.geometry.dispose();
      this.cube.remove(ring);
    }
    this.ties = [];
    if (state.outcome === 'detected') {
      for (const word of nearest(code, received)) {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(0.25, 0.014, 8, 48),
          new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.95 }),
        );
        ring.userData.word = this.corner(word);
        this.cube.add(ring);
        this.ties.push(ring);
      }
    }

    for (const arrow of this.arrows) {
      arrow.tube.geometry.dispose();
      arrow.tip.geometry.dispose();
      this.cube.remove(arrow.tube, arrow.tip);
    }
    this.arrows = [];
    if (state.decoded && state.decoded !== received) {
      const steps = walk(received, state.decoded).map((w) => this.corner(w));
      for (let i = 1; i < steps.length; i++) {
        const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, 1, 12), this.arrowMaterial);
        const tip = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.22, 16), this.arrowMaterial);
        tube.castShadow = tip.castShadow = true;
        this.cube.add(tube, tip);
        this.arrows.push({ from: steps[i - 1], to: steps[i], tube, tip });
      }
    }
    this.paintVerdict();
    this.echoStart = performance.now() + this.queue.length * STEP_MS;
    this.kick();
  }

  private paintVerdict() {
    if (!this.state) return;
    const ink = this.ink(OUTCOME_INK[this.state.outcome]);
    this.arrowMaterial.color.copy(ink);
    this.arrowMaterial.emissive.copy(this.dark ? ink : new THREE.Color(0));
    this.arrowMaterial.emissiveIntensity = this.dark ? 0.8 : 0;
    (this.echo.material as THREE.MeshBasicMaterial).color.copy(ink);
    for (const ring of this.ties) (ring.material as THREE.MeshBasicMaterial).color.copy(this.ink('warn'));
  }

  private paintNodes({ code, sent, path }: CubeState) {
    const received = path.at(-1)!;
    const words = new Set(code.words.map((w) => this.corner(w)));
    const ink = this.ink('ink');
    const muted = this.ink('muted');
    for (const [word, node] of this.nodes) {
      const isCode = words.has(word);
      const material = node.mesh.material as THREE.MeshPhysicalMaterial;
      if (this.dark) {
        material.color.copy(isCode ? new THREE.Color(0xffffff) : muted);
        material.emissive.set(isCode ? 0xbfd0ff : 0x000000);
        material.emissiveIntensity = isCode ? 0.9 : 0;
      } else {
        material.color.copy(isCode ? ink : muted);
        material.emissive.set(0x000000);
      }
      node.mesh.userData.code = isCode;
      (node.halo.material as THREE.SpriteMaterial).color.copy(this.dark ? new THREE.Color(0xffffff) : ink);
      node.halo.userData.base = isCode ? (this.dark ? 0.35 : 0.06) : 0;
      const shown = word.slice(0, code.bits);
      node.digits.innerHTML = [...shown].map((b, i) => `<i class="b${i + 1}">${b}</i>`).join('');
      node.label.classList.toggle('is-code', isCode);
      node.label.classList.toggle('is-sent', word === this.corner(sent));
      node.label.classList.toggle('is-received', word === this.corner(received) && received !== sent);
      // Sixteen labels crowd a tesseract, so four-bit codes name only the
      // corners in play. The rest appear on hover.
      const inPlay =
        code.bits === 3 ||
        word === this.corner(sent) ||
        word === this.corner(received) ||
        (isCode && code.words.length <= 8) ||
        nearest(code, received).some((w) => this.corner(w) === word);
      node.label.dataset.quiet = String(!inPlay);
    }
  }

  protected frame(now: number) {
    const dt = Math.min(0.05, (now - (this.lastFrame || now)) / 1000);
    this.lastFrame = now;
    const motion = !this.options.reducedMotion;

    // The opening: corners appear outward from 0000, and each edge grows from
    // its nearer end once that corner is in place.
    if (this.revealStart === null && this.isRunning) this.revealStart = motion ? now : -1e9;
    const since = this.revealStart === null ? -1 : now - this.revealStart;
    const revealed = (word: string) => smooth((since - weight(word) * 220) / 380);
    const grown = (edge: Edge) => smooth((since - weight(edge.a) * 220 - 220) / 420);

    // The fourth dimension unfolds, and once it is out, slowly turns.
    const target = this.bits === 4 ? 1 : 0;
    const t = motion ? smooth((now - this.morphStart) / MORPH_MS) : 1;
    this.morph = this.morphFrom + (target - this.morphFrom) * t;
    const wantTurn = motion && this.bits === 4 && t === 1 && !this.pointerInside ? 0.22 : 0;
    this.turnSpeed += (wantTurn - this.turnSpeed) * Math.min(1, dt * 2);
    this.turn += this.turnSpeed * dt;
    if (this.bits === 3) {
      // Unwind to the square-on view before folding flat.
      const home = Math.round(this.turn / (2 * Math.PI)) * 2 * Math.PI;
      this.turn = motion ? this.turn + (home - this.turn) * Math.min(1, dt * 3) : home;
    }
    // Keep the figure about the same size as it grows into four dimensions.
    this.cube.scale.setScalar(1 / (1 + 0.42 * this.morph));

    for (const word of corners) this.places.set(word, this.place(word));
    const at = (word: string) => this.places.get(word)!.clone();

    for (const edge of this.edges) {
      // Bit-4 edges have no length in 3D, and edges between bit-4 corners lie
      // on top of their twins, so both fade in with the fourth dimension.
      const fade = Math.min(this.presence(edge.a), this.presence(edge.b));
      const grow = grown(edge);
      const visible = fade > 0.01 && grow > 0.01;
      edge.mesh.visible = visible;
      edge.tube.visible = visible && !!edge.tube.userData.on;
      if (!visible) continue;
      const from = at(edge.a);
      const to = from.clone().lerp(at(edge.b), grow);
      const lit = !!edge.mesh.userData.lit;
      span(edge.mesh, from, to);
      edge.mesh.scale.x = edge.mesh.scale.z = lit ? 0.045 : 0.02;
      (edge.mesh.material as THREE.MeshBasicMaterial).opacity = fade * (lit ? 1 : this.dark ? 0.4 : 0.7);
      if (edge.tube.visible) {
        span(edge.tube, from, to);
        edge.tube.scale.x = edge.tube.scale.z = 0.11;
      }
    }

    for (const [word, node] of this.nodes) {
      const presence = this.presence(word) * revealed(word);
      node.mesh.visible = presence > 0.01;
      node.mesh.position.copy(this.places.get(word)!);
      node.hit.position.copy(this.places.get(word)!);
      const base = node.mesh.userData.code ? 0.16 : 0.085;
      node.mesh.scale.setScalar(base * presence * (word === this.hover ? 1.35 : 1));
      (node.halo.material as THREE.SpriteMaterial).opacity = (node.halo.userData.base ?? 0) * presence;
      const quiet = node.label.dataset.quiet === 'true' && word !== this.hover;
      node.label.style.opacity = String(presence * (quiet ? 0 : 1));
    }

    // The packet walks the edges, following them as they move.
    if (!this.leg && this.queue.length) this.leg = { from: this.at, to: this.queue.shift()!, start: now };
    let packetAt = at(this.at);
    if (this.leg) {
      const step = Math.min(1, (now - this.leg.start) / STEP_MS);
      packetAt = at(this.leg.from).lerp(at(this.leg.to), ease(step));
      if (step === 1) {
        this.at = this.leg.to;
        this.leg = undefined;
      }
    }
    this.packet.position.copy(packetAt);
    this.packet.visible = revealed(this.at) > 0.5;
    this.trail.follow(motion && this.packet.visible ? packetAt : null);

    this.sentRing.visible = !!this.state && revealed('0000') > 0.5;
    if (this.state) this.sentRing.position.copy(at(this.corner(this.state.sent)));
    const breathe = motion ? 1 + Math.sin(now / 420) * 0.06 : 1;
    for (const ring of [this.sentRing, ...this.ties]) {
      if (ring.userData.word) ring.position.copy(at(ring.userData.word));
      ring.quaternion.copy(this.camera.quaternion);
      ring.scale.setScalar(breathe);
    }

    // The receiver's decision: an arrow from the received word to the one it
    // decodes to, with a spark running along it.
    const settled = !this.leg && !this.queue.length && now > this.echoStart;
    for (const arrow of this.arrows) {
      const from = at(arrow.from);
      const to = at(arrow.to);
      const dir = to.clone().sub(from);
      const length = dir.length();
      dir.normalize();
      // Stop short of both corners so the path reads as an arrow between them.
      span(arrow.tube, from.clone().addScaledVector(dir, 0.25), to.clone().addScaledVector(dir, -0.3));
      arrow.tube.visible = arrow.tip.visible = settled && length > 0.7;
      arrow.tip.position.copy(to).addScaledVector(dir, -0.3);
      arrow.tip.quaternion.copy(arrow.tube.quaternion);
    }
    if (this.arrows.length && settled) {
      const cycle = motion ? ((now - this.echoStart) % 1500) / 1100 : 1;
      const along = Math.min(1, cycle) * this.arrows.length;
      const i = Math.min(Math.floor(along), this.arrows.length - 1);
      this.echo.position.copy(at(this.arrows[i].from).lerp(at(this.arrows[i].to), ease(along - i)));
      this.echo.visible = true;
    } else {
      this.echo.visible = false;
    }
  }

  protected placeLabels() {
    const scale = this.cube.scale.x;
    for (const [word, node] of this.nodes) {
      node.label.style.visibility = node.mesh.visible ? '' : 'hidden';
      if (!node.mesh.visible) continue;
      // Push each label outwards from the centre so it sits beside its corner.
      const p = this.places.get(word)!.clone().multiplyScalar(scale);
      this.pin(node.label, p.setLength(p.length() + 0.38));
    }
    // Each axis label sits beside the first edge along its bit, from 0000.
    for (const { el, bit } of this.axisLabels) {
      const to = '0000'.slice(0, bit) + '1' + '0000'.slice(bit + 1);
      const fade = bit === 3 ? smooth((this.morph - 0.5) * 2) : 1;
      el.style.visibility = fade > 0.05 ? '' : 'hidden';
      el.style.opacity = String(fade);
      const mid = this.places.get('0000')!.clone().add(this.places.get(to)!).multiplyScalar(0.5 * scale);
      this.pin(el, mid.setLength(mid.length() + 0.45));
    }
  }
}

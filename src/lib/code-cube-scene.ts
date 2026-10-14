// The WebGL half of <CodeCube>. It draws whatever state it is handed and reports
// clicks on corners; the code logic lives in code-cube.ts.
import * as THREE from 'three';
import { corners, decodesTo, nearest, walk, type Code, type Outcome } from './code-cube';
import { ease, glowTexture, PlateScene, type PlateOptions } from './plate-scene';

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

// One ink per bit position, matching the --bit-1..3 tokens in global.css.
const BIT_INK = [0x3dd8f0, 0xff5cab, 0xffd54a];
const OUTCOME_INK: Record<Outcome, number> = {
  intact: 0xffffff,
  corrected: 0x7ef0b8,
  detected: 0xffd54a,
  undetected: 0xff6b6b,
  miscorrected: 0xff6b6b,
};
const STEP_MS = 420;

const point = (word: string) =>
  new THREE.Vector3(...[...word].map((b) => (b === '1' ? 1 : -1)) as [number, number, number]);

const edgeKey = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export class CodeCubeScene extends PlateScene {
  private cube = new THREE.Group();

  private nodes = new Map<string, { mesh: THREE.Mesh; hit: THREE.Mesh; label: HTMLElement }>();
  private edges = new Map<string, { mesh: THREE.Mesh; bit: number }>();
  private catchment = new Map<string, THREE.Mesh>();
  private axisLabels: { el: HTMLElement; at: THREE.Vector3 }[] = [];
  private sentRing: THREE.Mesh;
  private packet: THREE.Group;
  private echo: THREE.Mesh;
  private ties: THREE.Mesh[] = [];
  private verdictPath = new THREE.Group();

  private state?: CubeState;
  private shownPath: string[] = [];
  private queue: string[] = [];
  private leg?: { from: THREE.Vector3; to: THREE.Vector3; start: number };
  private echoPath: THREE.Vector3[] = [];
  private echoStart = 0;
  private hover: string | null = null;

  constructor(host: HTMLElement, labelLayer: HTMLElement, options: Options) {
    super(host, labelLayer, { ...options, fov: [32, 44] });

    // Off every body diagonal, so no two corners start out stacked on screen.
    this.camera.position.set(8.3, 3.5, 1.4);
    this.controls.minDistance = 7;
    this.controls.maxDistance = 14;

    this.scene.add(new THREE.HemisphereLight(0xcfe0ff, 0x1a1030, 1.4));
    const key = new THREE.DirectionalLight(0xffffff, 2.2);
    key.position.set(4, 6, 5);
    this.scene.add(key);
    this.scene.add(this.cube);

    const glow = glowTexture();
    this.buildFloor(glow);
    this.buildEdges();
    this.buildNodes(glow);
    this.buildAxisLabels();

    this.sentRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.3, 0.016, 12, 64),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9 }),
    );
    this.cube.add(this.sentRing);

    this.packet = new THREE.Group();
    const core = new THREE.Mesh(
      new THREE.SphereGeometry(0.1, 32, 16),
      new THREE.MeshBasicMaterial({ color: new THREE.Color(3, 3, 3) }),
    );
    const halo = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: glow, color: 0xffffff, transparent: true, opacity: 0.8, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    halo.scale.setScalar(0.9);
    this.packet.add(core, halo);
    this.cube.add(this.packet);

    this.echo = new THREE.Mesh(
      new THREE.SphereGeometry(0.075, 16, 8),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true }),
    );
    this.echo.visible = false;
    this.cube.add(this.echo, this.verdictPath);

    if (options.interactive) {
      this.listenForPicks<string>(
        () => [...this.nodes.values()].map((n) => n.hit),
        (word) => options.onPick?.(word),
        (word) => (this.hover = word),
      );
    }
    this.ready();
  }

  private buildFloor(glow: THREE.Texture) {
    const floor = new THREE.Mesh(
      new THREE.PlaneGeometry(7, 7),
      new THREE.MeshBasicMaterial({ map: glow, color: 0x6c7cff, transparent: true, opacity: 0.16, depthWrite: false, blending: THREE.AdditiveBlending }),
    );
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = -1.7;
    this.scene.add(floor);
  }

  private buildEdges() {
    const up = new THREE.Vector3(0, 1, 0);
    for (const a of corners) {
      for (let bit = 0; bit < 3; bit++) {
        if (a[bit] !== '0') continue;
        const b = a.slice(0, bit) + '1' + a.slice(bit + 1);
        const from = point(a);
        const to = point(b);
        const dir = to.clone().sub(from);
        const mid = from.clone().add(to).multiplyScalar(0.5);
        const quat = new THREE.Quaternion().setFromUnitVectors(up, dir.clone().normalize());

        const mesh = new THREE.Mesh(
          new THREE.CylinderGeometry(0.02, 0.02, dir.length(), 12, 1, true),
          new THREE.MeshBasicMaterial({ color: BIT_INK[bit], transparent: true, opacity: 0.32 }),
        );
        mesh.position.copy(mid);
        mesh.quaternion.copy(quat);
        this.cube.add(mesh);
        this.edges.set(edgeKey(a, b), { mesh, bit });

        // A wide, faint tube shown when this edge lies inside one codeword's
        // decoding region.
        const tube = new THREE.Mesh(
          new THREE.CylinderGeometry(0.11, 0.11, dir.length(), 24, 1, true),
          new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.06, depthWrite: false }),
        );
        tube.position.copy(mid);
        tube.quaternion.copy(quat);
        tube.visible = false;
        this.cube.add(tube);
        this.catchment.set(edgeKey(a, b), tube);
      }
    }
  }

  private buildNodes(glow: THREE.Texture) {
    const geometry = new THREE.SphereGeometry(1, 32, 16);
    const hitGeometry = new THREE.SphereGeometry(0.32, 8, 6);
    for (const word of corners) {
      const mesh = new THREE.Mesh(
        geometry,
        new THREE.MeshStandardMaterial({ color: 0x5a6888, roughness: 0.35, metalness: 0.1 }),
      );
      mesh.position.copy(point(word));
      const halo = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: glow, transparent: true, opacity: 0, depthWrite: false, blending: THREE.AdditiveBlending }),
      );
      halo.scale.setScalar(5);
      mesh.add(halo);
      const hit = new THREE.Mesh(hitGeometry, new THREE.MeshBasicMaterial({ visible: false }));
      hit.position.copy(mesh.position);
      hit.userData.pick = word;
      this.cube.add(mesh, hit);

      const label = document.createElement('span');
      label.className = 'cc-label';
      label.innerHTML = `<span>${[...word].map((b, i) => `<i class="b${i + 1}">${b}</i>`).join('')}</span>`;
      this.labelLayer.append(label);
      this.nodes.set(word, { mesh, hit, label });
    }
  }

  private buildAxisLabels() {
    const spots = [
      new THREE.Vector3(0, -1.42, -1.42),
      new THREE.Vector3(-1.42, 0, -1.42),
      new THREE.Vector3(-1.42, -1.42, 0),
    ];
    spots.forEach((at, i) => {
      const el = document.createElement('span');
      el.className = `cc-axis b${i + 1}`;
      el.textContent = `bit ${i + 1}`;
      this.labelLayer.append(el);
      this.axisLabels.push({ el, at });
    });
  }

  set(state: CubeState) {
    const previous = this.state;
    this.state = state;
    const { code, sent, path, outcome } = state;
    const received = path.at(-1)!;

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
      this.packet.position.copy(point(received));
    } else {
      this.queue.push(...path.slice(this.shownPath.length));
    }
    this.shownPath = path;

    const lit = new Set<string>();
    for (let i = 1; i < path.length; i++) lit.add(edgeKey(path[i - 1], path[i]));
    for (const [key, edge] of this.edges) {
      const on = lit.has(key);
      (edge.mesh.material as THREE.MeshBasicMaterial).opacity = on ? 1 : 0.3;
      edge.mesh.scale.set(on ? 2.2 : 1, 1, on ? 2.2 : 1);
    }

    for (const [key, tube] of this.catchment) {
      const [a, b] = key.split('|');
      const inA = code.words.includes(a) && decodesTo(code, b) === a && !code.words.includes(b);
      const inB = code.words.includes(b) && decodesTo(code, a) === b && !code.words.includes(a);
      tube.visible = inA || inB;
    }

    for (const [word, node] of this.nodes) {
      const isCode = code.words.includes(word);
      const material = node.mesh.material as THREE.MeshStandardMaterial;
      material.color.set(isCode ? 0xffffff : 0x7685a6);
      material.emissive.set(isCode ? 0xbfd0ff : 0x000000);
      material.emissiveIntensity = isCode ? 0.9 : 0;
      node.mesh.scale.setScalar(isCode ? 0.16 : 0.085);
      ((node.mesh.children[0] as THREE.Sprite).material as THREE.SpriteMaterial).opacity = isCode ? 0.35 : 0;
      node.label.classList.toggle('is-code', isCode);
      node.label.classList.toggle('is-sent', word === sent);
      node.label.classList.toggle('is-received', word === received && received !== sent);
    }

    this.sentRing.position.copy(point(sent));

    for (const ring of this.ties) {
      ring.geometry.dispose();
      this.cube.remove(ring);
    }
    this.ties = [];
    if (outcome === 'detected') {
      for (const word of nearest(code, received)) {
        const ring = new THREE.Mesh(
          new THREE.TorusGeometry(0.24, 0.012, 8, 48),
          new THREE.MeshBasicMaterial({ color: OUTCOME_INK.detected, transparent: true, opacity: 0.9 }),
        );
        ring.position.copy(point(word));
        this.cube.add(ring);
        this.ties.push(ring);
      }
    }

    this.echoPath =
      state.decoded && state.decoded !== received ? walk(received, state.decoded).map(point) : [];
    (this.echo.material as THREE.MeshBasicMaterial).color.set(OUTCOME_INK[outcome]);
    this.drawVerdictPath(OUTCOME_INK[outcome]);
    this.echoStart = performance.now() + (this.queue.length ? this.queue.length * STEP_MS : 0);
    this.kick();
  }

  /** The receiver's decision, drawn from the received word to the one it decodes to. */
  private drawVerdictPath(color: number) {
    for (const child of [...this.verdictPath.children]) {
      (child as THREE.Mesh).geometry.dispose();
      this.verdictPath.remove(child);
    }
    const material = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 });
    for (let i = 1; i < this.echoPath.length; i++) {
      const from = this.echoPath[i - 1];
      const to = this.echoPath[i];
      const dir = to.clone().sub(from);
      // Stop short of both corners so the path reads as an arrow between them.
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.03, dir.length() - 0.5, 12), material);
      tube.position.copy(from).add(to).multiplyScalar(0.5);
      tube.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.normalize());
      const tip = new THREE.Mesh(new THREE.ConeGeometry(0.09, 0.22, 16), material);
      tip.position.copy(to).addScaledVector(dir, -0.3);
      tip.quaternion.copy(tube.quaternion);
      this.verdictPath.add(tube, tip);
    }
  }

  protected frame(now: number) {
    if (!this.leg && this.queue.length) {
      this.leg = { from: this.packet.position.clone(), to: point(this.queue.shift()!), start: now };
    }
    if (this.leg) {
      const t = Math.min(1, (now - this.leg.start) / STEP_MS);
      this.packet.position.lerpVectors(this.leg.from, this.leg.to, ease(t));
      if (t === 1) this.leg = undefined;
    }

    // The receiver's correction, drawn as a small spark running from the
    // received word to the codeword it decodes to.
    if (this.echoPath.length > 1 && now > this.echoStart && !this.leg && !this.queue.length) {
      const cycle = this.options.reducedMotion ? 1 : ((now - this.echoStart) % 1500) / 1100;
      const t = Math.min(1, cycle) * (this.echoPath.length - 1);
      const i = Math.min(Math.floor(t), this.echoPath.length - 2);
      this.echo.position.lerpVectors(this.echoPath[i], this.echoPath[i + 1], ease(t - i));
      this.echo.visible = true;
    } else {
      this.echo.visible = false;
    }

    const breathe = this.options.reducedMotion ? 1 : 1 + Math.sin(now / 420) * 0.06;
    this.sentRing.quaternion.copy(this.camera.quaternion);
    this.sentRing.scale.setScalar(breathe);
    for (const ring of this.ties) {
      ring.quaternion.copy(this.camera.quaternion);
      ring.scale.setScalar(breathe);
    }
    for (const [word, node] of this.nodes) {
      const base = this.state?.code.words.includes(word) ? 0.16 : 0.085;
      node.mesh.scale.setScalar(word === this.hover ? base * 1.35 : base);
    }
  }

  protected placeLabels() {
    for (const [word, node] of this.nodes) {
      // Push each label outwards from the centre so it sits beside its corner.
      const z = this.pin(node.label, point(word).multiplyScalar(1.3));
      node.label.style.opacity = String(Math.max(0.4, Math.min(1, 1.9 - z)));
    }
    for (const { el, at } of this.axisLabels) this.pin(el, at);
  }
}

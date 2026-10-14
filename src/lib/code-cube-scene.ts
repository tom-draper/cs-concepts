// The WebGL half of <CodeCube>. It draws whatever state it is handed and reports
// clicks on corners; the code logic lives in code-cube.ts.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { corners, decodesTo, nearest, walk, type Code, type Outcome } from './code-cube';

export interface CubeState {
  code: Code;
  sent: string;
  /** Every word the packet has visited since it was sent, one flip apart. */
  path: string[];
  decoded: string | null;
  outcome: Outcome;
}

interface Options {
  reducedMotion: boolean;
  autoRotate: boolean;
  interactive: boolean;
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

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

function glowTexture() {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.35, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

export class CodeCubeScene {
  private renderer: THREE.WebGLRenderer;
  private composer: EffectComposer;
  private bloom: UnrealBloomPass;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(32, 1, 0.1, 100);
  private controls: OrbitControls;
  private cube = new THREE.Group();
  private raycaster = new THREE.Raycaster();

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
  private frame = 0;
  private running = false;
  private hover: string | null = null;
  private resize: ResizeObserver;
  private visible: IntersectionObserver;
  private themeWatch: MutationObserver;
  private media = matchMedia('(prefers-color-scheme: dark)');

  constructor(
    private host: HTMLElement,
    private labelLayer: HTMLElement,
    private options: Options,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.NoToneMapping;
    host.append(this.renderer.domElement);

    // Off every body diagonal, so no two corners start out stacked on screen.
    this.camera.position.set(8.3, 3.5, 1.4);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.enableZoom = options.interactive;
    this.controls.minDistance = 7;
    this.controls.maxDistance = 14;
    this.controls.autoRotate = options.autoRotate && !options.reducedMotion;
    this.controls.autoRotateSpeed = 0.7;
    this.controls.addEventListener('start', () => {
      if (options.interactive) this.controls.autoRotate = false;
    });

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

    const pass = new RenderPass(this.scene, this.camera);
    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.7, 0.4, 0.82);
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(pass);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());

    this.readBackground();
    this.themeWatch = new MutationObserver(() => this.readBackground());
    this.themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    this.media.addEventListener('change', this.readBackground);

    this.resize = new ResizeObserver(() => this.fit());
    this.resize.observe(host);
    this.fit();

    this.visible = new IntersectionObserver(([entry]) => (entry.isIntersecting ? this.start() : this.stop()));
    this.visible.observe(host);

    if (options.interactive) this.listen();
  }

  private readBackground = () => {
    // --plate uses light-dark(), so read the resolved colour off the plate itself.
    const plate = this.host.closest<HTMLElement>('.plate') ?? this.host;
    // The composer's target stores the clear colour unconverted and OutputPass
    // encodes it again, so hand it linear values to land on the CSS colour.
    const color = new THREE.Color(getComputedStyle(plate).backgroundColor).convertSRGBToLinear();
    this.renderer.setClearColor(color, 1);
    this.kick();
  };

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
      hit.userData.word = word;
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

  private listen() {
    const canvas = this.renderer.domElement;
    let down: { x: number; y: number } | null = null;
    const pick = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      this.raycaster.setFromCamera(ndc, this.camera);
      const hits = this.raycaster.intersectObjects([...this.nodes.values()].map((n) => n.hit));
      return (hits[0]?.object.userData.word as string | undefined) ?? null;
    };
    canvas.addEventListener('pointerdown', (event) => (down = { x: event.clientX, y: event.clientY }));
    canvas.addEventListener('pointerup', (event) => {
      if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) return;
      const word = pick(event);
      if (word) this.options.onPick?.(word);
    });
    canvas.addEventListener('pointermove', (event) => {
      if (event.buttons) return;
      this.hover = pick(event);
      canvas.style.cursor = this.hover ? 'pointer' : 'grab';
    });
    canvas.addEventListener('pointerleave', () => (this.hover = null));
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

  private fit() {
    const { clientWidth: w, clientHeight: h } = this.host;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w, h);
    this.camera.aspect = w / h;
    // Pull back on narrow, tall stages so the whole cube stays in view.
    this.camera.fov = w / h < 1 ? 44 : 32;
    this.camera.updateProjectionMatrix();
    this.kick();
  }

  private start() {
    if (this.running) return;
    this.running = true;
    const tick = (now: number) => {
      if (!this.running) return;
      this.frame = requestAnimationFrame(tick);
      this.update(now);
    };
    this.frame = requestAnimationFrame(tick);
  }

  private stop() {
    this.running = false;
    cancelAnimationFrame(this.frame);
  }

  private kick() {
    if (!this.running) this.update(performance.now());
  }

  private update(now: number) {
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

    this.controls.update();
    this.composer.render();
    this.placeLabels();
  }

  private placeLabels() {
    const w = this.host.clientWidth;
    const h = this.host.clientHeight;
    const v = new THREE.Vector3();
    const toScreen = (at: THREE.Vector3) => {
      v.copy(at).project(this.camera);
      return [(v.x * 0.5 + 0.5) * w, (-v.y * 0.5 + 0.5) * h, v.z] as const;
    };
    for (const [word, node] of this.nodes) {
      // Push each label outwards from the centre so it sits beside its corner.
      const [x, y, z] = toScreen(point(word).multiplyScalar(1.3));
      node.label.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
      node.label.style.opacity = String(Math.max(0.4, Math.min(1, 1.9 - z * 1.0)));
    }
    for (const { el, at } of this.axisLabels) {
      const [x, y] = toScreen(at);
      el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
    }
  }

  dispose() {
    this.stop();
    this.resize.disconnect();
    this.visible.disconnect();
    this.themeWatch.disconnect();
    this.media.removeEventListener('change', this.readBackground);
    this.controls.dispose();
    this.composer.dispose();
    this.renderer.dispose();
  }
}

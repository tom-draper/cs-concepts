// The shared half of every 3D figure: a renderer that matches its plate's
// colour, a bloom pass, orbit controls, HTML labels pinned to points in the
// scene, and a render loop that only runs while the figure is on screen.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';

export interface PlateOptions {
  reducedMotion: boolean;
  autoRotate: boolean;
  interactive: boolean;
  /** Field of view on wide stages, and on stages taller than they are wide. */
  fov: [wide: number, tall: number];
}

export const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

export function glowTexture() {
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

/** Stretch and turn a unit-height cylinder so it spans two points. */
export function span(mesh: THREE.Object3D, from: THREE.Vector3, to: THREE.Vector3) {
  const dir = to.clone().sub(from);
  mesh.position.copy(from).add(to).multiplyScalar(0.5);
  mesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir.clone().normalize());
  mesh.scale.y = dir.length();
  return mesh;
}

export abstract class PlateScene {
  protected renderer: THREE.WebGLRenderer;
  protected composer: EffectComposer;
  protected bloom: UnrealBloomPass;
  protected scene = new THREE.Scene();
  protected camera = new THREE.PerspectiveCamera(32, 1, 0.1, 200);
  protected controls: OrbitControls;
  private raycaster = new THREE.Raycaster();
  private frameId = 0;
  private running = false;
  private observers: { disconnect(): void }[] = [];
  private media = matchMedia('(prefers-color-scheme: dark)');

  constructor(
    protected host: HTMLElement,
    protected labelLayer: HTMLElement,
    protected options: PlateOptions,
  ) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.toneMapping = THREE.NoToneMapping;
    host.append(this.renderer.domElement);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.enableZoom = options.interactive;
    this.controls.autoRotate = options.autoRotate && !options.reducedMotion;
    this.controls.autoRotateSpeed = 0.7;
    this.controls.addEventListener('start', () => {
      if (options.interactive) this.controls.autoRotate = false;
    });

    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.7, 0.4, 0.82);
    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
  }

  /** Called by a subclass once its own scene is built, to start sizing and drawing. */
  protected ready() {
    this.readBackground();
    const theme = new MutationObserver(this.readBackground);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    this.media.addEventListener('change', this.readBackground);

    const resize = new ResizeObserver(() => this.fit());
    resize.observe(this.host);

    const visible = new IntersectionObserver(([entry]) => (entry.isIntersecting ? this.start() : this.stop()));
    visible.observe(this.host);

    this.observers.push(theme, resize, visible);
    this.fit();
  }

  /** Move things for this frame. Runs before the controls update and the render. */
  protected abstract frame(now: number): void;

  /** Position HTML labels. Runs after the render, once the camera has moved. */
  protected abstract placeLabels(): void;

  private readBackground = () => {
    // --plate uses light-dark(), so read the resolved colour off the plate itself.
    const plate = this.host.closest<HTMLElement>('.plate') ?? this.host;
    // The composer's target stores the clear colour unconverted and OutputPass
    // encodes it again, so hand it linear values to land on the CSS colour.
    const color = new THREE.Color(getComputedStyle(plate).backgroundColor).convertSRGBToLinear();
    this.renderer.setClearColor(color, 1);
    this.kick();
  };

  private fit() {
    const { clientWidth: w, clientHeight: h } = this.host;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.composer.setSize(w, h);
    this.bloom.resolution.set(w, h);
    this.camera.aspect = w / h;
    // Pull back on narrow, tall stages so the whole figure stays in view.
    this.camera.fov = w / h < 1 ? this.options.fov[1] : this.options.fov[0];
    this.camera.updateProjectionMatrix();
    this.kick();
  }

  private start() {
    if (this.running) return;
    this.running = true;
    const tick = (now: number) => {
      if (!this.running) return;
      this.frameId = requestAnimationFrame(tick);
      this.draw(now);
    };
    this.frameId = requestAnimationFrame(tick);
  }

  private stop() {
    this.running = false;
    cancelAnimationFrame(this.frameId);
  }

  /** Draw once now if the loop is paused, so a change shows while off screen. */
  protected kick() {
    if (!this.running) this.draw(performance.now());
  }

  private draw(now: number) {
    this.frame(now);
    this.controls.update();
    this.composer.render();
    this.placeLabels();
  }

  /** Where a point in the scene lands on the stage, in CSS pixels, plus its depth. */
  protected toScreen(at: THREE.Vector3): [x: number, y: number, z: number] {
    const v = at.clone().project(this.camera);
    return [(v.x * 0.5 + 0.5) * this.host.clientWidth, (-v.y * 0.5 + 0.5) * this.host.clientHeight, v.z];
  }

  protected pin(el: HTMLElement, at: THREE.Vector3) {
    const [x, y, z] = this.toScreen(at);
    el.style.transform = `translate(${x}px, ${y}px) translate(-50%, -50%)`;
    return z;
  }

  /**
   * Report clicks (not drags) and hovers on a set of objects. Each object
   * carries what it stands for in `userData.pick`.
   */
  protected listenForPicks<T>(targets: () => THREE.Object3D[], onPick: (value: T) => void, onHover?: (value: T | null) => void) {
    const canvas = this.renderer.domElement;
    let down: { x: number; y: number } | null = null;
    const pick = (event: PointerEvent) => {
      const rect = canvas.getBoundingClientRect();
      const ndc = new THREE.Vector2(
        ((event.clientX - rect.left) / rect.width) * 2 - 1,
        -((event.clientY - rect.top) / rect.height) * 2 + 1,
      );
      this.raycaster.setFromCamera(ndc, this.camera);
      const hit = this.raycaster.intersectObjects(targets())[0];
      return hit ? (hit.object.userData.pick as T) : null;
    };
    canvas.addEventListener('pointerdown', (event) => (down = { x: event.clientX, y: event.clientY }));
    canvas.addEventListener('pointerup', (event) => {
      if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 5) return;
      const value = pick(event);
      if (value !== null) onPick(value);
    });
    canvas.addEventListener('pointermove', (event) => {
      if (event.buttons) return;
      const value = pick(event);
      canvas.style.cursor = value !== null ? 'pointer' : 'grab';
      onHover?.(value);
    });
    canvas.addEventListener('pointerleave', () => onHover?.(null));
  }

  dispose() {
    this.stop();
    this.observers.forEach((o) => o.disconnect());
    this.media.removeEventListener('change', this.readBackground);
    this.controls.dispose();
    this.composer.dispose();
    this.renderer.dispose();
  }
}

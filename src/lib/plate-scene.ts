// The shared half of every 3D figure: a renderer painted in the page colour so
// the figure sits straight on the paper, inks read from the CSS theme, soft
// shadows and reflections, a bloom pass for dark mode, orbit controls, HTML
// labels pinned to points in the scene, and a render loop that only runs while
// the figure is on screen.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
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

/**
 * A fading tail of glowing dots that follows a moving point. Call `follow`
 * every frame with where the point is now.
 */
export class Trail {
  private dots: THREE.Sprite[] = [];
  private history: THREE.Vector3[] = [];

  constructor(parent: THREE.Object3D, map: THREE.Texture, public size: number, count = 16) {
    for (let i = 0; i < count; i++) {
      const dot = new THREE.Sprite(new THREE.SpriteMaterial({ map, transparent: true, depthWrite: false }));
      dot.visible = false;
      parent.add(dot);
      this.dots.push(dot);
    }
  }

  /** Recolour the tail. Additive light only reads on a dark page. */
  paint(color: THREE.Color, dark: boolean) {
    for (const dot of this.dots) {
      const material = dot.material as THREE.SpriteMaterial;
      material.color.copy(color);
      material.blending = dark ? THREE.AdditiveBlending : THREE.NormalBlending;
      material.needsUpdate = true;
    }
  }

  follow(at: THREE.Vector3 | null) {
    if (at) this.history.unshift(at.clone());
    else this.history.pop();
    this.history.length = Math.min(this.history.length, this.dots.length);
    this.dots.forEach((dot, i) => {
      const point = this.history[i];
      dot.visible = !!point;
      if (!point) return;
      const fade = 1 - i / this.dots.length;
      dot.position.copy(point);
      dot.scale.setScalar(this.size * (0.35 + 0.65 * fade));
      (dot.material as THREE.SpriteMaterial).opacity = 0.55 * fade * fade;
    });
  }
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
  /** True when the page behind the figure is dark. Set before `themed` runs. */
  protected dark = true;
  protected key = new THREE.DirectionalLight(0xffffff, 2.2);
  private hemi = new THREE.HemisphereLight(0xdfe8ff, 0x30283a, 1.2);
  private shadowFloors: THREE.Mesh[] = [];
  private probe = document.createElement('span');
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
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    host.append(this.renderer.domElement);

    // A soft studio for reflections, so solid shapes read in a light theme
    // where glow cannot.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.radius = 6;
    this.key.shadow.bias = -0.0005;
    this.scene.add(this.key, this.key.target, this.hemi);

    this.probe.hidden = true;
    host.append(this.probe);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.enablePan = false;
    this.controls.enableZoom = options.interactive;
    this.controls.autoRotate = options.autoRotate && !options.reducedMotion;
    this.controls.autoRotateSpeed = 0.7;
    this.controls.addEventListener('start', () => {
      if (options.interactive) this.controls.autoRotate = false;
    });

    this.bloom = new UnrealBloomPass(new THREE.Vector2(1, 1), 0.8, 0, 0.82);
    // Drop the two widest blurs. They average the bright shapes over the whole
    // canvas, which lifts the background off the page colour and shows a box.
    this.bloom.compositeMaterial.uniforms.bloomFactors.value = [1, 0.7, 0.35, 0, 0];
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

  /** Recolour the scene from `ink()`. Runs once when ready, and on every theme change. */
  protected themed() {}

  /** Move things for this frame. Runs before the controls update and the render. */
  protected abstract frame(now: number): void;

  /** Position HTML labels. Runs after the render, once the camera has moved. */
  protected abstract placeLabels(): void;

  private readBackground = () => {
    // --plate uses light-dark(), so read the resolved colour off the plate itself.
    const plate = this.host.closest<HTMLElement>('.plate') ?? this.host;
    // The composer's target stores the clear colour unconverted and OutputPass
    // encodes it again, so hand it linear values to land on the CSS colour.
    const background = new THREE.Color(getComputedStyle(plate).backgroundColor);
    this.dark = background.getHSL({ h: 0, s: 0, l: 0 }).l < 0.35;
    this.renderer.setClearColor(background.clone().convertSRGBToLinear(), 1);

    // Glow is for dark pages. On paper, shapes are lit and cast shadows instead.
    this.bloom.enabled = this.dark;
    this.scene.environmentIntensity = this.dark ? 0.35 : 0.8;
    this.hemi.intensity = this.dark ? 1.2 : 1.6;
    this.key.intensity = this.dark ? 2 : 2.4;
    for (const floor of this.shadowFloors) {
      (floor.material as THREE.ShadowMaterial).opacity = this.dark ? 0.45 : 0.13;
    }
    this.themed();
    this.kick();
  };

  /** A colour from the theme, given the name after `--plate-`. */
  protected ink(name: string): THREE.Color {
    this.probe.style.color = `var(--plate-${name})`;
    return new THREE.Color(getComputedStyle(this.probe).color);
  }

  /** An invisible floor that only shows the shadows falling on it. */
  protected shadowFloor(y: number, size: number) {
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.ShadowMaterial({ opacity: 0.2 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.y = y;
    floor.receiveShadow = true;
    this.scene.add(floor);
    this.shadowFloors.push(floor);
    const shadow = this.key.shadow.camera;
    shadow.left = shadow.bottom = -size / 2;
    shadow.right = shadow.top = size / 2;
    shadow.far = 60;
    shadow.updateProjectionMatrix();
    return floor;
  }

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
    this.resized(w / h);
    this.kick();
  }

  /** Called after the stage changes shape, for scenes that frame themselves. */
  protected resized(_aspect: number) {}

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

  /** Whether the figure is on screen and animating. */
  protected get isRunning() {
    return this.running;
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

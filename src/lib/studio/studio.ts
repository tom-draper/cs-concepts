// The shared three.js "studio": a transparent canvas showing a floating white
// board, lit like a product shot, with a soft shadow on the set below. Scenes
// (the home hero, the sorting demo) build on top of it.
//
// The canvas is transparent so the page background, and its grain, show
// through. Colours come from the site's CSS custom properties so the scene
// follows the light and dark themes.

import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { clamp, lerp } from './motion';
import { MONO } from './support';

export { MONO };

export interface Palette {
  dark: boolean;
  board: THREE.Color;
  tile: THREE.Color;
  ink: THREE.Color;
  clay: THREE.Color;
  rule: string;
  text: string;
  text2: string;
  clayCss: string;
  boardCss: string;
}

/** Resolve the site's colour tokens (which use light-dark()) to real colours. */
export function readPalette(host: HTMLElement): Palette {
  const probe = document.createElement('span');
  probe.hidden = true;
  host.append(probe);
  const css = (name: string) => {
    probe.style.color = `var(${name})`;
    return getComputedStyle(probe).color;
  };
  const bg = new THREE.Color(css('--bg'));
  const dark = bg.getHSL({ h: 0, s: 0, l: 0 }).l < 0.3;
  const palette: Palette = {
    dark,
    board: new THREE.Color(css('--board')),
    tile: new THREE.Color(dark ? '#4a4742' : '#f2f0eb'),
    ink: new THREE.Color(dark ? '#0d0d0c' : '#1d1c1a'),
    clay: new THREE.Color('#d97757'),
    rule: css('--rule'),
    text: css('--text'),
    text2: css('--text-2'),
    clayCss: '#d97757',
    boardCss: css('--board'),
  };
  probe.remove();
  return palette;
}

/** Draw text onto a canvas texture. Used for rulers, tags and value labels. */
export function textTexture(
  draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void,
  w: number,
  h: number,
) {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  draw(ctx, w, h);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 8;
  return texture;
}

/** A clay flag on a thin pole, like the playhead marker on a timeline. */
export function makeTag(text: string, palette: Palette, { width = 0.36, pole = 0.32 } = {}) {
  const group = new THREE.Group();
  const height = width * 0.42;
  const material = new THREE.MeshBasicMaterial({ transparent: true, toneMapped: false });
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(width, height), material);
  flag.position.y = pole + height / 2;
  group.add(flag);
  const stick = new THREE.Mesh(
    new THREE.CylinderGeometry(0.006, 0.006, pole, 6),
    new THREE.MeshBasicMaterial({ color: palette.clay, toneMapped: false }),
  );
  stick.position.y = pole / 2;
  group.add(stick);
  const set = (label: string) => {
    material.map?.dispose();
    material.map = textTexture(
      (ctx, w, h) => {
        ctx.fillStyle = palette.clayCss;
        ctx.beginPath();
        ctx.roundRect(0, 0, w, h, 10);
        ctx.fill();
        ctx.fillStyle = '#fffaf6';
        ctx.font = `800 ${h * 0.56}px ${MONO}`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(label, w / 2, h / 2 + 2);
      },
      256,
      Math.round(256 * 0.42),
    );
    material.needsUpdate = true;
  };
  set(text);
  return { group, flag, set };
}

/**
 * A ruler strip: a tick every `minor` units, a long tick and a label every
 * `major`. Lies flat, reading left to right along +x.
 */
export function makeRuler(
  length: number,
  palette: Palette,
  { depth = 0.16, minor = 8, major = 40, label = (n: number) => String(n).padStart(3, '0') } = {},
) {
  const units = Math.round(length * 100);
  const texture = textTexture(
    (ctx, w, h) => {
      const px = w / units;
      ctx.strokeStyle = palette.rule;
      ctx.fillStyle = palette.text2;
      ctx.lineWidth = 2;
      ctx.font = `700 ${h * 0.34}px ${MONO}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'alphabetic';
      for (let u = 0, n = 0; u <= units; u += minor, n += minor) {
        const x = u * px + 1;
        const long = n % major === 0;
        ctx.beginPath();
        ctx.moveTo(x, h);
        ctx.lineTo(x, h - (long ? h * 0.38 : h * 0.18));
        ctx.stroke();
        if (long && u > 0 && u < units) ctx.fillText(label(n), x, h * 0.42);
      }
    },
    2048,
    Math.round((2048 / length) * depth),
  );
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(length, depth),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, toneMapped: false }),
  );
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

/** A soft blurred shadow to lay on the floor under a floating object. */
function makeFloorShadow(width: number, depth: number, dark: boolean) {
  const texture = textTexture(
    (ctx, w, h) => {
      ctx.filter = 'blur(28px)';
      ctx.fillStyle = 'black';
      ctx.beginPath();
      ctx.roundRect(w * 0.16, h * 0.2, w * 0.68, h * 0.6, 40);
      ctx.fill();
    },
    512,
    Math.round(512 * (depth / width)),
  );
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(width * 1.5, depth * 1.6),
    new THREE.MeshBasicMaterial({
      map: texture,
      transparent: true,
      opacity: dark ? 0.55 : 0.22,
      depthWrite: false,
    }),
  );
  mesh.rotation.x = -Math.PI / 2;
  return mesh;
}

export interface Board {
  group: THREE.Group;
  /** The board's top surface, in world y. */
  top: number;
}

/**
 * The floating white board, with a grid of low keycap tiles on top like the
 * frames of a timeline. `keys` lists rows as [z, count] pairs.
 */
export function makeBoard(
  width: number,
  depth: number,
  palette: Palette,
  { thickness = 0.16, keys = [] as Array<[z: number, count: number, from?: number, to?: number]> } = {},
): Board {
  const group = new THREE.Group();
  const board = new THREE.Mesh(
    new RoundedBoxGeometry(width, thickness, depth, 4, 0.06),
    new THREE.MeshStandardMaterial({ color: palette.board, roughness: 0.6 }),
  );
  board.position.y = -thickness / 2;
  board.receiveShadow = true;
  board.castShadow = true;
  group.add(board);

  const rows = keys.reduce((n, [, count]) => n + count, 0);
  if (rows) {
    const keyW = 0.085;
    const keyD = 0.13;
    const geometry = new RoundedBoxGeometry(keyW, 0.03, keyD, 2, 0.01);
    const material = new THREE.MeshStandardMaterial({ color: palette.tile, roughness: 0.5 });
    const caps = new THREE.InstancedMesh(geometry, material, rows);
    caps.receiveShadow = true;
    const matrix = new THREE.Matrix4();
    let i = 0;
    for (const [z, count, from = -width / 2 + 0.12, to = width / 2 - 0.12] of keys) {
      for (let k = 0; k < count; k++) {
        const x = lerp(from, to, count > 1 ? k / (count - 1) : 0.5);
        matrix.makeTranslation(x, 0.012, z);
        caps.setMatrixAt(i++, matrix);
      }
    }
    group.add(caps);
  }
  return { group, top: 0 };
}

export interface StudioOptions {
  /** Vertical field of view in degrees. A long lens keeps it graphic. */
  fov?: number;
  distance: number;
  target?: THREE.Vector3;
  /** Resting camera angles, in degrees. */
  yaw?: number;
  pitch?: number;
  /** How far the user may drag the camera around, in degrees either way. */
  yawRange?: number;
  pitchRange?: [number, number];
  /** Widen the lens when the canvas is narrower than this aspect ratio. */
  minAspect?: number;
  /** Floor height under the floating board, and the size of its shadow. */
  floor?: { y: number; width: number; depth: number };
}

/**
 * A renderer, camera, lights and drag-to-orbit for one canvas. Call `start`
 * with a frame callback; rendering pauses while the canvas is off screen.
 */
export class Studio {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly world = new THREE.Group();
  palette: Palette;
  readonly reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;

  private host: HTMLElement;
  private options: Required<Omit<StudioOptions, 'floor'>> & Pick<StudioOptions, 'floor'>;
  private yaw = 0;
  private pitch = 0;
  private yawGoal = 0;
  private pitchGoal = 0;
  private dragging = false;
  private visible = false;
  private frame = 0;
  private timer = new THREE.Timer();
  private running = false;
  private elapsed = 0;
  private onFrame: (t: number, dt: number) => void = () => {};
  private themeListeners: Array<(palette: Palette) => void> = [];
  private cleanups: Array<() => void> = [];
  private floorShadow?: THREE.Mesh;
  private key: THREE.DirectionalLight;
  private hemi: THREE.HemisphereLight;

  constructor(host: HTMLElement, options: StudioOptions) {
    this.host = host;
    this.options = {
      fov: 30,
      target: new THREE.Vector3(),
      yaw: 0,
      pitch: 30,
      yawRange: 30,
      pitchRange: [12, 60],
      minAspect: 1.25,
      ...options,
    };
    this.yaw = this.yawGoal = this.options.yaw;
    this.pitch = this.pitchGoal = this.options.pitch;
    this.palette = readPalette(host);

    this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.toneMapping = THREE.NeutralToneMapping;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    host.append(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(this.options.fov, 1, 0.1, 100);

    // Image-based light from a neutral room gives the plastic its soft sheen.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    pmrem.dispose();

    this.hemi = new THREE.HemisphereLight(0xffffff, 0xd8d2c8, 0.9);
    this.scene.add(this.hemi);

    // One overhead softbox casts the shadows.
    this.key = new THREE.DirectionalLight(0xfff6ee, 2.2);
    this.key.position.set(-2.5, 6, 3);
    this.key.castShadow = true;
    this.key.shadow.mapSize.set(2048, 2048);
    this.key.shadow.radius = 6;
    this.key.shadow.bias = -0.0004;
    this.key.shadow.normalBias = 0.02;
    const s = this.key.shadow.camera;
    s.left = s.bottom = -4;
    s.right = s.top = 4;
    s.near = 1;
    s.far = 20;
    this.scene.add(this.key);

    // A warm clay rim from behind, as in the reference set.
    const rim = new THREE.DirectionalLight(0xd97757, 0.6);
    rim.position.set(3, 2, -5);
    this.scene.add(rim);

    this.scene.add(this.world);
    this.applyTheme();

    if (this.options.floor) {
      const { y, width, depth } = this.options.floor;
      this.floorShadow = makeFloorShadow(width, depth, this.palette.dark);
      this.floorShadow.position.y = y;
      this.scene.add(this.floorShadow);
    }

    this.bindOrbit();
    this.bindVisibility();
    this.bindTheme();
  }

  get canvas() {
    return this.renderer.domElement;
  }

  /** Called with the new palette whenever the site theme changes. */
  onTheme(listener: (palette: Palette) => void) {
    this.themeListeners.push(listener);
  }

  /** Begin the render loop. `frame` receives elapsed and delta seconds. */
  start(frame: (t: number, dt: number) => void) {
    this.onFrame = frame;
    this.wake();
  }

  /** Render one frame now, even if the loop is paused. */
  renderOnce() {
    this.updateCamera(0);
    this.renderer.render(this.scene, this.camera);
  }

  /** Cast a ray from a pointer event into the scene. */
  raycast(event: PointerEvent | MouseEvent, objects: THREE.Object3D[]) {
    const rect = this.canvas.getBoundingClientRect();
    const pointer = new THREE.Vector2(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    );
    const ray = new THREE.Raycaster();
    ray.setFromCamera(pointer, this.camera);
    return ray.intersectObjects(objects, true);
  }

  dispose() {
    cancelAnimationFrame(this.frame);
    this.cleanups.forEach((fn) => fn());
    this.renderer.dispose();
    this.canvas.remove();
  }

  private applyTheme() {
    const { dark } = this.palette;
    this.hemi.intensity = dark ? 0.6 : 0.9;
    this.hemi.groundColor.set(dark ? 0x1a1816 : 0xd8d2c8);
    this.key.intensity = dark ? 1.6 : 2.2;
    this.scene.environmentIntensity = dark ? 0.25 : 0.55;
    if (this.floorShadow) {
      (this.floorShadow.material as THREE.MeshBasicMaterial).opacity = dark ? 0.55 : 0.22;
    }
  }

  private wake() {
    if (!this.visible) return;
    cancelAnimationFrame(this.frame);
    this.loop();
  }

  private loop = () => {
    if (!this.visible) {
      this.running = false;
      return;
    }
    // Resuming after a pause should not jump time forward.
    if (!this.running) this.timer.reset();
    this.running = true;
    this.timer.update();
    const dt = Math.min(this.timer.getDelta(), 1 / 20);
    this.elapsed += dt;
    const t = this.elapsed;
    this.onFrame(t, dt);
    this.updateCamera(t, dt);
    this.renderer.render(this.scene, this.camera);
    this.frame = requestAnimationFrame(this.loop);
  };

  private updateCamera(t: number, dt = 1) {
    const { distance, target, yawRange } = this.options;
    // Ease towards where the user dragged to; drift gently while idle.
    const k = 1 - Math.exp(-dt * 10);
    this.yaw = lerp(this.yaw, this.yawGoal, k);
    this.pitch = lerp(this.pitch, this.pitchGoal, k);
    const sway = this.dragging || this.reducedMotion ? 0 : Math.sin(t * 0.35) * Math.min(3, yawRange / 4);
    const yaw = THREE.MathUtils.degToRad(this.yaw + sway);
    const pitch = THREE.MathUtils.degToRad(this.pitch);
    this.camera.position.set(
      target.x + distance * Math.cos(pitch) * Math.sin(yaw),
      target.y + distance * Math.sin(pitch),
      target.z + distance * Math.cos(pitch) * Math.cos(yaw),
    );
    this.camera.lookAt(target);
  }

  private resize = () => {
    const { clientWidth: w, clientHeight: h } = this.host;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    // Keep the whole board in frame on tall, narrow screens.
    this.camera.fov = this.options.fov * Math.max(1, this.options.minAspect / this.camera.aspect);
    this.camera.updateProjectionMatrix();
    if (!this.visible) this.renderOnce();
  };

  private bindOrbit() {
    const canvas = this.canvas;
    const { yaw, pitch, yawRange, pitchRange } = this.options;
    let lastX = 0;
    let lastY = 0;
    let moved = 0;
    const down = (event: PointerEvent) => {
      this.dragging = true;
      moved = 0;
      lastX = event.clientX;
      lastY = event.clientY;
      canvas.setPointerCapture(event.pointerId);
    };
    const move = (event: PointerEvent) => {
      if (!this.dragging) return;
      const dx = event.clientX - lastX;
      const dy = event.clientY - lastY;
      moved += Math.abs(dx) + Math.abs(dy);
      lastX = event.clientX;
      lastY = event.clientY;
      this.yawGoal = clamp(this.yawGoal - dx * 0.25, yaw - yawRange, yaw + yawRange);
      this.pitchGoal = clamp(this.pitchGoal + dy * 0.2, pitchRange[0], pitchRange[1]);
    };
    const up = () => {
      this.dragging = false;
    };
    // A click that did not drag is passed on; a drag swallows the click.
    const click = (event: MouseEvent) => {
      if (moved > 6) event.stopImmediatePropagation();
    };
    const reset = () => {
      this.yawGoal = yaw;
      this.pitchGoal = pitch;
    };
    canvas.addEventListener('pointerdown', down);
    canvas.addEventListener('pointermove', move);
    canvas.addEventListener('pointerup', up);
    canvas.addEventListener('pointercancel', up);
    canvas.addEventListener('click', click, { capture: true });
    canvas.addEventListener('dblclick', reset);
    canvas.style.touchAction = 'pan-y';
  }

  private bindVisibility() {
    const resize = new ResizeObserver(this.resize);
    resize.observe(this.host);
    const seen = new IntersectionObserver(([entry]) => {
      const was = this.visible;
      this.visible = entry.isIntersecting && !document.hidden;
      if (this.visible && !was) this.wake();
    });
    seen.observe(this.host);
    const tab = () => {
      const was = this.visible;
      const rect = this.host.getBoundingClientRect();
      this.visible = !document.hidden && rect.bottom > 0 && rect.top < innerHeight;
      if (this.visible && !was) this.wake();
    };
    document.addEventListener('visibilitychange', tab);
    this.cleanups.push(() => {
      resize.disconnect();
      seen.disconnect();
      document.removeEventListener('visibilitychange', tab);
    });
  }

  private bindTheme() {
    const update = () => {
      this.palette = readPalette(this.host);
      this.applyTheme();
      this.themeListeners.forEach((listener) => listener(this.palette));
      if (!this.visible) this.renderOnce();
    };
    const media = matchMedia('(prefers-color-scheme: dark)');
    media.addEventListener('change', update);
    const observer = new MutationObserver(update);
    observer.observe(document.documentElement, { attributeFilter: ['data-theme'] });
    this.cleanups.push(() => {
      media.removeEventListener('change', update);
      observer.disconnect();
    });
  }
}

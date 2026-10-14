// Checks that run before three.js is loaded, so pages without WebGL never
// download it.

export const MONO = "'JetBrains Mono Variable', ui-monospace, monospace";

/** True if this browser can give us a WebGL context. */
export function webglAvailable() {
  try {
    const canvas = document.createElement('canvas');
    return !!(canvas.getContext('webgl2') || canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

/** Wait for the label font so canvas text is drawn in it, not a fallback. */
export async function fontsReady() {
  try {
    await document.fonts.load(`800 48px ${MONO}`);
  } catch {}
}

// Shared behaviour for the step controls (see Controls.astro): previous, next,
// play/pause, a scrubber and the arrow keys.

interface Options {
  /** Number of steps. Read on every change, so it may vary over time. */
  count: () => number;
  /** Draw step `index`. */
  render: (index: number) => void;
  /** Milliseconds per step while playing. */
  interval?: number;
}

export function attachStepper(host: HTMLElement, { count, render, interval = 1200 }: Options) {
  const controls = host.querySelector<HTMLElement>('.controls')!;
  const slider = controls.querySelector<HTMLInputElement>('input[type="range"]')!;
  const counter = controls.querySelector('.count')!;
  const play = controls.querySelector<HTMLButtonElement>('.play')!;
  let index = 0;
  let timer = 0;
  const last = () => count() - 1;

  const show = (i: number) => {
    index = Math.max(0, Math.min(last(), i));
    render(index);
    slider.max = String(last());
    slider.value = String(index);
    counter.textContent = `${index + 1} / ${count()}`;
  };
  const stop = () => {
    clearInterval(timer);
    timer = 0;
    play.textContent = index === last() ? 'Replay' : 'Play';
  };
  const start = () => {
    if (index === last()) show(0);
    play.textContent = 'Pause';
    timer = window.setInterval(() => {
      show(index + 1);
      if (index === last()) stop();
    }, interval);
  };
  const go = (i: number) => {
    clearInterval(timer);
    timer = 0;
    show(i);
    stop();
  };

  controls.addEventListener('click', (event) => {
    const act = (event.target as HTMLElement).closest('button')?.dataset.act;
    if (act === 'prev') go(index - 1);
    if (act === 'next') go(index + 1);
    if (act === 'play') timer ? stop() : start();
  });
  slider.addEventListener('input', () => go(Number(slider.value)));
  host.addEventListener('keydown', (event) => {
    const delta = { ArrowLeft: -1, ArrowRight: 1 }[event.key];
    if (!delta || (event.target as HTMLElement).tagName === 'INPUT') return;
    // Keep the arrow keys from also turning the page.
    event.stopPropagation();
    event.preventDefault();
    go(index + delta);
  });

  controls.hidden = false;
  go(0);
  return { go };
}

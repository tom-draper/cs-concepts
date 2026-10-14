import { defineConfig } from 'astro/config';
import mdx from '@astrojs/mdx';

export default defineConfig({
  site: 'https://tom-draper.github.io',
  base: '/vcs',
  trailingSlash: 'always',
  integrations: [mdx()],
  prefetch: { prefetchAll: true, defaultStrategy: 'hover' },
  build: { inlineStylesheets: 'always' },
  // three.js is one lazily loaded chunk, fetched only by pages with a 3D scene.
  vite: { build: { chunkSizeWarningLimit: 800 } },
  markdown: {
    shikiConfig: {
      themes: { light: 'github-light', dark: 'github-dark' },
      defaultColor: false,
    },
  },
});

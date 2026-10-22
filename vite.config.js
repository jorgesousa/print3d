import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths, so the build works on GitHub Pages (/print3d/) or any other sub-path.
  base: './',
  worker: { format: 'es' },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 2000,
  },
});

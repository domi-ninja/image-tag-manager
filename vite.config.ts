import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: [
        '**/.venv/**',
        '**/models/**',
        '**/.native-test/**',
        '**/src-tauri/**',
        '**/results/**',
        '**/samples/**',
      ],
    },
  },
  clearScreen: false,
});

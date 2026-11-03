import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const target = env.VITE_API_URL || 'http://localhost:8000';
  const proxy = {
    '/api': { target, changeOrigin: true },
    '/ws': { target, changeOrigin: true, ws: true },
  };
  return { server: { proxy }, preview: { proxy } };
});

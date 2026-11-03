import { defineConfig, loadEnv } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl'; // F5

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), 'VITE_');
  const target = env.VITE_API_URL || 'http://localhost:8000';
  const proxy = {
    '/api': { target, changeOrigin: true },
    '/ws': { target, changeOrigin: true, ws: true },
  };
  // F5: self-signed HTTPS (`npm run dev:https`) so Android Chrome allows WebXR over the LAN.
  return { plugins: mode === 'https' ? [basicSsl()] : [], server: { proxy }, preview: { proxy } };
});

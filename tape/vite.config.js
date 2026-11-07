import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  base: './', // relative paths so the build works from any host or subfolder
  // Build stamp shown in ME, so you can see which deploy your phone is running.
  define: { __BUILD__: JSON.stringify(`${(process.env.GITHUB_SHA ?? 'local').slice(0, 7)} · ${new Date().toISOString().slice(0, 16).replace('T', ' ')} UTC`) },
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    // Yahoo Finance's chart API has no CORS headers, so the browser calls
    // /yf/... and the dev server forwards it. No API key involved.
    proxy: {
      '/yf': {
        target: 'https://query1.finance.yahoo.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/yf/, ''),
        headers: { 'User-Agent': 'Mozilla/5.0 (TAPE dev proxy)' },
      },
    },
  },
  // `npm run preview` gets the same proxy so the production build can go live too.
  preview: {
    proxy: {
      '/yf': {
        target: 'https://query1.finance.yahoo.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/yf/, ''),
        headers: { 'User-Agent': 'Mozilla/5.0 (TAPE dev proxy)' },
      },
    },
  },
});

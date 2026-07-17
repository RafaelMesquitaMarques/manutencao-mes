import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    // PORT is set by the Claude preview harness when 3000 is taken; the Docker
    // container never sets it, so nginx's frontend:3000 upstream is unaffected.
    port: Number(process.env.PORT) || 3000,
    // Allow serving through a Cloudflare quick tunnel (public demo/presentation).
    // The subdomain changes each run, so allow the whole trycloudflare.com domain.
    // (LAN access by IP is allowed by Vite already; only DNS hosts are gated.)
    allowedHosts: ['.trycloudflare.com'],
    // Bind-mounted from the Windows host into the Docker container, so native
    // fs events don't fire — poll for changes so HMR works. Behind nginx:80,
    // tell the HMR client to connect on port 80 — but only in the container
    // (CHOKIDAR_USEPOLLING is set there): on a host-run `npm run dev` the HMR
    // client must use the dev server's own port, otherwise it reconnects to
    // the container's Vite through nginx and reloads the page in a loop.
    watch: { usePolling: true },
    hmr: process.env.CHOKIDAR_USEPOLLING ? { clientPort: 80 } : undefined,
    // Proxy /api → the backend (published on host:8000) for host-side dev/preview.
    // Harmless in the container: nginx routes /api straight to backend, so the
    // container's Vite never actually receives /api requests.
    // ws: true so the live-update WebSocket (/api/live/ws) also proxies in dev.
    proxy: { '/api': { target: 'http://localhost:8000', ws: true } },
  },
  build: {
    rollupOptions: {
      output: {
        // Stable, individually-cacheable vendor chunks. Pages are lazy-loaded
        // (React.lazy in App.tsx), so a heavy vendor only downloads when a page
        // that uses it is first visited.
        manualChunks(id: string) {
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/]node_modules[\\/](three|@react-three)[\\/]/.test(id)) return 'vendor-three';
          if (/[\\/]node_modules[\\/](echarts|zrender|echarts-for-react)[\\/]/.test(id)) return 'vendor-echarts';
          if (/[\\/]node_modules[\\/]recharts.*[\\/]/.test(id) || /[\\/]node_modules[\\/](d3-|victory-)/.test(id)) return 'vendor-recharts';
          if (/[\\/]node_modules[\\/]ag-grid/.test(id)) return 'vendor-aggrid';
          if (/[\\/]node_modules[\\/]@fullcalendar[\\/]/.test(id)) return 'vendor-fullcalendar';
          if (/[\\/]node_modules[\\/]@xyflow[\\/]/.test(id)) return 'vendor-xyflow';
          return undefined;
        },
      },
    },
  },
})

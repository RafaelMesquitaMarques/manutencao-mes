import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 3000,
    // Bind-mounted from the Windows host into the Docker container, so native
    // fs events don't fire — poll for changes so HMR works. Behind nginx:80,
    // tell the HMR client to connect on port 80.
    watch: { usePolling: true },
    hmr: { clientPort: 80 },
    // Proxy /api → the backend (published on host:8000) for host-side dev/preview.
    // Harmless in the container: nginx routes /api straight to backend, so the
    // container's Vite never actually receives /api requests.
    proxy: { '/api': 'http://localhost:8000' },
  },
})

import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

export default defineConfig({
  plugins: [
    basicSsl()
  ],
  server: {
    host: true, // Listen on all local network addresses
    port: 5173,
    https: true  // Run on HTTPS
  }
});

import { defineConfig } from 'vite';

export default defineConfig({
  base: '/GridCharge-AI/',
  server: {
    host: '0.0.0.0',
    allowedHosts: ['.loca.lt', 'localhost', '127.0.0.1']
  }
});

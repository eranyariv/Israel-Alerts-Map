import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

const OREF_HEADERS = {
  'Referer': 'https://www.oref.org.il/',
  'X-Requested-With': 'XMLHttpRequest',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7',
}

export default defineConfig(({ mode }) => {
const env = loadEnv(mode, process.cwd(), '')
return {
  plugins: [react()],
  base: '/map/',
  server: {
    port: 5173,
    proxy: {
      // HTTPS proxy – used for live alerts and most history candidates
      '/oref': {
        target: 'https://www.oref.org.il',
        changeOrigin: true,
        secure: false,          // accept self-signed / mismatched certs
        rewrite: path => path.replace(/^\/oref/, ''),
        headers: OREF_HEADERS,
      },
      // HTTP proxy – some Oref endpoints still live on plain HTTP
      '/oref-http': {
        target: 'http://www.oref.org.il',
        changeOrigin: true,
        secure: false,
        rewrite: path => path.replace(/^\/oref-http/, ''),
        headers: OREF_HEADERS,
      },
      // alerts-history subdomain proxy
      '/oref-history': {
        target: 'https://alerts-history.oref.org.il',
        changeOrigin: true,
        secure: false,
        rewrite: path => path.replace(/^\/oref-history/, ''),
        headers: OREF_HEADERS,
      },
      // tzevaadom REST API proxy (CORS restricted to their own origin)
      '/tzevaadom': {
        target: 'https://api.tzevaadom.co.il',
        changeOrigin: true,
        secure: false,
        rewrite: path => path.replace(/^\/tzevaadom/, ''),
        headers: { 'Origin': 'https://www.tzevaadom.co.il', 'Referer': 'https://www.tzevaadom.co.il/' },
      },
      // tzevaadom static assets (cities.json)
      '/tzevaadom-static': {
        target: 'https://www.tzevaadom.co.il',
        changeOrigin: true,
        secure: false,
        rewrite: path => path.replace(/^\/tzevaadom-static/, ''),
        headers: { 'Origin': 'https://www.tzevaadom.co.il', 'Referer': 'https://www.tzevaadom.co.il/' },
      },
      // RedAlert REST API proxy (dev only — production uses ra-proxy.php)
      '/redalert-api': {
        target: 'https://redalert.orielhaim.com',
        changeOrigin: true,
        secure: true,
        rewrite: path => path.replace(/^\/redalert-api/, ''),
        headers: { 'X-API-Key': env.VITE_RA_APIKEY, 'Authorization': `Bearer ${env.VITE_RA_APIKEY}` },
      },
    },
  },
}})

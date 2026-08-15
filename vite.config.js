import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    VitePWA({
      registerType: 'autoUpdate',
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg}']
      },
      manifest: {
        name: 'Hardware Shop POS',
        short_name: 'HW-POS',
        description: 'Offline-first point of sale for hardware and phone shops',
        start_url: '/',
        display: 'standalone',
        background_color: '#f8fafc',
        theme_color: '#2563eb',
        lang: 'en',
        icons: [
          {
            src: '/pwa-192x192.png',
            sizes: '192x192',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: '/pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'any'
          },
          {
            src: '/pwa-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable'
          }
        ]
      }
    })
  ],
  build: {
    sourcemap: false,
    rollupOptions: {
      output: {
        // Extract shared code into stable chunks so lazy pages (e.g. POS) never
        // statically import the entry bundle. That circular dependency caused a
        // "Cannot access 'x' before initialization" TDZ crash when the POS chunk
        // evaluated while the entry chunk was still initializing.
        manualChunks(id) {
          if (!id.includes('node_modules')) {
            // Source-level modules shared by the app shell and lazy pages
            if (
              /[\\/](api\/supabaseClient|context\/AuthContext|db\/localDatabase|utils\/(syncManager|phoneUtils)|hooks\/(useRealtime|useSyncStatus|useSessionTimeout))\.(jsx?|tsx?)$/.test(id)
            ) {
              return 'shared-core'
            }
            return undefined
          }
          if (id.includes('node_modules/lucide-react')) return 'vendor-lucide'
          if (id.includes('node_modules/@supabase')) return 'vendor-supabase'
          if (id.includes('node_modules/react-hot-toast')) return 'vendor-toast'
          if (id.includes('node_modules/html5-qrcode')) return 'vendor-qrcode'
          if (id.includes('node_modules/dexie')) return 'vendor-dexie'
          if (id.includes('node_modules/recharts')) return 'vendor-recharts'
          if (id.includes('node_modules/qz-tray')) return 'vendor-qz'
          if (
            id.includes('node_modules/react') ||
            id.includes('node_modules/react-dom') ||
            id.includes('node_modules/react-router') ||
            id.includes('node_modules/scheduler')
          ) {
            return 'vendor-react'
          }
          return undefined
        }
      }
    }
  }
})

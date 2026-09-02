import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

const backend = process.env.API_TARGET || 'http://127.0.0.1:3000'
// The heart-rate bridge (../hr-bridge). Proxied rather than hit directly so the
// dev server behaves like the nginx in front of the built app: same origin, no
// CORS, and Settings' bridge-address field can stay empty in both.
const hr = process.env.HR_TARGET || 'http://127.0.0.1:3001'

// Exercise images and GIFs live in ../media, outside the frontend, because the
// Docker build mounts them into nginx as a volume rather than baking 137 MB into
// the image. `npm run dev` used to proxy /img and /gif to a static server on
// :8888 that nothing in the repo ever starts, so every exercise thumbnail in
// development was a broken image. Serving the folder straight from disk means
// `npm run dev` shows the same app the container does, with nothing else to run.
// MEDIA_TARGET still wins if you would rather proxy somewhere.
function mediaFromDisk(dir) {
  return {
    name: 'opengym-media',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const m = /^\/(img|gif)\/([^?#]+)/.exec(req.url || '')
        if (!m) return next()
        // decodeURIComponent + basename: the request is a filename, never a path,
        // so nothing here can walk out of the media folder.
        const file = path.join(dir, m[1], path.basename(decodeURIComponent(m[2])))
        fs.stat(file, (err, st) => {
          if (err || !st.isFile()) return next()
          res.setHeader('Content-Type', m[1] === 'gif' ? 'image/gif' : 'image/jpeg')
          res.setHeader('Cache-Control', 'public, max-age=86400')
          fs.createReadStream(file).pipe(res)
        })
      })
    }
  }
}

const mediaDir = path.resolve(here, '../media')
const mediaTarget = process.env.MEDIA_TARGET
const haveMedia = !mediaTarget && fs.existsSync(path.join(mediaDir, 'img'))
if (!mediaTarget && !haveMedia) {
  console.warn('[opengym] ../media/img not found — exercise images will be blank.\n' +
    '[opengym] Run ./scripts/fetch-media.sh from the repo root to fetch them (~140 MB, once).')
}

export default defineConfig({
  plugins: [react(), ...(haveMedia ? [mediaFromDisk(mediaDir)] : [])],
  base: './',
  server: {
    proxy: {
      '/api': { target: backend, changeOrigin: true },
      // ws:true is what carries /hr/ws — without it the live feed never opens.
      '/hr': { target: hr, changeOrigin: true, ws: true, rewrite: p => p.replace(/^\/hr/, '') },
      ...(mediaTarget ? {
        '/img': { target: mediaTarget, changeOrigin: true },
        '/gif': { target: mediaTarget, changeOrigin: true }
      } : {})
    }
  },
  build: { chunkSizeWarningLimit: 1500 }
})

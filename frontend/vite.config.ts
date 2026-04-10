import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  base: process.env.DOCKER_BUILD ? '/squash/' : '/',
  build: {
    outDir: 'dist'
  }
})

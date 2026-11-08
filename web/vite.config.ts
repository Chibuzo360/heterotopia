import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// base './' lets the built app work from any folder, including GitHub Pages at /heterotopia/.
export default defineConfig({
  base: './',
  plugins: [react()],
})

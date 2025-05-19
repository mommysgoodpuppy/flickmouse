import { defineConfig } from 'vite'
import deno from '@deno/vite-plugin'
import react from '@vitejs/plugin-react'
import process from "node:process";

// https://vite.dev/config/
export default defineConfig({
  base: "/" + process.env.GITHUB_REPOSITORY?.split("/").pop() || "{app_name}",
  plugins: [deno(), react()],
})

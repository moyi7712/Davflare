import path from "node:path";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

// 本地开发：npm run dev（默认 5173），/api 代理到本机 daemon 管理平面
export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(__dirname, "./src") },
  },
  server: {
    proxy: { "/api": "http://127.0.0.1:9001" },
  },
  build: { outDir: "dist" },
});

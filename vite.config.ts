import { defineConfig, loadEnv } from 'vite'
import react from '@vitejs/plugin-react'

// https://vitejs.dev/config/
export default defineConfig(({ mode }) => {
  // Load các biến môi trường từ file .env (nếu có)
  // Tham số thứ 3 là '' để load tất cả các biến (không bắt buộc phải bắt đầu bằng VITE_)
  const env = loadEnv(mode, (process as any).cwd(), '');

  return {
    plugins: [react()],
    base: './', // Quan trọng cho đường dẫn file trên Android (file://)
    build: {
      outDir: 'dist',
    },
    define: {
      // Thay thế chuỗi 'process.env.API_KEY' trong code bằng giá trị thực tế khi build
      'process.env.API_KEY': JSON.stringify(env.API_KEY),
    }
  }
})
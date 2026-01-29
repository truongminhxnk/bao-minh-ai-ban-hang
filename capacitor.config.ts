import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.baominh.smartstore',
  appName: 'Bảo Minh Smart AI',
  webDir: 'dist',
  server: {
    androidScheme: 'https',
    // Cho phép kết nối HTTP (quan trọng để kết nối với ESP32 không có SSL)
    cleartext: true 
  },
  plugins: {
    // Cấu hình quyền cho Android
    Permissions: {
      display: true
    }
  }
};

export default config;
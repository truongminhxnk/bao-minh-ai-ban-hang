# Hướng dẫn Setup Icon cho Android

## Tự động Generate Icons

Ứng dụng đã được cấu hình để sử dụng `icon.ico` làm icon mặc định.

### Bước 1: Convert icon.ico thành PNG

File `icon.ico` hiện tại cần được convert thành PNG với kích thước **1024x1024px**.

**Các cách convert:**

1. **Tool online (Khuyến nghị):**
   - Truy cập: https://convertio.co/ico-png/
   - Upload file `icon.ico`
   - Download file PNG
   - Resize về 1024x1024px nếu cần

2. **ImageMagick (nếu đã cài đặt):**
   ```bash
   magick convert icon.ico -resize 1024x1024 assets/icon.png
   ```

3. **Hoặc bất kỳ tool convert nào khác**

### Bước 2: Đặt file vào thư mục assets

1. Tạo thư mục `assets/` nếu chưa có
2. Đặt file PNG đã convert vào: `assets/icon.png` (1024x1024px)

### Bước 3: Generate Icons tự động

Sau khi có file `assets/icon.png`, chạy lệnh:

```bash
npm run generate:icons
```

Hoặc chạy trực tiếp:

```bash
npx @capacitor/assets generate --android
```

Lệnh này sẽ tự động tạo tất cả các kích thước icon cần thiết trong thư mục `android/app/src/main/res/mipmap-*`

## Kích thước icon được tạo:

- **mipmap-mdpi**: 48x48px
- **mipmap-hdpi**: 72x72px  
- **mipmap-xhdpi**: 96x96px
- **mipmap-xxhdpi**: 144x144px
- **mipmap-xxxhdpi**: 192x192px

Cả icon thường (`ic_launcher`) và icon tròn (`ic_launcher_round`) sẽ được tạo tự động.

## Favicon cho Web

Icon đã được cấu hình trong `index.html` để sử dụng `icon.ico` làm favicon. File này được serve từ thư mục `public/icon.ico`.

## Lưu ý

- File `icon.ico` đã được copy vào `public/icon.ico` để sử dụng làm favicon
- Android sẽ tự động sử dụng icons từ thư mục `mipmap-*` sau khi generate
- Không cần chỉnh sửa `AndroidManifest.xml` - nó đã được cấu hình sẵn

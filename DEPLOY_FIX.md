# Sửa lỗi 404 (index.tsx, index.css) trên GitHub Pages

## Nguyên nhân
Trang đang dùng **source** (thư mục gốc) nên trình duyệt tải `index.html` có link tới `/index.tsx` và `/index.css` → 404.

## Cách sửa (bắt buộc)

### Bước 1: Chuyển GitHub Pages sang GitHub Actions
1. Vào repo trên GitHub → **Settings** (Cài đặt).
2. Trong menu trái chọn **Pages**.
3. Ở mục **Build and deployment** → **Source**:
   - Chọn **GitHub Actions** (không chọn "Deploy from a branch").

### Bước 2: Đảm bảo đã push workflow và code
```bash
git add .
git commit -m "fix: deploy via GitHub Actions"
git push origin main
```
(Nếu nhánh mặc định là `master` thì dùng `git push origin master`.)

### Bước 3: Chờ workflow chạy xong
1. Vào tab **Actions** của repo.
2. Chọn run workflow **Deploy to GitHub Pages** vừa chạy.
3. Đợi đến khi cả 2 job **build** và **deploy** đều thành công (dấu ✓).

### Bước 4: Kiểm tra lại trang
- Mở lại URL GitHub Pages (hoặc Ctrl+F5 / hard refresh để tránh cache).
- Nếu đúng, trang sẽ load JS/CSS đã build (không còn 404 `index.tsx` / `index.css`).

---
**Lưu ý:** Chừng nào **Source** vẫn là "Deploy from a branch", trang sẽ tiếp tục dùng source và vẫn lỗi 404. Phải chọn **GitHub Actions** thì mới deploy được thư mục `dist/` đã build.

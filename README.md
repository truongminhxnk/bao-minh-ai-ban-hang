<div align="center">
<img width="1200" height="475" alt="GHBanner" src="https://github.com/user-attachments/assets/0aa67016-6eaf-458a-adb2-6e31a0763ed6" />
</div>

# Run and deploy your AI Studio app

This contains everything you need to run your app locally.

View your app in AI Studio: https://ai.studio/apps/drive/1D_wr266y_XSKOUJVN6GNxKJ3l2hGtJtR

## Run Locally

**Prerequisites:**  Node.js


1. Install dependencies:
   `npm install`
2. Set the `GEMINI_API_KEY` in [.env.local](.env.local) to your Gemini API key
3. Run the app:
   `npm run dev`

## Deploy lên GitHub Pages

**Quan trọng:** Phải deploy **thư mục build** (`dist/`), không deploy source (nếu không sẽ bị 404 `index.tsx`, `index.css` và chỉ thấy giao diện tím).

### Cách 1: Tự động bằng GitHub Actions (khuyến nghị)

1. Trong repo GitHub: **Settings → Pages → Build and deployment → Source** chọn **GitHub Actions**.
2. Push code lên nhánh `main`. Workflow `.github/workflows/deploy-pages.yml` sẽ chạy: build và deploy `dist/` lên GitHub Pages.
3. (Tùy chọn) Thêm API key: **Settings → Secrets and variables → Actions** → New repository secret, tên `API_KEY`, value là key Google AI Studio.

### Cách 2: Build local rồi đẩy thư mục dist

```bash
npm ci
npm run build
# Đẩy nội dung thư mục dist/ lên nhánh gh-pages hoặc dùng tool deploy (vd: gh-pages, Netlify).
```

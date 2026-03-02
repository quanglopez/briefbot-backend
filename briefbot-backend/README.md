# BriefBot Backend

Backend cho **BriefBot** — SaaS AI-powered creative brief generator. Cung cấp API scrape nội dung (TikTok, Facebook, Shopee), phân tích video/comments bằng Claude & Gemini, và tạo creative brief + script outline.

## Tech stack

- **Runtime:** Node.js 20+, TypeScript (strict)
- **Server:** Express.js
- **Database:** Supabase (Postgres)
- **Queue:** BullMQ + Redis
- **AI:** Anthropic (Claude), Google (Gemini)
- **Scraping:** Playwright
- **Validation:** Zod | **Logging:** Pino

## Cài đặt

```bash
cp .env.example .env
# Điền SUPABASE_*, ANTHROPIC_API_KEY, GEMINI_API_KEY, REDIS_URL, ...
npm install
```

## Chạy

- **Dev:** `npm run dev` (tsx watch)
- **Build:** `npm run build`
- **Start:** `npm start`
- **Docker:** `docker build -t briefbot-backend . && docker run -p 3001:3001 --env-file .env briefbot-backend`

## API

- `GET /health` — Health check
- `POST /api/scrape` — Scrape URL (body: `{ url, platform: "tiktok"|"facebook"|"shopee" }`)
- `POST /api/analyze/video` — Phân tích video (body: `{ videoPath }`)
- `POST /api/analyze/comments` — Phân tích comments (body: `{ comments: string[] }`)
- `POST /api/analyze/hook` — Hook detection (body: video analysis object)
- `POST /api/brief/generate` — Tạo creative brief từ analysis
- `POST /api/brief/script` — Tạo script outline từ brief (body: `{ brief }`)
- `POST /api/webhook/scrape` — Webhook scrape
- `POST /api/webhook/analyze` — Webhook analyze

## Cấu trúc

- `src/config` — Env (Zod), Supabase, AI clients
- `src/routes` — Express routers
- `src/services` — Scrapers, analyzers, generators, BullMQ workers
- `src/utils` — Rate limit, proxy, video download, logger
- `src/types` — Shared TypeScript types

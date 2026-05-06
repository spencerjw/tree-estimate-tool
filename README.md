# TreePro — AI Tree Estimate Tool

A mobile-first web app that lets customers upload photos of their trees and receive an instant AI-powered price estimate for removal, trimming, storm damage cleanup, or emergency service.

## How It Works

1. Customer fills out a short form (name, email, phone, zip, service type)
2. Uploads 1–3 photos of their tree(s)
3. A Vercel serverless function sends the photos to Claude's vision API
4. Claude analyzes species, size, condition, and complexity, then returns a structured JSON estimate
5. The estimate is rendered as a professional card with line items and a total range
6. Lead data is logged server-side (ready to forward to your CRM or webhook)

---

## Local Development

### 1. Prerequisites

- [Node.js 18+](https://nodejs.org/)
- [Vercel CLI](https://vercel.com/docs/cli): `npm i -g vercel`
- An [Anthropic API key](https://console.anthropic.com/)

### 2. Clone & install

```bash
git clone https://github.com/YOUR_USERNAME/tree-estimate-tool.git
cd tree-estimate-tool
npm install
```

### 3. Set up environment variables

```bash
cp .env.example .env
# Edit .env and paste your Anthropic API key
```

`.env`:
```
ANTHROPIC_API_KEY=sk-ant-...
```

### 4. Run locally

```bash
vercel dev
```

Open `http://localhost:3000`.

> **Why `vercel dev`?** The app uses a Vercel serverless function (`/api/estimate.js`) to keep the API key server-side. `vercel dev` emulates that locally. Plain `open index.html` will not work — the API call will 404.

---

## Deploy to Vercel (one step)

### Option A — Vercel CLI

```bash
vercel --prod
```

When prompted, add the environment variable:

| Key | Value |
|-----|-------|
| `ANTHROPIC_API_KEY` | `sk-ant-...` |

### Option B — Vercel Dashboard

1. Push this repo to GitHub
2. Go to [vercel.com/new](https://vercel.com/new) → Import your repository
3. Under **Environment Variables**, add `ANTHROPIC_API_KEY`
4. Click **Deploy**

No build step required — Vercel detects the serverless function automatically.

---

## Deploy to Netlify

Netlify needs a slightly different function format. The quickest path:

1. Copy `api/estimate.js` to `netlify/functions/estimate.js`
2. Change `export default function handler(req, res)` to the Netlify function signature:
   ```js
   export const handler = async (event) => { ... }
   ```
3. Update `CONFIG.API_ENDPOINT` in `js/app.js` to `'/.netlify/functions/estimate'`
4. Add `ANTHROPIC_API_KEY` in the Netlify dashboard under **Site settings → Environment variables**

---

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | ✅ | Your Anthropic API key |
| `LEAD_WEBHOOK_URL` | Optional | POST endpoint for leads (Zapier, Make, etc.) — see `api/estimate.js` |

---

## Customization

### Company branding
Search for `TODO` in the codebase — there are ~4 spots to swap in your company name, phone number, and logo.

### Phone number (CTA button)
`index.html` line with `href="tel:+15125550100"` — replace with your number.

### AI pricing ranges
Edit the `SYSTEM_PROMPT` constant in `api/estimate.js`. The pricing guide section is clearly labeled and broken out by service type. Each line shows low–high ranges that Claude uses to generate estimates.

### Claude model
`api/estimate.js` uses `claude-sonnet-4-5`. To upgrade to the latest Sonnet, change the `model` field to `claude-sonnet-4-6`.

### Lead capture / CRM
Find the `LEAD CAPTURE` comment block in `api/estimate.js` and replace the `console.log` with a `fetch()` to your webhook URL (Zapier, Make, HubSpot, etc.).

---

## Project Structure

```
tree-estimate-tool/
├── api/
│   └── estimate.js        # Vercel serverless function — Claude API proxy + lead logging
├── css/
│   └── styles.css         # Mobile-first styles, CSS custom properties
├── js/
│   └── app.js             # Form validation, image resize, API call, results render
├── index.html             # Single-page app shell
├── .env.example           # Copy to .env and add your API key
├── package.json
└── README.md
```

---

## Before Going Live — Required TODOs

- [ ] Replace `TreePro` name and logo (`index.html` header)
- [ ] Replace placeholder phone number `(512) 555-0100` with your real number
- [ ] Replace license/insurance placeholder text in the footer
- [ ] Wire up lead capture webhook in `api/estimate.js`
- [ ] Set `Access-Control-Allow-Origin` in `api/estimate.js` to your actual domain (not `*`)
- [ ] Add a privacy policy page and link it (required for GDPR/CCPA if collecting EU/CA leads)
- [ ] Consider rate-limiting the `/api/estimate` endpoint to prevent API key abuse
- [ ] Test on real tree photos before launch

---

## Security Notes

- The Anthropic API key is **never exposed to the browser** — all Claude calls go through the serverless function
- Images are resized client-side before upload (max 1200px) to limit payload size and cost
- No images are stored — they exist only for the duration of the API call
- CORS is currently set to `*` — restrict this to your domain before launch

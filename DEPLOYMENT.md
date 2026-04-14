# Cloud Deployment Guide

This guide walks you through deploying Council of AIs with:

| Layer | Service |
|-------|---------|
| Frontend (UI) | Dreamhost static hosting |
| API | Cloudflare Workers |
| Database | Cloudflare D1 (SQLite) |
| Authentication | Auth0 |

```
Browser
 ├── Static files ──────→ Dreamhost  (index.html + images + favicon)
 ├── Auth ──────────────→ Auth0      (login / JWT tokens)
 └── API calls ─────────→ Cloudflare Workers
                              ├── JWT validation (Auth0 JWKS)
                              ├── Session orchestration (4 LLMs)
                              ├── D1  (user records)
                              └── LLM APIs (Anthropic / OpenAI / Google / xAI)
```

---

## Prerequisites

- Node.js 18+ installed locally
- A [Cloudflare account](https://dash.cloudflare.com/sign-up) (free tier is fine)
- An [Auth0 account](https://auth0.com/) (free tier allows up to 7 500 MAU)
- Your domain already pointing to Dreamhost

---

## Step 1 — Auth0 setup

### 1.1 Create an Auth0 application

1. Log in to the [Auth0 Dashboard](https://manage.auth0.com/)
2. Go to **Applications → Applications → Create Application**
3. Name: `Council of AIs`
4. Type: **Single Page Application**
5. Click **Create**

### 1.2 Configure allowed URLs

In the application settings, fill in (replacing `https://yoursite.com` with your real Dreamhost domain):

| Field | Value |
|-------|-------|
| Allowed Callback URLs | `https://yoursite.com` |
| Allowed Logout URLs | `https://yoursite.com` |
| Allowed Web Origins | `https://yoursite.com` |

Click **Save Changes**.

### 1.3 Create an API (for the audience claim)

1. Go to **Applications → APIs → Create API**
2. Name: `Council API`
3. Identifier: `https://council-api` (this becomes `AUTH0_AUDIENCE`)
4. Algorithm: RS256
5. Click **Create**

### 1.4 Note your credentials

You'll need these later:

```
AUTH0_DOMAIN    = <your-tenant>.us.auth0.com      (Settings → Domain)
AUTH0_CLIENT_ID = <client id>                      (Settings → Client ID)
AUTH0_AUDIENCE  = https://council-api              (the API identifier above)
```

---

## Step 2 — Cloudflare Workers setup

### 2.1 Install Wrangler CLI

```bash
cd workers/
npm install
```

### 2.2 Log in to Cloudflare

```bash
npx wrangler login
```

### 2.3 Create the D1 database

```bash
npx wrangler d1 create council-of-ai
```

Copy the `database_id` from the output and paste it into `workers/wrangler.toml`:

```toml
[[d1_databases]]
binding = "DB"
database_name = "council-of-ai"
database_id = "PASTE_YOUR_DATABASE_ID_HERE"
```

### 2.4 Run the database migration

```bash
npm run migrate:remote
```

This creates the `users` table in your D1 database.

### 2.5 Set non-secret config in wrangler.toml

Edit `workers/wrangler.toml` and replace the placeholder values:

```toml
[vars]
AUTH0_DOMAIN   = "your-tenant.us.auth0.com"
AUTH0_AUDIENCE = "https://council-api"
ALLOWED_ORIGIN = "https://yoursite.com"          # your Dreamhost domain
```

### 2.6 Set LLM API keys as secrets

These are kept out of source control and set via CLI:

```bash
npx wrangler secret put ANTHROPIC_API_KEY
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put GOOGLE_API_KEY
npx wrangler secret put XAI_API_KEY
```

You only need at least **two** keys. Skip providers you don't want to use.

### 2.7 Deploy the Worker

```bash
npm run deploy
```

Wrangler will print the Worker URL, e.g.:

```
https://council-of-ai.yourname.workers.dev
```

Note this URL — you need it in Step 3.

---

## Step 3 — Configure the frontend

Open `index.html` and replace the four placeholder constants near the top of the
`<script type="module">` block:

```js
const AUTH0_DOMAIN    = 'your-tenant.us.auth0.com';
const AUTH0_CLIENT_ID = 'your_auth0_client_id';
const AUTH0_AUDIENCE  = 'https://council-api';
const API_BASE_URL    = 'https://council-of-ai.yourname.workers.dev';
```

---

## Step 4 — Deploy the frontend to Dreamhost

### 4.1 Files to upload

Upload the following files to your Dreamhost web root
(`/home/yourusername/yoursite.com/`):

```
index.html
site.webmanifest
images/          (directory)
favicon/         (directory)
```

### 4.2 Upload via SFTP

Using any SFTP client (e.g. FileZilla, Cyberduck, or the `sftp` CLI):

```bash
sftp yourusername@yoursite.com
put index.html
put site.webmanifest
put -r images
put -r favicon
bye
```

### 4.3 Enable HTTPS on Dreamhost

1. Log in to the Dreamhost panel → **Websites → Manage Websites**
2. Click your domain → **HTTPS** → Enable **Let's Encrypt** (free)

HTTPS is required because Auth0 callbacks must use a secure origin.

---

## Step 5 — Test the deployment

1. Open `https://yoursite.com` in a browser
2. You should see the **Sign In** overlay
3. Click **Sign In** → Auth0 login page appears
4. After login, you're returned to the Council UI
5. Type a query and verify the four models respond

---

## Troubleshooting

### CORS errors in the browser console

Make sure `ALLOWED_ORIGIN` in `wrangler.toml` exactly matches your Dreamhost
domain (including `https://` and no trailing slash), then re-deploy.

### "Need at least 2 model API keys configured"

At least two of the four `wrangler secret put` commands must have been run with
valid API keys.

### Auth0 "callback URL mismatch"

Double-check that the URL in **Allowed Callback URLs** in the Auth0 dashboard
exactly matches your domain (e.g. `https://yoursite.com`, not
`https://www.yoursite.com`).

### Worker CPU time limit

The free Cloudflare Workers plan includes 100 000 requests/day.  LLM calls
spend most of their time waiting on network I/O (which doesn't count toward
CPU time), so the free plan should be sufficient.  If you hit limits, upgrade
to **Workers Paid** ($5/month) for 30 s CPU time per request.

---

## Architecture notes

### PDF uploads

The Workers runtime does not include a native PDF parser.  The `/api/upload`
endpoint currently extracts raw text only (which works for `.txt`, `.md`,
`.csv`, `.html` files).  To re-enable PDF support, add the
[`unpdf`](https://github.com/unjs/unpdf) package and call
`extractText(buffer)` before the `file.text()` fallback.

### Transcript storage

The Python server saved transcripts to disk.  The Workers version omits
on-disk transcripts; the full conversation text is returned in the `done` SSE
event and kept in the browser's JavaScript memory for follow-up questions.
If you want persistent history, you can extend the D1 schema with a
`sessions` table and write to it from the Worker.

### Scaling

Each Worker invocation is stateless.  You can run thousands of simultaneous
council sessions without any server management.

# 🗂️ Telegram FileStore Bot — Cloudflare Workers

A **production-grade, permanent file store Telegram bot** built on Cloudflare Workers + KV.  
Files are stored via a private Telegram channel, links never expire, and serving is globally fast.

---

## ✨ Features

| Feature | Description |
|---|---|
| `/genlink` | Upload any file → get a permanent shareable link |
| `/batch` | Upload multiple files → one batch page with all files |
| Deep links | `t.me/bot?start=file_ID` — open files directly in Telegram |
| Video streaming | Inline HTML5 player for video files |
| Audio playback | In-browser audio player |
| Image preview | Full-size image display |
| Force subscribe | Users must join channels before using the bot |
| Admin panel | Broadcast, ban, stats, delete via bot commands |
| Rate limiting | Per-user request throttling via KV |
| Dark UI | Mobile-responsive dark-themed file pages |
| Webhook secured | `X-Telegram-Bot-Api-Secret-Token` validation |

---

## 🏗️ Tech Stack

- **Runtime:** Cloudflare Workers (V8 isolates, globally distributed)
- **Storage:** Cloudflare KV (users, files, batches, sessions)
- **File CDN:** Telegram's own CDN via `getFile` API
- **Bot:** Telegram Bot API (webhook, no polling)

---

## 📁 File Structure

```
.
├── workers.js       ← Main Cloudflare Worker
├── wrangler.toml    ← Wrangler config
└── README.md        ← This file
```

---

## 🚀 Deployment Guide

### 1. Prerequisites

```bash
# Install Node.js (v18+) and Wrangler CLI
npm install -g wrangler

# Login to Cloudflare
wrangler login
```

### 2. Create a Telegram Bot

1. Message [@BotFather](https://t.me/BotFather) on Telegram
2. Run `/newbot` and follow the steps
3. Copy the **BOT_TOKEN** you receive
4. Run `/setprivacy` → select your bot → **Disable** (so bot can read files in groups)

### 3. Create a Storage Channel

1. Create a **private Telegram channel** (this is your file database)
2. Add your bot as an **administrator** with "Post Messages" permission
3. Get the channel's numeric ID:
   - Forward any message from the channel to [@userinfobot](https://t.me/userinfobot)
   - Or use: `https://api.telegram.org/bot<TOKEN>/getUpdates` after posting to the channel
   - It will look like `-1001234567890`

### 4. Create KV Namespace

```bash
# Create the KV namespace
wrangler kv:namespace create "KV"

# You'll get output like:
# [[kv_namespaces]]
# binding = "KV"
# id = "abc123..."

# Paste the id into wrangler.toml
```

### 5. Configure wrangler.toml

Edit `wrangler.toml`:

```toml
[vars]
BOT_USERNAME        = "your_bot_username"    # e.g. "myfilestore_bot"
WORKER_URL          = "https://telegram-filestore-bot.YOUR_SUBDOMAIN.workers.dev"
FORCE_SUB_CHANNELS  = "@yourchannel"         # optional, comma-separated
```

### 6. Set Secrets

```bash
# Required
wrangler secret put BOT_TOKEN
# Paste your bot token when prompted

wrangler secret put CHANNEL_ID
# Paste your storage channel ID, e.g.: -1001234567890

wrangler secret put ADMINS
# Paste comma-separated Telegram user IDs, e.g.: 123456789,987654321

wrangler secret put WEBHOOK_SECRET
# Paste any random string, e.g.: my_super_secret_2024
```

### 7. Deploy to Cloudflare

```bash
wrangler deploy
```

You'll get a URL like: `https://telegram-filestore-bot.YOUR_SUBDOMAIN.workers.dev`

### 8. Register the Webhook

```bash
# Replace values with your actual bot token, worker URL, and secret
curl -X POST "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook" \
  -H "Content-Type: application/json" \
  -d '{
    "url": "https://telegram-filestore-bot.YOUR_SUBDOMAIN.workers.dev/webhook",
    "secret_token": "YOUR_WEBHOOK_SECRET",
    "allowed_updates": ["message", "callback_query"]
  }'
```

Expected response:
```json
{"ok":true,"result":true,"description":"Webhook was set"}
```

### 9. Verify Webhook

```bash
curl "https://api.telegram.org/bot<YOUR_BOT_TOKEN>/getWebhookInfo"
```

---

## ⚙️ Environment Variables Reference

| Variable | Where to Set | Description |
|---|---|---|
| `BOT_TOKEN` | `wrangler secret put` | Telegram bot token from BotFather |
| `BOT_USERNAME` | `wrangler.toml [vars]` | Bot username without @ |
| `CHANNEL_ID` | `wrangler secret put` | Private storage channel ID (negative number) |
| `ADMINS` | `wrangler secret put` | Comma-separated admin user IDs |
| `WEBHOOK_SECRET` | `wrangler secret put` | Random string to validate webhook requests |
| `WORKER_URL` | `wrangler.toml [vars]` | Your deployed worker URL |
| `FORCE_SUB_CHANNELS` | `wrangler.toml [vars]` | Channels users must join (comma-separated) |
| `KV` | `wrangler.toml [[kv_namespaces]]` | KV namespace binding |

---

## 🤖 Bot Commands

### User Commands

| Command | Description |
|---|---|
| `/start` | Welcome screen with inline keyboard |
| `/genlink` | Start single file upload → get permanent link |
| `/batch` | Start batch upload session |
| `/done` | Finalize batch and generate batch link |
| `/cancel` | Cancel current operation |

### Admin Commands

| Command | Description |
|---|---|
| `/stats` | View total users, files, batches |
| `/broadcast <message>` | Send message to all users |
| `/delete <file_uid>` | Delete a stored file |
| `/ban <user_id>` | Ban a user |
| `/users` | View user count |

---

## 🔗 URL Routes

| Route | Description |
|---|---|
| `POST /webhook` | Telegram webhook endpoint |
| `GET /file/:id` | File page with download/stream |
| `GET /batch/:id` | Batch page with all files |
| `GET /ping` | Health check |

---

## 📊 KV Data Schema

```
file:<uid>       → { uid, file_id, file_unique_id, storage_message_id,
                     file_name, file_size, mime_type, type, caption,
                     thumbnail, uploaded_by, timestamp }

batch:<uid>      → { id, files: [...], createdBy, timestamp }

session:<userId> → { state, mode, files } — TTL: 1 hour

user:<userId>    → { id, username, first_name, joined }

banned:<userId>  → "1"

counter:total_files   → "42"
counter:total_users   → "10"
counter:total_batches → "5"

rl:<userId>      → { count, window } — rate limit tracker
```

---

## 🔒 Security Notes

- All webhook requests are validated via `X-Telegram-Bot-Api-Secret-Token`
- Rate limiting: 20 requests per 60 seconds per user
- Banned users are blocked from all actions
- Admin commands only work for IDs in `ADMINS`
- File UIDs are 16-char cryptographically random strings

---

## 🐛 Troubleshooting

**Webhook not receiving updates:**
```bash
# Check webhook status
curl "https://api.telegram.org/bot<TOKEN>/getWebhookInfo"
# Verify "url" and "last_error_message" fields
```

**KV reads returning null:**
- Ensure KV namespace ID in `wrangler.toml` matches the created namespace
- Check `wrangler kv:namespace list` to confirm

**Bot can't copy files to storage channel:**
- Confirm the bot is an admin in the channel with "Post Messages" permission
- Verify `CHANNEL_ID` is the correct negative ID

**Force subscribe not working:**
- Ensure the bot is an admin (or at least a member) of the force-sub channels
- Check the channel usernames are correct (with @)

---

## 📦 Quick Deploy (All Steps in One)

```bash
# 1. Install wrangler
npm install -g wrangler && wrangler login

# 2. Create KV
wrangler kv:namespace create "KV"
# Copy the id into wrangler.toml

# 3. Edit wrangler.toml with your BOT_USERNAME and WORKER_URL

# 4. Set secrets
wrangler secret put BOT_TOKEN
wrangler secret put CHANNEL_ID
wrangler secret put ADMINS
wrangler secret put WEBHOOK_SECRET

# 5. Deploy
wrangler deploy

# 6. Set webhook
curl -X POST "https://api.telegram.org/bot<TOKEN>/setWebhook" \
  -d '{"url":"<WORKER_URL>/webhook","secret_token":"<WEBHOOK_SECRET>","allowed_updates":["message","callback_query"]}'
```

---

## 📄 License

MIT — free to use and modify.

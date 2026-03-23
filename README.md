# 📚 Amazon Book Price Monitor

A lightweight Python service that watches Amazon book prices and fires
Telegram notifications on any price drop.  Runs 24/7 on Render's free
**Background Worker** plan.

---

## Features

| Feature | Detail |
|---|---|
| Price monitoring | Parses live Amazon pages with rotating User-Agents |
| Anti-bot bypass | Optional [ScraperAPI](https://scraperapi.com) integration |
| Telegram alerts | Rich HTML messages with old/new price & % drop |
| Add URLs by chat | Send an Amazon URL to your bot → auto-appended to `books.txt` |
| Persistent storage | `prices.json` + `books.txt` survive Render restarts via disk |
| Configurable | Interval, threshold, file paths all via env vars |

---

## Quick Start

### 1 – Create a Telegram Bot

1. Open Telegram and message **@BotFather**.
2. Run `/newbot`, follow the prompts, copy the **token**.
3. Start a chat with your new bot, then visit:
   ```
   https://api.telegram.org/bot<TOKEN>/getUpdates
   ```
   Send any message to the bot first, then refresh the URL.
   Find `"chat":{"id":…}` — that's your **chat ID**.

### 2 – (Recommended) Get a ScraperAPI key

Amazon aggressively blocks datacentre IPs (like Render's).
ScraperAPI handles proxies + JavaScript rendering for you.

- Sign up at <https://scraperapi.com> (free tier: 1 000 req/month).
- Copy your **API key**.

### 3 – Deploy to Render

1. Push this repo to GitHub / GitLab.
2. In the Render dashboard → **New → Background Worker**.
3. Connect your repo; Render auto-detects `render.yaml`.
4. Under **Environment**, add:

   | Key | Value |
   |---|---|
   | `TELEGRAM_TOKEN` | your BotFather token |
   | `TELEGRAM_CHAT_ID` | your chat ID |
   | `SCRAPER_API_KEY` | your ScraperAPI key *(optional)* |

5. Click **Deploy** — done.

The worker will:
- Send a startup message to Telegram.
- Check prices every hour (configurable via `CHECK_INTERVAL_SECONDS`).
- Send a drop alert whenever price falls ≥ 1 % (configurable via `PRICE_DROP_THRESHOLD_PCT`).

---

## Adding Books to Watch

### Method A – Edit `books.txt` directly

The file lives at `/data/books.txt` on the Render disk.
One Amazon URL per line; lines starting with `#` are ignored.

```
# My reading wishlist
https://www.amazon.com/dp/B08D9V3QBN
https://www.amazon.co.uk/dp/1234567890
```

You can edit the file via Render's **Shell** tab or by committing changes
to the repo (the disk path takes precedence).

### Method B – Send URL to the Telegram bot

Just paste any Amazon product URL in the bot chat:

```
https://www.amazon.com/dp/B08D9V3QBN
```

The bot replies `✅ Added to watch list` and appends the URL to `books.txt`.

---

## Environment Variables

| Variable | Default | Description |
|---|---|---|
| `TELEGRAM_TOKEN` | **required** | Bot token from BotFather |
| `TELEGRAM_CHAT_ID` | **required** | Target chat / group ID |
| `SCRAPER_API_KEY` | `""` | ScraperAPI key (empty = direct request) |
| `URLS_FILE` | `books.txt` | Path to the URL list |
| `PRICES_FILE` | `prices.json` | Path to the price cache |
| `CHECK_INTERVAL_SECONDS` | `3600` | Seconds between full scans |
| `PRICE_DROP_THRESHOLD_PCT` | `1` | Minimum % drop to trigger alert |

---

## Running Locally

```bash
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt

export TELEGRAM_TOKEN=xxx
export TELEGRAM_CHAT_ID=yyy

python monitor.py
```

---

## How Anti-Bot Works

Without ScraperAPI the script:
- Rotates 4 different User-Agent strings.
- Adds a random 1.5–4 s delay between requests.
- Limits concurrent connections to 3.

**With ScraperAPI** every request is routed through a residential proxy
with headless-browser rendering (`&render=true`), which reliably bypasses
Amazon's bot detection even from cloud IPs.
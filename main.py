import os
import json
import time
import logging
import asyncio
import random
import re
from pathlib import Path
from datetime import datetime

from dotenv import load_dotenv
load_dotenv()

import httpx
from bs4 import BeautifulSoup
from telegram import Bot
from telegram.constants import ParseMode

# ── Logging ──────────────────────────────────────────────────────────────────
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
log = logging.getLogger(__name__)

# ── Config ────────────────────────────────────────────────────────────────────
# TELEGRAM_TOKEN   = os.environ["TELEGRAM_TOKEN"]
# TELEGRAM_CHAT_ID = os.environ["TELEGRAM_CHAT_ID"]

TELEGRAM_TOKEN   = os.getenv("TELEGRAM_TOKEN", "")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID", "")
print("TELEGRAM_TOKEN:", TELEGRAM_TOKEN)
print("TELEGRAM_CHAT_ID:", TELEGRAM_CHAT_ID)
URLS_FILE        = Path(os.getenv("URLS_FILE", "books.txt"))
PRICES_FILE      = Path(os.getenv("PRICES_FILE", "prices.json"))
CHECK_INTERVAL   = int(os.getenv("CHECK_INTERVAL_SECONDS", "3600"))   # 1 hour
PRICE_DROP_PCT   = float(os.getenv("PRICE_DROP_THRESHOLD_PCT", "1"))  # notify on any drop ≥ 1 %

# ScraperAPI key (optional but strongly recommended for Render deployments)
SCRAPER_API_KEY  = os.getenv("SCRAPER_API_KEY", "")

# ── HTTP helpers ──────────────────────────────────────────────────────────────
USER_AGENTS = [
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 "
    "(KHTML, like Gecko) Version/17.4 Safari/605.1.15",
    "Mozilla/5.0 (X11; Linux x86_64; rv:125.0) Gecko/20100101 Firefox/125.0",
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36 Edg/123.0.0.0",
]

def _headers() -> dict:
    return {
        "User-Agent": random.choice(USER_AGENTS),
        "Accept-Language": "en-US,en;q=0.9",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Encoding": "gzip, deflate, br",
        "Connection": "keep-alive",
        "Upgrade-Insecure-Requests": "1",
        "DNT": "1",
    }

def _build_url(amazon_url: str) -> str:
    """Route through ScraperAPI when a key is provided, otherwise direct."""
    if SCRAPER_API_KEY:
        return (
            f"https://api.scraperapi.com"
            f"?api_key={SCRAPER_API_KEY}"
            f"&url={amazon_url}"
            f"&render=true"
        )
    return amazon_url

# ── Price extraction ──────────────────────────────────────────────────────────
PRICE_SELECTORS = [
    # Current main price block
    ("span", {"class": "a-price-whole"}),
    # Kindle / deal price
    ("span", {"id": "kindle-price"}),
    # Generic corePriceDisplay
    ("span", {"class": "priceToPay"}),
    # Older layout
    ("span", {"id": "priceblock_ourprice"}),
    ("span", {"id": "priceblock_dealprice"}),
    ("span", {"id": "priceblock_saleprice"}),
]

def _parse_price(soup: BeautifulSoup) -> float | None:
    for tag, attrs in PRICE_SELECTORS:
        el = soup.find(tag, attrs)
        if el:
            raw = el.get_text(separator="").strip()
            # keep only digits and decimal separators
            cleaned = re.sub(r"[^\d.,]", "", raw).replace(",", ".")
            # handle "1.234.56" → take last two decimals
            parts = cleaned.split(".")
            if len(parts) > 2:
                cleaned = "".join(parts[:-1]) + "." + parts[-1]
            try:
                return float(cleaned)
            except ValueError:
                continue
    return None

def _parse_title(soup: BeautifulSoup) -> str:
    el = soup.find("span", {"id": "productTitle"})
    return el.get_text(strip=True) if el else "Unknown title"

# ── Fetch one product page ────────────────────────────────────────────────────
async def fetch_product(client: httpx.AsyncClient, url: str) -> dict | None:
    target = _build_url(url)
    try:
        await asyncio.sleep(random.uniform(1.5, 4.0))   # polite delay
        r = await client.get(target, headers=_headers(), follow_redirects=True, timeout=30)
        if r.status_code != 200:
            log.warning("HTTP %s for %s", r.status_code, url)
            return None
        soup = BeautifulSoup(r.text, "html.parser")
        price = _parse_price(soup)
        if price is None:
            log.warning("Could not parse price for %s", url)
            return None
        title = _parse_title(soup)
        return {"title": title, "price": price, "url": url}
    except Exception as exc:
        log.error("Error fetching %s: %s", url, exc)
        return None

# ── Persistence ───────────────────────────────────────────────────────────────
def load_prices() -> dict:
    if PRICES_FILE.exists():
        return json.loads(PRICES_FILE.read_text())
    return {}

def save_prices(data: dict) -> None:
    PRICES_FILE.write_text(json.dumps(data, indent=2, ensure_ascii=False))

def load_urls() -> list[str]:
    if not URLS_FILE.exists():
        log.warning("%s not found – no URLs to monitor.", URLS_FILE)
        return []
    lines = URLS_FILE.read_text().splitlines()
    return [l.strip() for l in lines if l.strip() and not l.startswith("#")]

# ── Telegram ──────────────────────────────────────────────────────────────────
async def send_telegram(bot: Bot, message: str) -> None:
    await bot.send_message(
        chat_id=TELEGRAM_CHAT_ID,
        text=message,
        parse_mode=ParseMode.HTML,
        disable_web_page_preview=False,
    )

def _drop_msg(title: str, old: float, new: float, url: str, currency: str = "USD") -> str:
    drop_pct = (old - new) / old * 100
    return (
        f"📉 <b>Price drop!</b>\n\n"
        f"📖 <b>{title}</b>\n\n"
        f"💰 <s>{old:.2f}</s> → <b>{new:.2f} {currency}</b>  "
        f"(<b>-{drop_pct:.1f}%</b>)\n\n"
        f"🔗 <a href=\"{url}\">View on Amazon</a>\n\n"
        f"<i>Checked: {datetime.utcnow().strftime('%Y-%m-%d %H:%M UTC')}</i>"
    )

# ── Bot command: add URL via Telegram ────────────────────────────────────────
async def telegram_listener(bot: Bot) -> None:
    """
    Long-poll the bot for messages containing Amazon URLs sent directly to it.
    Any message matching amazon.com/…/dp/… is appended to books.txt.
    """
    offset = None
    while True:
        try:
            updates = await bot.get_updates(offset=offset, timeout=20)
            for upd in updates:
                offset = upd.update_id + 1
                msg = upd.message
                if not msg or not msg.text:
                    continue
                # Accept only messages from the configured chat
                if str(msg.chat_id) != str(TELEGRAM_CHAT_ID):
                    continue
                text = msg.text.strip()
                # Check if it looks like an Amazon product URL
                if re.search(r"amazon\.[a-z.]+/.+/dp/[A-Z0-9]{10}", text):
                    clean_url = text.split("?")[0]   # strip tracking params
                    urls = load_urls()
                    if clean_url not in urls:
                        with URLS_FILE.open("a") as f:
                            f.write(clean_url + "\n")
                        await send_telegram(
                            bot,
                            f"✅ Added to watch list:\n<code>{clean_url}</code>",
                        )
                        log.info("Added via Telegram: %s", clean_url)
                    else:
                        await send_telegram(
                            bot, f"ℹ️ Already watching:\n<code>{clean_url}</code>"
                        )
        except Exception as exc:
            log.error("Telegram listener error: %s", exc)
            await asyncio.sleep(5)

# ── Main loop ─────────────────────────────────────────────────────────────────
async def check_once(bot: Bot) -> None:
    urls = load_urls()
    if not urls:
        log.info("No URLs to check.")
        return

    log.info("Checking %d URL(s)…", len(urls))
    known = load_prices()

    limits = httpx.Limits(max_connections=3, max_keepalive_connections=2)
    async with httpx.AsyncClient(limits=limits) as client:
        for url in urls:
            result = await fetch_product(client, url)
            if result is None:
                continue

            title  = result["title"]
            price  = result["price"]
            old    = known.get(url, {}).get("price")

            log.info("%-60s  current=%.2f  previous=%s", title[:60], price, old)

            if old is not None:
                drop = (old - price) / old * 100
                if drop >= PRICE_DROP_PCT:
                    msg = _drop_msg(title, old, price, url)
                    await send_telegram(bot, msg)
                    log.info("  ↳ 🔔 Notified (drop %.1f%%)", drop)

            known[url] = {
                "title": title,
                "price": price,
                "last_checked": datetime.utcnow().isoformat(),
            }

    save_prices(known)
    log.info("Done. Next check in %ds.", CHECK_INTERVAL)

async def main() -> None:
    bot = Bot(token=TELEGRAM_TOKEN)
    await send_telegram(
        bot,
        "🚀 <b>Amazon Price Monitor started!</b>\n"
        f"Watching <code>{URLS_FILE}</code> • checking every "
        f"{CHECK_INTERVAL // 60} min\n\n"
        "Send me an Amazon URL to add it to the watch list.",
    )

    # Run Telegram listener and price checker concurrently
    async def price_loop():
        while True:
            await check_once(bot)
            await asyncio.sleep(CHECK_INTERVAL)

    await asyncio.gather(
        telegram_listener(bot),
        price_loop(),
    )

if __name__ == "__main__":
    asyncio.run(main())
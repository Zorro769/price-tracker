import fs from "fs/promises";
import { chromium } from "playwright";
import TelegramBot from "node-telegram-bot-api";

/* ================= CONFIG ================= */

const CONFIG = {
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || "YOUR_BOT_TOKEN",
    telegramChatId: process.env.TELEGRAM_CHAT_ID || "YOUR_CHAT_ID",

    booksFile: "books.txt",
    pricesFile: "prices.json",

    checkInterval: 1000 * 60 * 60 * 24, // 24h
};

/* ================= TRACKER ================= */

class AmazonPriceTracker {
    constructor() {
        this.bot = new TelegramBot(CONFIG.telegramBotToken, { polling: false });
        this.prices = {};
    }

    /* ---------- INIT ---------- */

    async init() {
        try {
            const data = await fs.readFile(CONFIG.pricesFile, "utf8");
            this.prices = JSON.parse(data);
            console.log("✓ Loaded price history");
        } catch {
            console.log("→ Starting fresh price database");
            this.prices = {};
        }
    }

    async savePrices() {
        await fs.writeFile(
            CONFIG.pricesFile,
            JSON.stringify(this.prices, null, 2)
        );
    }

    /* ---------- URL LOADING ---------- */

    async readBookUrls() {
        const content = await fs.readFile(CONFIG.booksFile, "utf8");

        return content
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l && !l.startsWith("#"));
    }

    /* ---------- SCRAPER ---------- */

    async parseAmazonPage(url) {
        let browser;

        try {
            console.log("→ Fetching:", url);

            const response = await axios.get(url, {
                headers: {
                    'User-Agent': CONFIG.userAgent,
                    'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                },
                timeout: 15000
            });

            const $ = cheerio.load(response.data);

            // Extract title
            let title = $('#productTitle').text().trim();
            if (!title) {
                title = $('h1 span#productTitle').text().trim();
            }
            if (!title) {
                title = $('span.product-title-word-break').text().trim();
            }

            // Extract price - Amazon.pl uses various selectors
            /* ----- PRICE ----- */

            const priceSelectors = [
                ".a-price .a-offscreen",
                "#corePrice_feature_div .a-offscreen",
                "#corePriceDisplay_desktop_feature_div .a-offscreen",
                "span.priceToPay .a-offscreen",
                ".a-price[data-a-color='price'] .a-offscreen",
                "span.a-price-whole",
            ];

            let priceText = null;

            for (const selector of priceSelectors) {
                const locator = page.locator(selector).first();

                if (await locator.count()) {
                    priceText = await locator.textContent();

                    if (priceText && priceText.trim().length > 0) {
                        break;
                    }
                }
            }

            /* ----- HARD FALLBACK (whole + fraction) ----- */

            if (!priceText) {
                const whole = await page
                    .locator("span.a-price-whole")
                    .first()
                    .textContent()
                    .catch(() => null);

                const fraction = await page
                    .locator("span.a-price-fraction")
                    .first()
                    .textContent()
                    .catch(() => null);

                if (whole) {
                    priceText = whole + (fraction || "");
                }
            }

            if (!priceText) {
                console.log("✗ Could not find price");
                return null;
            }

            const match = priceText.match(/[\d\s]+[,.]?\d*/);

            if (!match) return null;

            const price = parseFloat(
                match[0].replace(/\s/g, "").replace(",", ".")
            );

            console.log(`✓ ${title.trim()} → ${price} zł`);

            return {
                url,
                title: title.trim(),
                price,
                currency: "PLN",
                timestamp: new Date().toISOString()
            };

        } catch (err) {
            console.error("✗ Scraping error:", err.message);
            return null;
        } finally {
            if (browser) await browser.close();
        }
    }

    /* ---------- TELEGRAM ---------- */

    async sendTelegramNotification(bookData, oldPrice, newPrice) {
        const drop = oldPrice - newPrice;
        const percent = ((drop / oldPrice) * 100).toFixed(2);

        const message =
            `📉 *Price Drop Alert*\n\n` +
            `📚 ${bookData.title}\n\n` +
            `💰 Old: ${oldPrice.toFixed(2)} zł\n` +
            `💵 New: ${newPrice.toFixed(2)} zł\n` +
            `📊 Saved: ${drop.toFixed(2)} zł (${percent}%)\n\n` +
            `🔗 [Amazon Link](${bookData.url})`;

        try {
            await this.bot.sendMessage(CONFIG.telegramChatId, message, {
                parse_mode: "Markdown"
            });

            console.log("✓ Telegram alert sent");
        } catch (err) {
            console.error("✗ Telegram error:", err.message);
        }
    }

    /* ---------- PRICE CHECK ---------- */

    async checkPrices() {
        console.log("\n=== Checking Prices ===\n");

        const urls = await this.readBookUrls();

        let checked = 0;
        let drops = 0;

        for (const url of urls) {
            if (checked > 0)
                await new Promise((r) => setTimeout(r, 3000));

            const book = await this.parseAmazonPage(url);

            if (!book) continue;

            checked++;

            if (this.prices[url]) {
                const oldPrice = this.prices[url].price;
                const newPrice = book.price;

                if (newPrice < oldPrice) {
                    console.log("🎉 PRICE DROP");
                    drops++;

                    await this.sendTelegramNotification(
                        book,
                        oldPrice,
                        newPrice
                    );
                } else if (newPrice > oldPrice) {
                    console.log(`📈 Price increased → ${newPrice}`);
                } else {
                    console.log(`➡ Price unchanged`);
                }
            } else {
                console.log("ℹ First time tracking");
            }

            this.prices[url] = book;
            console.log("");
        }

        await this.savePrices();

        console.log("=== Done ===");
        console.log("Checked:", checked);
        console.log("Drops:", drops);
    }

    /* ---------- LOOP ---------- */

    async startMonitoring() {
        console.log("🚀 Tracker started\n");

        await this.checkPrices();

        setInterval(() => {
            this.checkPrices();
        }, CONFIG.checkInterval);
    }
}

/* ================= MAIN ================= */

(async () => {
    try {
        const tracker = new AmazonPriceTracker();
        await tracker.init();

        if (process.argv.includes("--once")) {
            await tracker.checkPrices();
            process.exit(0);
        }

        await tracker.startMonitoring();

    } catch (err) {
        console.error("Fatal:", err);
        process.exit(1);
    }
})();

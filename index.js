require("dotenv").config();
const fs = require("fs").promises;
const axios = require("axios");
const cheerio = require("cheerio");
const TelegramBot = require("node-telegram-bot-api");
const express = require("express");

/* ================= CONFIG ================= */
const CONFIG = {
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramChatId: process.env.TELEGRAM_CHAT_ID,
    booksFile: "books.txt",
    pricesFile: "prices.json",
    progressFile: "progress.json",
    batchSize: 4,
    batchPauseMs: 8 * 60 * 1000, // 8 minutes
    requestTimeout: 20000,
};

/* ================= EXPRESS SERVER ================= */
const app = express();

// Disable etag to prevent caching issues
app.set('etag', false);

// Health check route - fixed to prevent double response
app.get("/", (req, res) => {
    res.set('Cache-Control', 'no-store');
    return res.status(200).send("Tracker alive");
});

// Status endpoint (optional - for debugging)
app.get("/status", (req, res) => {
    res.set('Cache-Control', 'no-store');
    return res.status(200).json({
        status: "running",
        timestamp: new Date().toISOString()
    });
});

// 404 handler
app.use((req, res) => {
    return res.status(404).send("Not found");
});

// Error handler
app.use((err, req, res, next) => {
    console.error("Express error:", err.message);
    if (!res.headersSent) {
        return res.status(500).send("Internal error");
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

/* ================= HELPERS ================= */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================= TRACKER CLASS ================= */
class AmazonPriceTracker {
    constructor() {
        this.bot = new TelegramBot(CONFIG.telegramBotToken, { polling: false });
        this.prices = {};

        this.userAgents = [
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/121.0.0.0",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Firefox/122.0",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605.1.15",
        ];

        this.isRunning = false; // prevent overlapping batches
    }

    // Load prices/progress files safely
    async loadJSON(file, fallback) {
        try {
            const data = await fs.readFile(file, "utf8");
            return JSON.parse(data);
        } catch {
            return fallback;
        }
    }

    async saveJSON(file, data) {
        await fs.writeFile(file, JSON.stringify(data, null, 2));
    }

    async init() {
        this.prices = await this.loadJSON(CONFIG.pricesFile, {});
        console.log("✓ Tracker initialized");
    }

    async readBookUrls() {
        const content = await fs.readFile(CONFIG.booksFile, "utf8");
        return content
            .split("\n")
            .map((x) => x.trim())
            .filter((x) => x && !x.startsWith("#"));
    }

    // Scrape Amazon page
    async parseAmazonPage(url, retry = 0) {
        try {
            const ua =
                this.userAgents[Math.floor(Math.random() * this.userAgents.length)];

            const res = await axios.get(url, {
                timeout: CONFIG.requestTimeout,
                headers: {
                    "User-Agent": ua,
                    "Accept-Language": "pl-PL,pl;q=0.9,en;q=0.8",
                    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                },
            });

            const $ = cheerio.load(res.data);

            const title = $("#productTitle").text().trim() || "Unknown Title";

            let priceText =
                $(".a-price .a-offscreen").first().text().trim() ||
                $("span.priceToPay .a-offscreen").first().text().trim();

            if (!priceText) {
                console.log("✗ No price found:", url);
                return null;
            }

            const price = parseFloat(priceText.replace(/[^\d,]/g, "").replace(",", "."));

            console.log(`✓ ${title.substring(0, 40)}... - ${price} zł`);

            return {
                url,
                title,
                price,
                timestamp: new Date().toISOString(),
            };
        } catch (err) {
            if (retry < 2) {
                console.log(`⚠ Retry ${retry + 1} for ${url}`);
                await sleep(5000 * (retry + 1));
                return this.parseAmazonPage(url, retry + 1);
            }
            console.log("✗ Parse failed:", url, err.message);
            return null;
        }
    }

    async notifyDrop(book, oldPrice) {
        const diff = oldPrice - book.price;
        const percent = ((diff / oldPrice) * 100).toFixed(2);
        
        const msg =
            `📉 *Price Drop Alert!*\n\n` +
            `📚 ${book.title}\n\n` +
            `💰 Old: ${oldPrice.toFixed(2)} zł\n` +
            `💵 New: ${book.price.toFixed(2)} zł\n` +
            `📊 Saved: ${diff.toFixed(2)} zł (${percent}%)\n\n` +
            `🔗 ${book.url}`;

        try {
            await this.bot.sendMessage(CONFIG.telegramChatId, msg, {
                parse_mode: "Markdown"
            });
            console.log("✓ Telegram notification sent");
        } catch (err) {
            console.log("✗ Telegram error:", err.message);
        }
    }

    // Batch processor
    async runBatch() {
        if (this.isRunning) {
            console.log("⚠ Batch already running, skipping");
            return;
        }
        
        this.isRunning = true;

        try {
            const urls = await this.readBookUrls();
            const progress = await this.loadJSON(CONFIG.progressFile, { index: 0 });

            const start = progress.index;
            const end = Math.min(start + CONFIG.batchSize, urls.length);

            console.log(`\n=== Processing batch ${start} → ${end - 1} of ${urls.length} ===`);

            for (let i = start; i < end; i++) {
                const url = urls[i];
                const data = await this.parseAmazonPage(url);
                
                if (!data) continue;

                if (this.prices[url] && data.price < this.prices[url].price) {
                    console.log("🎉 PRICE DROP DETECTED!");
                    await this.notifyDrop(data, this.prices[url].price);
                }

                this.prices[url] = data;
                
                // Small delay between requests in the same batch
                if (i < end - 1) {
                    await sleep(2000);
                }
            }

            await this.saveJSON(CONFIG.pricesFile, this.prices);

            // Update progress
            if (end >= urls.length) {
                await this.saveJSON(CONFIG.progressFile, { index: 0 });
                console.log("✓ Full cycle completed. Starting over.\n");
            } else {
                await this.saveJSON(CONFIG.progressFile, { index: end });
                console.log(`✓ Batch complete. Next batch starts at ${end}\n`);
            }
        } catch (err) {
            console.error("✗ Batch error:", err.message);
        } finally {
            this.isRunning = false;
        }
    }

    async startWorker() {
        console.log("🚀 Worker started");
        console.log(`⏰ Batch size: ${CONFIG.batchSize}`);
        console.log(`⏰ Pause between batches: ${CONFIG.batchPauseMs / 60000} minutes\n`);
        
        while (true) {
            try {
                await this.runBatch();
            } catch (err) {
                console.error("✗ Worker error:", err.message);
            }
            
            console.log(`⏳ Waiting ${CONFIG.batchPauseMs / 60000} minutes until next batch...\n`);
            await sleep(CONFIG.batchPauseMs);
        }
    }
}

/* ================= START WORKER ================= */
(async () => {
    try {
        const tracker = new AmazonPriceTracker();
        await tracker.init();
        tracker.startWorker(); // run independently, no await
    } catch (err) {
        console.error("✗ Fatal error:", err.message);
        process.exit(1);
    }
})();
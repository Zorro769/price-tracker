require("dotenv").config();
const fs = require("fs").promises;
const axios = require("axios");
const cheerio = require("cheerio");
const TelegramBot = require("node-telegram-bot-api");
const express = require("express");

/* ================= CONFIGURATION ================= */
const CONFIG = {
    // Telegram
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramChatId: process.env.TELEGRAM_CHAT_ID,
    
    // Files
    booksFile: "books.txt",
    pricesFile: "prices.json",
    progressFile: "progress.json",
    
    // Anti-blocking settings
    batchSize: 3,                    // Process only 3 books at a time
    batchPauseMinutes: 5,            // Wait 5 minutes between batches (reduced for Render free tier)
    requestDelaySeconds: 8,          // 8 seconds between each request
    randomDelayRange: 5,             // +/- random 0-5 seconds
    maxRetries: 3,                   // Retry failed requests 3 times
    requestTimeout: 30000,           // 30 second timeout
    
    // Proxy (optional - set PROXY_URL in environment if using)
    proxyUrl: process.env.PROXY_URL, // e.g., http://user:pass@proxy:port
};

/* ================= UTILITIES ================= */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const randomDelay = () => {
    const base = CONFIG.requestDelaySeconds * 1000;
    const random = Math.random() * CONFIG.randomDelayRange * 1000;
    return base + random;
};

const log = {
    info: (msg) => console.log(`[${new Date().toISOString()}] ℹ ${msg}`),
    success: (msg) => console.log(`[${new Date().toISOString()}] ✓ ${msg}`),
    error: (msg) => console.log(`[${new Date().toISOString()}] ✗ ${msg}`),
    warning: (msg) => console.log(`[${new Date().toISOString()}] ⚠ ${msg}`),
    drop: (msg) => console.log(`[${new Date().toISOString()}] 🎉 ${msg}`),
};

/* ================= EXPRESS SERVER (for Render) ================= */
const app = express();
app.disable('x-powered-by');
app.set('etag', false);

// Middleware to prevent double sends
app.use((req, res, next) => {
    const originalSend = res.send;
    const originalJson = res.json;
    let responseSent = false;

    res.send = function(data) {
        if (!responseSent) {
            responseSent = true;
            originalSend.call(this, data);
        }
    };

    res.json = function(data) {
        if (!responseSent) {
            responseSent = true;
            originalJson.call(this, data);
        }
    };

    next();
});

app.get("/", (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.status(200).json({
        status: "running",
        message: "Amazon Price Tracker is active",
        timestamp: new Date().toISOString()
    });
});

app.get("/health", (req, res) => {
    res.status(200).send("OK");
});

// Error handlers
app.use((req, res) => {
    if (!res.headersSent) {
        res.status(404).send("Not found");
    }
});
app.use((err, req, res, next) => {
    console.error("Express error:", err.message);
    if (!res.headersSent) {
        res.status(500).send("Error");
    }
});

const PORT = process.env.PORT || 3000;
const HOST = '0.0.0.0'; // Bind to all interfaces for Render
app.listen(PORT, HOST, () => {
    log.success(`Server running on ${HOST}:${PORT}`);
});

/* ================= AMAZON SCRAPER CLASS ================= */
class AmazonPriceTracker {
    constructor() {
        this.bot = new TelegramBot(CONFIG.telegramBotToken, { polling: false });
        this.prices = {};
        this.isRunning = false;
        
        // Rotating user agents - realistic browsers
        this.userAgents = [
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0",
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2.1 Safari/605.1.15",
            "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
        ];
        
        // Request stats
        this.stats = {
            totalRequests: 0,
            successfulRequests: 0,
            failedRequests: 0,
            priceDropsFound: 0,
        };
    }

    /* ================= FILE OPERATIONS ================= */
    async loadJSON(file, fallback = {}) {
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
        this.prices = await this.loadJSON(CONFIG.pricesFile);
        const bookCount = (await this.readBookUrls()).length;
        log.success(`Initialized - tracking ${bookCount} books`);
    }

    async readBookUrls() {
        try {
            const content = await fs.readFile(CONFIG.booksFile, "utf8");
            return content
                .split("\n")
                .map(line => line.trim())
                .filter(line => line && !line.startsWith("#"));
        } catch (error) {
            log.error(`Cannot read ${CONFIG.booksFile}: ${error.message}`);
            return [];
        }
    }

    /* ================= SMART SCRAPING WITH ANTI-BLOCKING ================= */
    getRandomUserAgent() {
        return this.userAgents[Math.floor(Math.random() * this.userAgents.length)];
    }

    getRealisticHeaders() {
        const acceptLanguages = [
            "pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7",
            "pl-PL,pl;q=0.9,en;q=0.8",
            "pl,en-US;q=0.9,en;q=0.8",
        ];
        
        return {
            "User-Agent": this.getRandomUserAgent(),
            "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
            "Accept-Language": acceptLanguages[Math.floor(Math.random() * acceptLanguages.length)],
            "Accept-Encoding": "gzip, deflate, br",
            "Connection": "keep-alive",
            "Upgrade-Insecure-Requests": "1",
            "Sec-Fetch-Dest": "document",
            "Sec-Fetch-Mode": "navigate",
            "Sec-Fetch-Site": "none",
            "Sec-Fetch-User": "?1",
            "Cache-Control": "max-age=0",
            "DNT": "1",
        };
    }

    async parseAmazonPage(url, retryCount = 0) {
        this.stats.totalRequests++;
        
        try {
            log.info(`Fetching: ${url.substring(0, 60)}...`);
            
            const config = {
                timeout: CONFIG.requestTimeout,
                headers: this.getRealisticHeaders(),
                maxRedirects: 5,
            };
            
            // Add proxy if configured
            if (CONFIG.proxyUrl) {
                const HttpsProxyAgent = require('https-proxy-agent');
                config.httpsAgent = new HttpsProxyAgent(CONFIG.proxyUrl);
            }

            const response = await axios.get(url, config);
            const $ = cheerio.load(response.data);

            // Extract title with multiple fallbacks
            let title = $("#productTitle").text().trim();
            if (!title) title = $("h1 span#productTitle").text().trim();
            if (!title) title = $("span.product-title-word-break").text().trim();
            if (!title) title = "Unknown Product";

            // Extract price with multiple selectors
            let priceText = null;
            const priceSelectors = [
                ".a-price .a-offscreen",
                "span.priceToPay .a-offscreen",
                "#corePrice_feature_div .a-offscreen",
                "#corePriceDisplay_desktop_feature_div .a-offscreen",
                ".a-price[data-a-color='price'] .a-offscreen",
                "span.a-price-whole",
            ];

            for (const selector of priceSelectors) {
                const element = $(selector).first();
                if (element.length > 0) {
                    priceText = element.text().trim();
                    if (priceText) break;
                }
            }

            // Fallback: combine whole + decimal
            if (!priceText) {
                const whole = $("span.a-price-whole").first().text().trim();
                const decimal = $("span.a-price-fraction").first().text().trim();
                if (whole) priceText = whole + (decimal || "");
            }

            if (!priceText) {
                log.warning("No price found - product might be unavailable");
                return null;
            }

            // Parse price (handles "49,99 zł" or "49.99 zł")
            const cleanPrice = priceText.replace(/[^\d,]/g, "").replace(",", ".");
            const price = parseFloat(cleanPrice);

            if (isNaN(price) || price <= 0) {
                log.error(`Invalid price parsed: ${priceText}`);
                return null;
            }

            const shortTitle = title.length > 50 ? title.substring(0, 50) + "..." : title;
            log.success(`Found: "${shortTitle}" - ${price.toFixed(2)} zł`);
            
            this.stats.successfulRequests++;

            return {
                url,
                title,
                price,
                currency: "PLN",
                timestamp: new Date().toISOString(),
            };

        } catch (error) {
            // Retry logic with exponential backoff
            if (retryCount < CONFIG.maxRetries) {
                const waitTime = Math.pow(2, retryCount) * 5000; // 5s, 10s, 20s
                log.warning(`Error (${error.message}). Retrying in ${waitTime / 1000}s... (${retryCount + 1}/${CONFIG.maxRetries})`);
                await sleep(waitTime);
                return this.parseAmazonPage(url, retryCount + 1);
            }

            this.stats.failedRequests++;
            log.error(`Failed after ${CONFIG.maxRetries} retries: ${error.message}`);
            return null;
        }
    }

    /* ================= TELEGRAM NOTIFICATION ================= */
    async sendPriceDropNotification(book, oldPrice) {
        const priceDrop = oldPrice - book.price;
        const percentDrop = ((priceDrop / oldPrice) * 100).toFixed(2);

        const message = 
            `📉 *Price Drop Alert!*\n\n` +
            `📚 ${book.title}\n\n` +
            `💰 Old Price: ${oldPrice.toFixed(2)} zł\n` +
            `💵 New Price: ${book.price.toFixed(2)} zł\n` +
            `📊 You Save: ${priceDrop.toFixed(2)} zł (${percentDrop}%)\n\n` +
            `🔗 [View on Amazon](${book.url})`;

        try {
            await this.bot.sendMessage(CONFIG.telegramChatId, message, {
                parse_mode: "Markdown",
                disable_web_page_preview: false,
            });
            log.success("Telegram notification sent");
        } catch (error) {
            log.error(`Telegram error: ${error.message}`);
        }
    }

    /* ================= BATCH PROCESSOR ================= */
    async processBatch() {
        if (this.isRunning) {
            log.warning("Batch already running, skipping");
            return;
        }

        this.isRunning = true;

        try {
            const urls = await this.readBookUrls();
            
            if (urls.length === 0) {
                log.error("No URLs found in books.txt");
                this.isRunning = false;
                return;
            }

            const progress = await this.loadJSON(CONFIG.progressFile, { index: 0 });
            const startIndex = progress.index;
            const endIndex = Math.min(startIndex + CONFIG.batchSize, urls.length);

            log.info(`\n${"=".repeat(60)}`);
            log.info(`Processing batch: ${startIndex + 1}-${endIndex} of ${urls.length} books`);
            log.info(`${"=".repeat(60)}\n`);

            let processedInBatch = 0;

            for (let i = startIndex; i < endIndex; i++) {
                const url = urls[i];
                
                // Random delay before each request (except first)
                if (processedInBatch > 0) {
                    const delayMs = randomDelay();
                    log.info(`Waiting ${(delayMs / 1000).toFixed(1)}s before next request...`);
                    await sleep(delayMs);
                }

                const bookData = await this.parseAmazonPage(url);

                if (!bookData) {
                    log.warning(`Skipping book ${i + 1}\n`);
                    continue;
                }

                processedInBatch++;

                // Check for price drop
                if (this.prices[url]) {
                    const oldPrice = this.prices[url].price;
                    const newPrice = bookData.price;

                    if (newPrice < oldPrice) {
                        log.drop("PRICE DROP DETECTED!");
                        this.stats.priceDropsFound++;
                        await this.sendPriceDropNotification(bookData, oldPrice);
                    } else if (newPrice > oldPrice) {
                        log.info(`Price increased: ${oldPrice} → ${newPrice} zł`);
                    } else {
                        log.info(`Price unchanged: ${newPrice} zł`);
                    }
                } else {
                    log.info("First time tracking this book");
                }

                // Update stored price
                this.prices[url] = bookData;
                console.log(""); // Empty line for readability
            }

            // Save prices
            await this.saveJSON(CONFIG.pricesFile, this.prices);
            log.success("Prices saved");

            // Update progress
            if (endIndex >= urls.length) {
                await this.saveJSON(CONFIG.progressFile, { index: 0 });
                log.success("Full cycle completed! Starting over from beginning.\n");
            } else {
                await this.saveJSON(CONFIG.progressFile, { index: endIndex });
                log.info(`Progress saved. Next batch starts at book ${endIndex + 1}\n`);
            }

            // Print statistics
            log.info(`\n${"=".repeat(60)}`);
            log.info("Session Statistics:");
            log.info(`  Total Requests: ${this.stats.totalRequests}`);
            log.info(`  Successful: ${this.stats.successfulRequests}`);
            log.info(`  Failed: ${this.stats.failedRequests}`);
            log.info(`  Price Drops Found: ${this.stats.priceDropsFound}`);
            log.info(`${"=".repeat(60)}\n`);

        } catch (error) {
            log.error(`Batch processing error: ${error.message}`);
        } finally {
            this.isRunning = false;
        }
    }

    /* ================= CONTINUOUS WORKER ================= */
    async startWorker() {
        const pauseMs = CONFIG.batchPauseMinutes * 60 * 1000;
        
        log.info("\n" + "=".repeat(60));
        log.info("🚀 Amazon Price Tracker Started");
        log.info("=".repeat(60));
        log.info(`Configuration:`);
        log.info(`  - Batch Size: ${CONFIG.batchSize} books`);
        log.info(`  - Pause Between Batches: ${CONFIG.batchPauseMinutes} minutes`);
        log.info(`  - Request Delay: ${CONFIG.requestDelaySeconds}±${CONFIG.randomDelayRange}s`);
        log.info(`  - Max Retries: ${CONFIG.maxRetries}`);
        log.info(`  - Proxy: ${CONFIG.proxyUrl ? "Enabled" : "Disabled"}`);
        log.info("=".repeat(60) + "\n");

        // Main loop
        while (true) {
            try {
                await this.processBatch();
            } catch (error) {
                log.error(`Worker error: ${error.message}`);
            }

            log.info(`⏳ Waiting ${CONFIG.batchPauseMinutes} minutes until next batch...\n`);
            await sleep(pauseMs);
        }
    }
}

/* ================= START APPLICATION ================= */

// Self-ping to keep Render happy (ping every 5 minutes during idle time)
let selfPingInterval;
const startSelfPing = () => {
    const pingUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    selfPingInterval = setInterval(async () => {
        try {
            await axios.get(`${pingUrl}/health`, { timeout: 5000 });
        } catch (err) {
            // Ignore errors - just trying to keep service alive
        }
    }, 5 * 60 * 1000); // Every 5 minutes
};

(async () => {
    try {
        log.info("Initializing Amazon Price Tracker...");
        
        const tracker = new AmazonPriceTracker();
        await tracker.init();
        
        // Start self-ping to prevent Render from thinking service is dead
        startSelfPing();
        log.info("✓ Self-ping enabled (every 5 minutes)\n");
        
        // Start background worker (non-blocking)
        tracker.startWorker().catch(err => {
            log.error(`Worker crashed: ${err.message}`);
            process.exit(1);
        });
        
    } catch (error) {
        log.error(`Fatal initialization error: ${error.message}`);
        process.exit(1);
    }
})();

// Graceful shutdown
process.on('SIGTERM', () => {
    log.info('Received SIGTERM, shutting down gracefully...');
    if (selfPingInterval) clearInterval(selfPingInterval);
    process.exit(0);
});

process.on('SIGINT', () => {
    log.info('Received SIGINT, shutting down gracefully...');
    if (selfPingInterval) clearInterval(selfPingInterval);
    process.exit(0);
});
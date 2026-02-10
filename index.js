const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer');
const TelegramBot = require('node-telegram-bot-api');

// Configuration
const CONFIG = {
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || 'YOUR_BOT_TOKEN',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || 'YOUR_CHAT_ID',
    booksFile: 'books.txt',
    pricesFile: 'prices.json',
    checkInterval: 1000 * 60 * 60 * 24, // 24 hours in milliseconds
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

class AmazonPriceTracker {
    constructor() {
        this.bot = new TelegramBot(CONFIG.telegramBotToken, { polling: false });
        this.prices = {};
    }

    /**
     * Initialize the tracker by loading existing price data
     */
    async init() {
        try {
            const data = await fs.readFile(CONFIG.pricesFile, 'utf8');
            this.prices = JSON.parse(data);
            console.log('✓ Loaded existing price data');
        } catch (error) {
            console.log('→ No existing price data found, starting fresh');
            this.prices = {};
        }
    }

    /**
     * Save current prices to file
     */
    async savePrices() {
        await fs.writeFile(CONFIG.pricesFile, JSON.stringify(this.prices, null, 2));
        console.log('✓ Prices saved');
    }

    /**
     * Read book URLs from the books.txt file
     */
    async readBookUrls() {
        try {
            const content = await fs.readFile(CONFIG.booksFile, 'utf8');
            const urls = content
                .split('\n')
                .map(line => line.trim())
                .filter(line => line && !line.startsWith('#'));

            console.log(`✓ Found ${urls.length} book URLs`);
            return urls;
        } catch (error) {
            console.error('✗ Error reading books file:', error.message);
            throw error;
        }
    }

    /**
     * Parse Amazon.pl product page and extract price and title
     */
    async parseAmazonPage(url) {
        console.log(`→ Fetching: ${url}`);

        let browser;
        try {
            browser = await puppeteer.launch({
                headless: true,
                args: [
                    '--no-sandbox',      // Required for Render
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--no-zygote',
                    '--single-process',
                ]
            });

            const page = await browser.newPage();

            // Realistic browser headers
            await page.setUserAgent(
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
                'AppleWebKit/537.36 (KHTML, like Gecko) ' +
                'Chrome/118.0.5993.90 Safari/537.36'
            );

            await page.setExtraHTTPHeaders({
                'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8'
            });

            // Random delay to reduce bot detection
            await new Promise(r => setTimeout(r, 2000));
            // Go to the page
            await page.goto(url, {
                waitUntil: 'networkidle2',
                timeout: 20000
            });

            // Wait for the product title or price to appear
            await page.waitForSelector('#productTitle, .a-price', { timeout: 10000 }).catch(() => null);

            // Extract title
            const title = await page.$eval('#productTitle', el => el.textContent.trim()).catch(() => null);

            // Extract price
            const priceSelectors = [
                '.a-price .a-offscreen',
                'span.a-price-whole',
                '.a-price[data-a-color="price"] .a-offscreen',
                '#corePrice_feature_div .a-offscreen',
                '#corePriceDisplay_desktop_feature_div .a-offscreen',
                'span.priceToPay .a-offscreen'
            ];

            let priceText = null;
            for (const selector of priceSelectors) {
                const el = await page.$(selector);
                if (el) {
                    priceText = await page.evaluate(e => e.textContent.trim(), el);
                    if (priceText) break;
                }
            }

            if (!priceText) {
                // fallback: try to get whole + decimal parts separately
                const whole = await page.$eval('span.a-price-whole', el => el.textContent.trim()).catch(() => '');
                const decimal = await page.$eval('span.a-price-fraction', el => el.textContent.trim()).catch(() => '');
                if (whole) priceText = whole + (decimal ? decimal : '');
            }

            if (!title || !priceText) {
                console.log('✗ Could not find title or price');
                return null;
            }

            // Parse price (handle "49,99 zł" or "49.99 zł")
            const priceMatch = priceText.match(/[\d\s]+[,.]?\d*/);
            if (!priceMatch) {
                console.log('✗ Could not parse price:', priceText);
                return null;
            }

            const price = parseFloat(priceMatch[0].replace(/\s/g, '').replace(',', '.'));

            console.log(`✓ Found: "${title}" - ${price} zł`);

            return {
                url,
                title,
                price,
                currency: 'PLN',
                timestamp: new Date().toISOString()
            };

        } catch (err) {
            console.error('✗ Puppeteer error:', err.message);
            return null;
        } finally {
            if (browser) await browser.close();
        }
    }

    /**
     * Send notification via Telegram
     */
    async sendTelegramNotification(bookData, oldPrice, newPrice) {
        const priceDrop = oldPrice - newPrice;
        const percentDrop = ((priceDrop / oldPrice) * 100).toFixed(2);

        const message = `📉 *Price Drop Alert!*\n\n` +
            `📚 ${bookData.title}\n\n` +
            `💰 Old Price: ${oldPrice.toFixed(2)} zł\n` +
            `💵 New Price: ${newPrice.toFixed(2)} zł\n` +
            `📊 Saved: ${priceDrop.toFixed(2)} zł (${percentDrop}%)\n\n` +
            `🔗 [View on Amazon](${bookData.url})`;

        try {
            await this.bot.sendMessage(CONFIG.telegramChatId, message, {
                parse_mode: 'Markdown',
                disable_web_page_preview: false
            });
            console.log('✓ Telegram notification sent');
        } catch (error) {
            console.error('✗ Error sending Telegram message:', error.message);
        }
    }

    /**
     * Check prices for all books
     */
    async checkPrices() {
        console.log('\n=== Starting Price Check ===\n');

        const urls = await this.readBookUrls();
        let checkedCount = 0;
        let priceDropsFound = 0;

        for (const url of urls) {
            // Add delay between requests to avoid rate limiting
            if (checkedCount > 0) {
                await new Promise(resolve => setTimeout(resolve, 3000));
            }

            const bookData = await this.parseAmazonPage(url);

            if (!bookData) {
                console.log(`⚠ Skipping ${url}\n`);
                continue;
            }

            checkedCount++;

            // Check if we have previous price data
            if (this.prices[url]) {
                const oldPrice = this.prices[url].price;
                const newPrice = bookData.price;

                if (newPrice < oldPrice) {
                    console.log(`🎉 PRICE DROP DETECTED!`);
                    priceDropsFound++;
                    await this.sendTelegramNotification(bookData, oldPrice, newPrice);
                } else if (newPrice > oldPrice) {
                    console.log(`📈 Price increased from ${oldPrice} to ${newPrice} zł`);
                } else {
                    console.log(`➡ Price unchanged: ${newPrice} zł`);
                }
            } else {
                console.log(`ℹ First time tracking this book`);
            }

            // Update stored price
            this.prices[url] = bookData;
            console.log('');
        }

        await this.savePrices();

        console.log('=== Price Check Complete ===');
        console.log(`✓ Checked: ${checkedCount} books`);
        console.log(`📉 Price drops found: ${priceDropsFound}`);
    }

    /**
     * Start continuous monitoring
     */
    async startMonitoring() {
        console.log('🚀 Amazon Price Tracker Started\n');
        console.log(`📊 Check interval: every ${CONFIG.checkInterval / 1000 / 60 / 60} hours`);
        console.log(`📁 Books file: ${CONFIG.booksFile}`);
        console.log(`💾 Prices file: ${CONFIG.pricesFile}\n`);

        // Run first check immediately
        await this.checkPrices();

        // Schedule periodic checks
        setInterval(async () => {
            await this.checkPrices();
        }, CONFIG.checkInterval);

        console.log('\n⏰ Scheduled periodic checks. Press Ctrl+C to stop.\n');
    }
}

// Main execution
(async () => {
    try {
        const tracker = new AmazonPriceTracker();
        await tracker.init();

        // Check if we should run once or start monitoring
        const args = process.argv.slice(2);

        if (args.includes('--once')) {
            await tracker.checkPrices();
            process.exit(0);
        } else {
            await tracker.startMonitoring();
        }

    } catch (error) {
        console.error('Fatal error:', error);
        process.exit(1);
    }
})();

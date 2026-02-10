const fs = require('fs').promises;
const path = require('path');
const axios = require('axios');
const cheerio = require('cheerio');
const TelegramBot = require('node-telegram-bot-api');
const https = require("https");

const httpsAgent = new https.Agent({
    family: 4,
    keepAlive: true
});


var booksCount = 0
// Configuration
const CONFIG = {
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || 'YOUR_BOT_TOKEN',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || 'YOUR_CHAT_ID',
    booksFile: 'books.txt',
    pricesFile: 'prices.json',
    checkInterval: 1000 * 60 * 60 * 24, // 24 hours in milliseconds
    minDelay: 8000, // Minimum 8 seconds between requests
    maxDelay: 15000, // Maximum 15 seconds between requests
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

const DAY_MS = 24 * 60 * 60 * 1000;

function getDelay(booksCount) {
    const avgDelay = DAY_MS / booksCount;

    // add human-like randomness ±40%
    const variation = avgDelay * 0.4;

    const delay =
        avgDelay +
        (Math.random() * variation * 2 - variation);

    return Math.max(delay, 60_000); // never less than 1 min
}

class AmazonPriceTracker {
    constructor() {
        this.bot = new TelegramBot(CONFIG.telegramBotToken, { polling: false });
        this.prices = {};
        this.userAgents = [
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:122.0) Gecko/20100101 Firefox/122.0',
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.2 Safari/605.1.15'
        ];
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
            booksCount = urls.length
            return urls;
        } catch (error) {
            console.error('✗ Error reading books file:', error.message);
            throw error;
        }
    }

    /**
     * Parse Amazon.pl product page and extract price and title
     */
    async parseAmazonPage(url, retryCount = 0) {
        const maxRetries = 3;

        try {
            console.log(`→ Fetching: ${url}`);

            // Pick a random user agent
            const randomUserAgent = this.userAgents[Math.floor(Math.random() * this.userAgents.length)];

            const response = await axios.get(url, {
                headers: {
                    'User-Agent': randomUserAgent,
                    'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
                    'Accept-Encoding': 'gzip, deflate, br',
                    'Connection': 'keep-alive',
                    'Upgrade-Insecure-Requests': '1',
                    'Sec-Fetch-Dest': 'document',
                    'Sec-Fetch-Mode': 'navigate',
                    'Sec-Fetch-Site': 'none',
                    'Cache-Control': 'max-age=0',
                    'DNT': '1',
                },
                timeout: 20000
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
            let priceText = null;

            // Try different price selectors
            const priceSelectors = [
                '.a-price .a-offscreen',
                'span.a-price-whole',
                'span.a-color-price',
                '.a-price[data-a-color="price"] .a-offscreen',
                '#corePrice_feature_div .a-offscreen',
                '#corePriceDisplay_desktop_feature_div .a-offscreen',
                'span.priceToPay .a-offscreen'
            ];

            for (const selector of priceSelectors) {
                const element = $(selector).first();
                if (element.length > 0) {
                    priceText = element.text().trim();
                    if (priceText) break;
                }
            }

            if (!priceText) {
                // Try to get whole and decimal parts separately
                const whole = $('span.a-price-whole').first().text().trim();
                const decimal = $('span.a-price-fraction').first().text().trim();
                if (whole) {
                    priceText = whole + (decimal ? decimal : '');
                }
            }

            if (!priceText) {
                console.log('✗ Price not found on page');
                return null;
            }

            // Parse price (handle formats like "49,99 zł" or "49.99 zł")
            const priceMatch = priceText.match(/[\d\s]+[,.]?\d*/);
            if (!priceMatch) {
                console.log('✗ Could not parse price:', priceText);
                return null;
            }

            const price = parseFloat(
                priceMatch[0]
                    .replace(/\s/g, '')
                    .replace(',', '.')
            );

            console.log(`✓ Found: "${title}" - ${price} zł`);

            return {
                url,
                title,
                price,
                currency: 'PLN',
                timestamp: new Date().toISOString()
            };

        } catch (error) {
            // Retry logic with exponential backoff
            if (retryCount < maxRetries) {
                const waitTime = Math.pow(2, retryCount) * 5000; // 5s, 10s, 20s
                console.log(`⚠ Error: ${error.message}`);
                console.log(`⏳ Retrying in ${waitTime / 1000} seconds... (Attempt ${retryCount + 1}/${maxRetries})`);
                await new Promise(resolve => setTimeout(resolve, waitTime));
                return this.parseAmazonPage(url, retryCount + 1);
            }

            console.error(`✗ Error parsing ${url} after ${maxRetries} attempts:`, error.message);
            return null;
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
            await axios.post(
                `https://api.telegram.org/bot${CONFIG.telegramBotToken}/sendMessage`,
                {
                    chat_id: CONFIG.telegramChatId,
                    text: message,
                    parse_mode: 'Markdown',
                },
                {
                    httpsAgent,
                    timeout: 15000
                }
            );

            console.log("✅ Telegram message sent");
        } catch (err) {
            console.error("❌ Telegram error:", err.message);
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
            // Add random delay between requests to avoid rate limiting
            if (checkedCount > 0) {
                const delay = getDelay(booksCount);

                console.log(`⏳ Waiting ${(delay / 60000).toFixed(2)} minutes...`);

                await new Promise(resolve => setTimeout(resolve, delay));
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
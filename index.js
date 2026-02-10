// amazonPriceTracker.js
const fs = require('fs').promises;
const puppeteer = require('puppeteer');
const TelegramBot = require('node-telegram-bot-api');

// Config
const CONFIG = {
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN || 'YOUR_BOT_TOKEN',
    telegramChatId: process.env.TELEGRAM_CHAT_ID || 'YOUR_CHAT_ID',
    booksFile: 'books.txt',
    pricesFile: 'prices.json',
    checkInterval: 1000 * 60 * 60 * 24, // 24h
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
};

class AmazonPriceTracker {
    constructor() {
        this.bot = new TelegramBot(CONFIG.telegramBotToken, { polling: false });
        this.prices = {};
    }

    // Load prices from file
    async init() {
        try {
            const data = await fs.readFile(CONFIG.pricesFile, 'utf8');
            this.prices = JSON.parse(data);
            console.log('✓ Loaded existing price data');
        } catch {
            console.log('→ No existing price data found, starting fresh');
            this.prices = {};
        }
    }

    async savePrices() {
        await fs.writeFile(CONFIG.pricesFile, JSON.stringify(this.prices, null, 2));
        console.log('✓ Prices saved');
    }

    async readBookUrls() {
        try {
            const content = await fs.readFile(CONFIG.booksFile, 'utf8');
            return content
                .split('\n')
                .map(line => line.trim())
                .filter(line => line && !line.startsWith('#'));
        } catch (error) {
            console.error('✗ Error reading books file:', error.message);
            throw error;
        }
    }

    async parseAmazonPage(url) {
        console.log(`→ Fetching: ${url}`);
        let browser;

        try {
            browser = await puppeteer.launch({
                headless: true,
                args: ['--no-sandbox', '--disable-dev-shm-usage']
            });

            const page = await browser.newPage();
            await page.setUserAgent(CONFIG.userAgent);
            await page.setExtraHTTPHeaders({ 'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8' });

            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            await new Promise(r => setTimeout(r, Math.floor(Math.random() * 3000) + 2000));

            // Extract title
            const title = await page.$eval('#productTitle', el => el.textContent.trim())
                .catch(() => null);

            // Extract price using multiple selectors
            const priceSelectors = [
                '.a-price .a-offscreen',
                'span.a-price-whole',
                '.a-price[data-a-color="price"] .a-offscreen',
                '#corePrice_feature_div .a-offscreen',
                '#corePriceDisplay_desktop_feature_div .a-offscreen',
                'span.priceToPay .a-offscreen'
            ];

            let priceText = null;
            for (const sel of priceSelectors) {
                priceText = await page.$eval(sel, el => el.textContent.trim()).catch(() => null);
                if (priceText) break;
            }

            if (!priceText) {
                const whole = await page.$eval('span.a-price-whole', el => el.textContent.trim()).catch(() => '');
                const fraction = await page.$eval('span.a-price-fraction', el => el.textContent.trim()).catch(() => '');
                if (whole) priceText = whole + fraction;
            }

            if (!title || !priceText) return null;

            const priceMatch = priceText.match(/[\d\s]+[,.]?\d*/);
            if (!priceMatch) return null;

            const price = parseFloat(priceMatch[0].replace(/\s/g, '').replace(',', '.'));

            console.log(`✓ Found: "${title}" - ${price} zł`);
            return { url, title, price, currency: 'PLN', timestamp: new Date().toISOString() };

        } catch (err) {
            console.error('✗ Puppeteer error:', err.message);
            return null;
        } finally {
            if (browser) await browser.close();
        }
    }

    async sendTelegramNotification(bookData, oldPrice, newPrice) {
        const saved = oldPrice - newPrice;
        const percent = ((saved / oldPrice) * 100).toFixed(2);
        const msg = `📉 *Price Drop Alert!*\n\n` +
            `📚 ${bookData.title}\n\n` +
            `💰 Old Price: ${oldPrice.toFixed(2)} zł\n` +
            `💵 New Price: ${newPrice.toFixed(2)} zł\n` +
            `📊 Saved: ${saved.toFixed(2)} zł (${percent}%)\n\n` +
            `🔗 [View on Amazon](${bookData.url})`;

        try {
            await this.bot.sendMessage(CONFIG.telegramChatId, msg, { parse_mode: 'Markdown', disable_web_page_preview: false });
            console.log('✓ Telegram notification sent');
        } catch (err) {
            console.error('✗ Telegram error:', err.message);
        }
    }

    async checkPrices() {
        console.log('\n=== Starting Price Check ===\n');
        const urls = await this.readBookUrls();
        let checked = 0, drops = 0;

        for (const url of urls) {
            if (checked > 0) await new Promise(r => setTimeout(r, 2000 + Math.random() * 2000));

            const book = await this.parseAmazonPage(url);
            if (!book) {
                console.log(`⚠ Skipping ${url}\n`);
                continue;
            }

            checked++;

            const old = this.prices[url]?.price;
            if (old && book.price < old) {
                drops++;
                await this.sendTelegramNotification(book, old, book.price);
            }

            this.prices[url] = book;
        }

        await this.savePrices();
        console.log(`\n=== Price Check Complete: Checked ${checked} books, Price drops: ${drops} ===\n`);
    }

    async startMonitoring() {
        console.log('🚀 Amazon Price Tracker Started\n');
        await this.checkPrices();
        setInterval(() => this.checkPrices(), CONFIG.checkInterval);
    }
}

// Entry
(async () => {
    const tracker = new AmazonPriceTracker();
    await tracker.init();
    const args = process.argv.slice(2);

    if (args.includes('--once')) {
        await tracker.checkPrices();
        process.exit(0);
    } else {
        await tracker.startMonitoring();
    }
})();

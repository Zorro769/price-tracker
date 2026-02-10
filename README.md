# Amazon.pl Book Price Tracker 📚💰

A Node.js application that monitors book prices on Amazon.pl and sends Telegram notifications when prices drop.

## Features

✅ Parse Amazon.pl product pages and extract prices  
✅ Track multiple books from a simple text file  
✅ Store price history locally  
✅ Send Telegram notifications on price drops  
✅ Automatic periodic checking (configurable interval)  
✅ Manual one-time price check option  

## Prerequisites

- Node.js (v14 or higher)
- A Telegram account
- Amazon.pl book URLs you want to track

## Installation

1. **Clone or download this project**

2. **Install dependencies:**
```bash
npm install
```

3. **Set up Telegram Bot:**

   a. Open Telegram and message [@BotFather](https://t.me/botfather)
   
   b. Send `/newbot` and follow the instructions
   
   c. Copy the bot token you receive
   
   d. Get your Chat ID by messaging [@userinfobot](https://t.me/userinfobot)
   
   e. Create a `.env` file (copy from `.env.example`):
   ```bash
   cp .env.example .env
   ```
   
   f. Edit `.env` and add your credentials:
   ```
   TELEGRAM_BOT_TOKEN=1234567890:ABCdefGHIjklMNOpqrsTUVwxyz
   TELEGRAM_CHAT_ID=123456789
   ```

4. **Add book URLs to track:**

   Edit `books.txt` and add Amazon.pl URLs (one per line):
   ```
   https://www.amazon.pl/Clean-Code-Handbook-Software-Craftsmanship/dp/0132350882
   https://www.amazon.pl/Pragmatic-Programmer-journey-mastery-Anniversary/dp/0135957052
   ```

## Usage

### Start Continuous Monitoring

This will check prices every 24 hours (configurable in `index.js`):

```bash
npm start
```

or

```bash
node index.js
```

### One-Time Price Check

Check prices once and exit:

```bash
npm run check
```

or

```bash
node index.js --once
```

### Test Parser

Test if the scraper can parse a specific Amazon URL:

```bash
npm test https://www.amazon.pl/dp/XXXXXXXXXX
```

or

```bash
node test-parser.js https://www.amazon.pl/dp/XXXXXXXXXX
```

## How It Works

1. **Reading URLs**: The app reads book URLs from `books.txt`
2. **Scraping**: For each URL, it fetches the page and extracts:
   - Book title
   - Current price
3. **Comparison**: Compares with previously stored price
4. **Notification**: If price dropped, sends a Telegram message with:
   - Book title
   - Old price vs new price
   - Amount saved
   - Percentage discount
   - Link to the book
5. **Storage**: Updates `prices.json` with current prices

## Configuration

Edit the `CONFIG` object in `index.js`:

```javascript
const CONFIG = {
    telegramBotToken: process.env.TELEGRAM_BOT_TOKEN,
    telegramChatId: process.env.TELEGRAM_CHAT_ID,
    booksFile: 'books.txt',
    pricesFile: 'prices.json',
    checkInterval: 1000 * 60 * 60 * 24, // 24 hours
    userAgent: 'Mozilla/5.0...'
};
```

### Check Interval Options

- Every hour: `1000 * 60 * 60`
- Every 6 hours: `1000 * 60 * 60 * 6`
- Every 12 hours: `1000 * 60 * 60 * 12`
- Every 24 hours: `1000 * 60 * 60 * 24` (default)
- Every week: `1000 * 60 * 60 * 24 * 7`

## File Structure

```
amazon-price-tracker/
├── index.js              # Main application
├── test-parser.js        # Parser testing utility
├── package.json          # Dependencies
├── books.txt             # List of book URLs to track
├── prices.json           # Stored price history (auto-generated)
├── .env                  # Your Telegram credentials
├── .env.example          # Template for .env
└── README.md             # This file
```

## Troubleshooting

### Bot not sending messages

1. Make sure your bot token is correct
2. Verify your chat ID is correct
3. Start a conversation with your bot first (send any message to it)

### Price not detected

1. Run the test parser: `node test-parser.js <url>`
2. Check if the URL is accessible
3. Amazon.pl might have changed their page structure
4. Some books might not have prices (out of stock)

### "Network error" or timeout

- Amazon might be blocking automated requests
- Try increasing the delay between requests
- The user agent might need updating

## Running on a Server

### Using PM2 (recommended)

```bash
# Install PM2
npm install -g pm2

# Start the tracker
pm2 start index.js --name "amazon-tracker"

# View logs
pm2 logs amazon-tracker

# Stop
pm2 stop amazon-tracker

# Restart
pm2 restart amazon-tracker
```

### Using systemd (Linux)

Create `/etc/systemd/system/amazon-tracker.service`:

```ini
[Unit]
Description=Amazon Price Tracker
After=network.target

[Service]
Type=simple
User=youruser
WorkingDirectory=/path/to/amazon-price-tracker
ExecStart=/usr/bin/node index.js
Restart=always

[Install]
WantedBy=multi-user.target
```

Then:
```bash
sudo systemctl enable amazon-tracker
sudo systemctl start amazon-tracker
sudo systemctl status amazon-tracker
```

## Environment Variables

You can set environment variables instead of using `.env`:

```bash
export TELEGRAM_BOT_TOKEN="your_token"
export TELEGRAM_CHAT_ID="your_chat_id"
npm start
```

## Example Telegram Notification

```
📉 Price Drop Alert!

📚 Clean Code: A Handbook of Agile Software Craftsmanship

💰 Old Price: 89.99 zł
💵 New Price: 67.49 zł
📊 Saved: 22.50 zł (25.00%)

🔗 View on Amazon
```

## Tips

- Add books gradually to avoid rate limiting
- Don't check too frequently (respect Amazon's servers)
- Keep your Telegram bot token secret
- Back up your `prices.json` file periodically

## License

MIT

## Disclaimer

This tool is for personal use only. Please respect Amazon's Terms of Service and robots.txt. Use reasonable request intervals to avoid overloading their servers.

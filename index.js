require("dotenv").config();
const fs = require("fs").promises;
const axios = require("axios");
const cheerio = require("cheerio");
const TelegramBot = require("node-telegram-bot-api");
const express = require("express");

const app = express();

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

/* ================= WEB SERVER ================= */

app.get("/", (req, res) => res.send("Tracker alive"));
app.listen(process.env.PORT || 3000);

/* ================= HELPERS ================= */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================= TRACKER ================= */

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

    this.isRunning = false;
  }

  /* ---------- FILE HELPERS ---------- */

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
  }

  /* ---------- BOOK LIST ---------- */

  async readBookUrls() {
    const content = await fs.readFile(CONFIG.booksFile, "utf8");

    return content
      .split("\n")
      .map((x) => x.trim())
      .filter((x) => x && !x.startsWith("#"));
  }

  /* ---------- SCRAPER ---------- */

  async parseAmazonPage(url, retry = 0) {
    try {
      const ua =
        this.userAgents[Math.floor(Math.random() * this.userAgents.length)];

      const res = await axios.get(url, {
        timeout: CONFIG.requestTimeout,
        headers: {
          "User-Agent": ua,
          "Accept-Language": "pl-PL,pl;q=0.9,en;q=0.8",
        },
      });

      const $ = cheerio.load(res.data);

      const title = $("#productTitle").text().trim();

      let priceText =
        $(".a-price .a-offscreen").first().text().trim() ||
        $("span.priceToPay .a-offscreen").first().text().trim();

      if (!priceText) return null;

      const price = parseFloat(
        priceText.replace(/[^\d,]/g, "").replace(",", ".")
      );

      return {
        url,
        title,
        price,
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      if (retry < 2) {
        await sleep(5000 * (retry + 1));
        return this.parseAmazonPage(url, retry + 1);
      }

      console.log("Parse failed:", url);
      return null;
    }
  }

  /* ---------- TELEGRAM ---------- */

  async notifyDrop(book, oldPrice) {
    const diff = oldPrice - book.price;

    const msg =
      `📉 Price Drop!\n\n` +
      `${book.title}\n\n` +
      `Old: ${oldPrice} zł\n` +
      `New: ${book.price} zł\n\n` +
      `${book.url}`;

    await this.bot.sendMessage(CONFIG.telegramChatId, msg);
  }

  /* ---------- BATCH PROCESS ---------- */

  async runBatch() {
    if (this.isRunning) return;

    this.isRunning = true;

    try {
      const urls = await this.readBookUrls();
      const progress = await this.loadJSON(CONFIG.progressFile, { index: 0 });

      let start = progress.index;
      let end = Math.min(start + CONFIG.batchSize, urls.length);

      console.log(`Batch ${start} → ${end}`);

      for (let i = start; i < end; i++) {
        const url = urls[i];

        const data = await this.parseAmazonPage(url);
        if (!data) continue;

        if (this.prices[url]) {
          if (data.price < this.prices[url].price) {
            await this.notifyDrop(data, this.prices[url].price);
          }
        }

        this.prices[url] = data;
      }

      await this.saveJSON(CONFIG.pricesFile, this.prices);

      if (end >= urls.length) {
        await this.saveJSON(CONFIG.progressFile, { index: 0 });
        console.log("Cycle completed");
      } else {
        await this.saveJSON(CONFIG.progressFile, { index: end });
      }
    } catch (err) {
      console.error("Batch error:", err);
    }

    this.isRunning = false;
  }

  /* ---------- WORKER LOOP ---------- */

  async startWorker() {
    while (true) {
      await this.runBatch();
      await sleep(CONFIG.batchPauseMs);
    }
  }
}

/* ================= START ================= */

(async () => {
  const tracker = new AmazonPriceTracker();
  await tracker.init();

  tracker.startWorker(); // don't await
})();

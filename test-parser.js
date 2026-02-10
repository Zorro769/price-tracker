const axios = require('axios');
const cheerio = require('cheerio');

/**
 * Test script to verify Amazon.pl parsing works correctly
 * Usage: node test-parser.js <amazon-url>
 */

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

async function testParse(url) {
    console.log('\n🧪 Testing Amazon.pl Parser\n');
    console.log(`URL: ${url}\n`);

    try {
        const response = await axios.get(url, {
            headers: {
                'User-Agent': USER_AGENT,
                'Accept-Language': 'pl-PL,pl;q=0.9,en;q=0.8',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            },
            timeout: 15000
        });

        const $ = cheerio.load(response.data);
        
        console.log('--- Title Detection ---');
        let title = $('#productTitle').text().trim();
        console.log(`Title: ${title || 'NOT FOUND'}\n`);

        console.log('--- Price Detection ---');
        
        const priceSelectors = [
            '.a-price .a-offscreen',
            'span.a-price-whole',
            '.a-price[data-a-color="price"] .a-offscreen',
            '#corePrice_feature_div .a-offscreen',
            '#corePriceDisplay_desktop_feature_div .a-offscreen',
            'span.priceToPay .a-offscreen'
        ];

        let foundPrice = null;
        for (const selector of priceSelectors) {
            const element = $(selector).first();
            if (element.length > 0) {
                const text = element.text().trim();
                console.log(`✓ ${selector}: "${text}"`);
                if (!foundPrice && text) {
                    foundPrice = text;
                }
            } else {
                console.log(`✗ ${selector}: not found`);
            }
        }

        if (!foundPrice) {
            const whole = $('span.a-price-whole').first().text().trim();
            const decimal = $('span.a-price-fraction').first().text().trim();
            if (whole) {
                foundPrice = whole + (decimal ? decimal : '');
                console.log(`✓ Combined whole+decimal: "${foundPrice}"`);
            }
        }

        console.log('\n--- Parsed Result ---');
        if (foundPrice) {
            const priceMatch = foundPrice.match(/[\d\s]+[,.]?\d*/);
            if (priceMatch) {
                const price = parseFloat(
                    priceMatch[0].replace(/\s/g, '').replace(',', '.')
                );
                console.log(`Price: ${price} PLN`);
                console.log('✅ SUCCESS - Price parsed successfully');
            } else {
                console.log('❌ FAILED - Could not extract number from:', foundPrice);
            }
        } else {
            console.log('❌ FAILED - No price found on page');
            console.log('\n💡 Tip: The page structure might have changed, or the book is unavailable.');
        }

    } catch (error) {
        console.error('❌ ERROR:', error.message);
        if (error.response) {
            console.log(`HTTP Status: ${error.response.status}`);
        }
    }

    console.log('');
}

// Get URL from command line or use example
const url = process.argv[2];

if (!url) {
    console.log('Usage: node test-parser.js <amazon-url>');
    console.log('\nExample:');
    console.log('node test-parser.js https://www.amazon.pl/dp/XXXXXXXXXX');
    process.exit(1);
}

testParse(url);

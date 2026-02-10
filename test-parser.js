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
const url = "https://www.amazon.pl/Building-StoryBrand-2-0-Clarify-Customers/dp/1400251303/ref=sr_1_1?__mk_pl_PL=%C3%85M%C3%85%C5%BD%C3%95%C3%91&crid=OICOIZ6SRWK5&dib=eyJ2IjoiMSJ9.H0DnlVEo8xexOebJ52vW01RvcHHgv6gjZ8FGjO7ZXViJ7fjhkAoExFPsUaV3ozvbBK4_kQ7Raoy_GIz0oNqG8sxOujC1AhMXyGY84GCs6851o1uFxo4TkzijxxN9C6-inIWCr7di51YTbeWjyBbqDHKC0hxAolH5gFSvONTK0GZkF1khlgq5dQz7vb2SGT2iUTLKNICbpQGd5V1PC3SRZUt52QltIbie6IckXHVzUe-_lXjWHRXPcZplRmNi6xT2Cwb1x4lbeXgXGQmguvJ3OdJuKS5O8Oeuqy3U3h6ijNA.UE7Y738lEkv_Bdg0tQwhr-Z7ujLQhHIm_mAdfapqaC4&dib_tag=se&keywords=Building+a+StoryBrand&qid=1770676741&sprefix=building+a+storybrand%2Caps%2C139&sr=8-1";

if (!url) {
    console.log('Usage: node test-parser.js <amazon-url>');
    console.log('\nExample:');
    console.log('node test-parser.js https://www.amazon.pl/dp/XXXXXXXXXX');
    process.exit(1);
}

testParse(url);

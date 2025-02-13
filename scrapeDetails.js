const { chromium } = require('playwright');
 // Import Playwright
 const BuyeeScraper = require('./scrapper');
const obj = new BuyeeScraper();

(async () => {
    // const browser = await chromium.launch({ headless: false });
    // const context = await browser.newContext();
    // const page = await context.newPage();

    // await page.goto('https://buyee.jp/item/yahoo/auction/c1170109320?conversionType=YahooAuction_DirectSearch');

    // // Extract image src values
    // const imageSources = await page.evaluate(() => {
    //     const images = document.querySelectorAll('ol.flex-control-nav li img');
    //     return Array.from(images).map(img => img.src);
    // });

    // console.log(imageSources);

    await obj.scrapeSearchResults('gucci', '100', '10000', '23000', 8);

    // await browser.close();


    // for extracting product details
    // await page.goto('https://buyee.jp/item/yahoo/auction/v1170900181?conversionType=YahooAuction_DirectSearch');
    // const price = page.locator('div.price').textContent();
    // console.log('PRICE', await price);
    // const timeRemaining = page.locator('//span[contains(@class, "g-title")]/following-sibling::span').first();
    // console.log('Time REMAINING: ', await timeRemaining.textContent());
    // // await page.pause();
    // await page.close();
})();

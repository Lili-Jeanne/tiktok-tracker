const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const fs = require('fs');

chromium.use(stealth);

async function run() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  // On cible les hashtags en France avec la plus forte croissance
  const url = 'https://ads.tiktok.com/business/creativecenter/inspiration/popular/hashtag/pc/en?region=FR';
  
  try {
    await page.goto(url, { waitUntil: 'networkidle' });
    await page.waitForTimeout(5000); // Sécurité pour le rendu JS

    // On extrait les noms des hashtags et leur score de croissance
    const trends = await page.evaluate(() => {
      const cards = Array.from(document.querySelectorAll('[class*="CardItem_container"]'));
      return cards.slice(0, 15).map(card => ({
        tag: card.querySelector('[class*="CardItem_title"]')?.innerText.replace('#', ''),
        growth: card.querySelector('[class*="CardItem_growthPercentage"]')?.innerText,
        isNew: card.innerText.includes('New')
      }));
    });

    const data = {
      lastUpdate: new Date().toISOString(),
      trends: trends.filter(t => t.tag) // Nettoyage
    };

    fs.writeFileSync('trends.json', JSON.stringify(data, null, 2));
    console.log('✅ Trends mises à jour !');
  } catch (error) {
    console.error('❌ Erreur lors du scraping:', error);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

run();
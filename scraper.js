const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const fs = require('fs');

chromium.use(stealth);

async function run() {
  const browser = await chromium.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'] 
  });
  
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();
  const url = 'https://ads.tiktok.com/business/creativecenter/inspiration/popular/hashtag/pc/en?region=FR';
  
  console.log('🚀 Navigation vers TikTok Creative Center...');

  try {
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    
    // On attend que les titres des hashtags apparaissent (sélecteur générique)
    await page.waitForSelector('span[class*="CardItem_title"]', { timeout: 30000 });

    // Petit scroll pour simuler un humain et charger les images/données
    await page.mouse.wheel(0, 500);
    await page.waitForTimeout(2000);

    const trends = await page.evaluate(() => {
      // On cherche tous les conteneurs de cartes
      const cards = Array.from(document.querySelectorAll('[class*="CardItem_container"]'));
      
      return cards.slice(0, 15).map(card => {
        const nameElement = card.querySelector('[class*="CardItem_title"]');
        const growthElement = card.querySelector('[class*="CardItem_growthPercentage"]');
        const isNew = card.innerText.includes('New');

        return {
          tag: nameElement ? nameElement.innerText.replace('#', '').trim() : null,
          growth: growthElement ? growthElement.innerText.trim() : 'N/A',
          isNew: isNew
        };
      });
    });

    const cleanTrends = trends.filter(t => t.tag && t.tag.length > 0);

    const data = {
      lastUpdate: new Date().toISOString(),
      trends: cleanTrends
    };

    if (cleanTrends.length === 0) {
        throw new Error("Aucune trend trouvée. TikTok a peut-être changé ses sélecteurs.");
    }

    fs.writeFileSync('trends.json', JSON.stringify(data, null, 2));
    console.log(`✅ ${cleanTrends.length} Trends récupérées !`);

  } catch (error) {
    console.error('❌ Erreur:', error.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

run();

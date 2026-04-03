const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const fs = require('fs');

chromium.use(stealth);

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  // On va surveiller les requêtes réseau pour attraper le JSON de TikTok
  let trendsData = null;
  page.on('response', async (response) => {
    if (response.url().includes('trend/hashtag/list') && response.status() === 200) {
      console.log('🎯 API TikTok interceptée !');
      try {
        const json = await response.json();
        trendsData = json.data.list;
      } catch (e) {
        console.error("Erreur lecture JSON API", e);
      }
    }
  });

  try {
    console.log('🚀 Navigation...');
    // On va sur la page des hashtags (France)
    await page.goto('https://ads.tiktok.com/business/creativecenter/inspiration/popular/hashtag/pc/en?region=FR', { 
      waitUntil: 'networkidle',
      timeout: 60000 
    });

    // On attend un peu que les appels API se fassent
    await page.waitForTimeout(10000);

    if (trendsData && trendsData.length > 0) {
      const formattedTrends = trendsData.slice(0, 20).map(item => ({
        tag: item.hashtag_name,
        growth: item.rank_diff_last_7_days >= 0 ? `+${item.rank_diff_last_7_days}` : item.rank_diff_last_7_days,
        isNew: item.is_new,
        views: item.view_count
      }));

      const finalOutput = {
        lastUpdate: new Date().toISOString(),
        trends: formattedTrends
      };

      fs.writeFileSync('trends.json', JSON.stringify(finalOutput, null, 2));
      console.log(`✅ Succès : ${formattedTrends.length} trends enregistrées.`);
    } else {
      // Si l'interception a échoué, on prend un screenshot pour voir ce qui bloque
      await page.screenshot({ path: 'debug.png' });
      throw new Error("L'API n'a pas été capturée. Vérifie debug.png dans les artefacts.");
    }

  } catch (error) {
    console.error('❌ ERREUR :', error.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

run();

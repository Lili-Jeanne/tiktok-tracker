const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const fs = require('fs');

chromium.use(stealth);

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  
  let trendsData = null;
  page.on('response', async (response) => {
    // On intercepte l'API de TikTok
    if (response.url().includes('trend/hashtag/list') && response.status() === 200) {
      try {
        const json = await response.json();
        trendsData = json.data.list;
      } catch (e) {}
    }
  });

  try {
    // L'URL magique : on ajoute "&sort_by=rank_diff" pour avoir les plus fortes progressions (Breakout)
    // Et on cible spécifiquement la France
    const url = 'https://ads.tiktok.com/business/creativecenter/inspiration/popular/hashtag/pc/en?region=FR&sort_by=rank_diff';
    
    console.log('🚀 Recherche des trends à forte croissance...');
    await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(8000);

    if (trendsData) {
      // Liste de mots-clés "Brainrot / Collège" pour booster certains résultats
      const collegeKeywords = ['skibidi', 'sigma', 'rizz', '67', 'sixseven', 'fortnite', 'emote', 'roblox', 'pov', 'prof', 'college', 'brevet'];

      const formattedTrends = trendsData
        .map(item => ({
          tag: item.hashtag_name,
          growth: item.rank_diff_last_7_days,
          isNew: item.is_new,
          // On donne un "score d'intérêt collège"
          priority: collegeKeywords.some(key => item.hashtag_name.toLowerCase().includes(key)) ? 1 : 0
        }))
        // On trie d'abord par priorité (mots-clés), puis par puissance de croissance
        .sort((a, b) => b.priority - a.priority || b.growth - a.growth)
        .slice(0, 20);

      const finalOutput = {
        lastUpdate: new Date().toISOString(),
        trends: formattedTrends
      };

      fs.writeFileSync('trends.json', JSON.stringify(finalOutput, null, 2));
      console.log(`✅ ${formattedTrends.length} trends filtrées enregistrées.`);
    }

  } catch (error) {
    console.error('❌ Erreur:', error.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

run();

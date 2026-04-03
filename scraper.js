const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const fs = require('fs');

chromium.use(stealth);

// ---------------------------------------------------------------------------
// MOTS-CLÉS DES COLLÉGIENS (11-15 ans) — culture ado / brainrot / gaming
// Toute trend qui contient AU MOINS UN de ces termes sera gardée.
// ---------------------------------------------------------------------------
const COLLEGE_KEYWORDS = [
  // Argot "brainrot" & internet slang
  'skibidi', 'sigma', 'rizz', 'gyatt', 'slay', 'npc', 'grind', 'ratio',
  'cap', 'nocap', 'bussin', 'lowkey', 'highkey', 'goat', 'ong', 'fanum',
  'tax', 'delulu', 'situationship', 'understood', 'periodt', 'vibe',
  'aura', 'alpha', 'based', 'cringe', 'sus', 'glaze', 'glazing',
  'mewing', 'looksmax', 'looksmaxing', 'glow', 'glowup', 'mogging',
  'pookies', 'twin', 'bestie', 'ate', 'slay',

  // Gaming (très présent chez les collégiens)
  'fortnite', 'roblox', 'minecraft', 'freefire', 'freefire', 'brawlstars',
  'brawl', 'clashofclans', 'coc', 'clashroyal', 'clashroyale', 'valorant',
  'fncs', 'chapter', 'season', 'cod', 'warzone', 'genshin', 'honkai',
  'pubg', 'apex', 'overwatch', 'mario', 'nintendo', 'pokémon', 'pokemon',
  'ps5', 'xbox', 'gaming', 'gamer', 'streamer', 'stream', 'live',
  'twitch', 'youtube',

  // Emotes & danses virales collège
  'emote', 'dance', 'choreo', 'choreography', 'shuffle', 'twerk',
  'griddy', 'flopscotch', 'phonk', 'drift', 'edit',

  // Personnages / mèmes populaires chez les ados
  'grimace', 'bibble', 'quandale', 'dingle', 'ambatukam', 'peter',
  'griffin', 'spongebob', 'ohio', 'thug', 'shaker', 'hawk', 'tuah',

  // Tendances école / vie de collégien
  'college', 'collège', 'lycee', 'lycée', 'prof', 'cours', 'classe',
  'ecole', 'école', 'brevet', 'bac', 'devoirs', 'exam', 'interro',
  'cantine', 'récré', 'recre', 'sortie', 'vacances', 'rentree', 'rentrée',

  // Contenu viral typique ados
  'pov', 'trend', 'challenge', 'duet', 'stitch', 'greenscreen',
  'aesthetic', 'thrift', 'transformation', 'reveal', 'fit', 'outfit',
  'drip', 'sneaker', 'hype', 'hypebreak', 'grwm', 'vlog', 'fyp',

  // Musiques / artistes très écoutés par les collégiens
  'phonk', 'trap', 'drill', 'rap', 'freestyle', 'afro', 'rnb',
  'central', 'cee', 'sdm', 'niska', 'sch', 'jul', 'booba', 'damso',
  'taylorswift', 'taylor', 'swift', 'sabrina', 'carpenter', 'olivia',
  'rodrigo', 'ariana', 'grande', 'doja', 'cat', 'lil', 'uzi',

  // Autres termes viraux récurrents chez les jeunes
  'satisfying', 'asmr', 'mukbang', 'unboxing', 'mystery', 'viral',
  'compilation', 'funny', 'prank', 'reaction', 'tutorial', 'hack',
  'lifehack', 'secret', '67', 'sixseven', 'sksksk', 'iykyk',
];

// Catégories pour aider les parents à comprendre le contexte
function getCategory(tag) {
  const t = tag.toLowerCase();
  if (['skibidi', 'sigma', 'rizz', 'gyatt', 'npc', 'fanum', 'delulu', 'aura', 'alpha', 'mewing', 'looksmax', 'mogging', 'glazing', 'sus', 'cap', 'nocap', 'bussin', 'goat', 'ong', 'based', 'cringe'].some(k => t.includes(k))) return 'Argot internet / Brainrot';
  if (['fortnite', 'roblox', 'minecraft', 'freefire', 'brawl', 'clash', 'valorant', 'cod', 'genshin', 'pubg', 'apex', 'overwatch', 'pokemon', 'mario', 'gaming', 'gamer', 'streamer', 'twitch'].some(k => t.includes(k))) return 'Gaming';
  if (['emote', 'dance', 'choreo', 'shuffle', 'twerk', 'griddy', 'phonk', 'drift'].some(k => t.includes(k))) return 'Danse / Emote';
  if (['college', 'collège', 'lycee', 'prof', 'cours', 'brevet', 'bac', 'cantine', 'recre', 'vacances', 'rentrée', 'rentree'].some(k => t.includes(k))) return 'Vie scolaire';
  if (['pov', 'challenge', 'duet', 'stitch', 'grwm', 'vlog', 'aesthetic', 'outfit', 'drip', 'sneaker'].some(k => t.includes(k))) return 'Contenu viral';
  if (['rap', 'drill', 'phonk', 'trap', 'afro', 'rnb', 'taylorswift', 'sabrina', 'olivia', 'ariana', 'doja'].some(k => t.includes(k))) return 'Musique';
  return 'Tendance ados';
}

// ---------------------------------------------------------------------------

const URLS_TO_SCRAPE = [
  // Tendances générales France — classées par progression (Breakout)
  'https://ads.tiktok.com/business/creativecenter/inspiration/popular/hashtag/pc/en?region=FR&sort_by=rank_diff',
  // Tendances Gaming France
  'https://ads.tiktok.com/business/creativecenter/inspiration/popular/hashtag/pc/en?region=FR&sort_by=rank_diff&industry_id=26100003',
  // Tendances Entertainment France
  'https://ads.tiktok.com/business/creativecenter/inspiration/popular/hashtag/pc/en?region=FR&sort_by=rank_diff&industry_id=26100010',
];

async function scrapeUrl(page, url) {
  return new Promise(async (resolve) => {
    let data = null;

    const handler = async (response) => {
      if (response.url().includes('trend/hashtag/list') && response.status() === 200) {
        try {
          const json = await response.json();
          if (json?.data?.list?.length) data = json.data.list;
        } catch (e) { }
      }
    };

    page.on('response', handler);

    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 });
      await page.waitForTimeout(8000);
    } catch (e) {
      console.warn(`⚠️  Timeout sur ${url} — données partielles conservées.`);
    }

    page.off('response', handler);
    resolve(data || []);
  });
}

async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  try {
    // --- Collecte multi-URL ---
    const allItems = [];
    const seen = new Set();

    for (const url of URLS_TO_SCRAPE) {
      console.log(`🌐 Scraping : ${url}`);
      const items = await scrapeUrl(page, url);
      console.log(`   → ${items.length} hashtags récupérés`);

      for (const item of items) {
        const key = item.hashtag_name?.toLowerCase();
        if (key && !seen.has(key)) {
          seen.add(key);
          allItems.push(item);
        }
      }
    }

    console.log(`📦 Total dédupliqué : ${allItems.length} hashtags`);

    if (allItems.length === 0) {
      console.error('❌ Aucune donnée interceptée.');
      process.exit(1);
    }

    // --- Filtre strict : uniquement les trends collégiens ---
    const collegeTrends = allItems
      .filter(item => {
        const tag = item.hashtag_name?.toLowerCase() || '';
        return COLLEGE_KEYWORDS.some(keyword => tag.includes(keyword));
      })
      .map(item => ({
        tag: item.hashtag_name,
        growth: item.rank_diff_last_7_days ?? null,
        isNew: item.is_new ?? false,
        category: getCategory(item.hashtag_name),
      }))
      .sort((a, b) => (b.growth ?? 0) - (a.growth ?? 0))
      .slice(0, 20);

    console.log(`🎯 Après filtre collégiens : ${collegeTrends.length} trends`);

    // --- Fallback : si vraiment rien, on prend les 5 plus en croissance ---
    let finalTrends = collegeTrends;
    if (collegeTrends.length === 0) {
      console.warn('⚠️  Aucun hashtag collégien détecté — fallback sur le top croissance général.');
      finalTrends = allItems
        .sort((a, b) => (b.rank_diff_last_7_days ?? 0) - (a.rank_diff_last_7_days ?? 0))
        .slice(0, 5)
        .map(item => ({
          tag: item.hashtag_name,
          growth: item.rank_diff_last_7_days ?? null,
          isNew: item.is_new ?? false,
          category: 'Tendance générale',
          isGeneral: true,
        }));
    }

    const output = {
      lastUpdate: new Date().toISOString(),
      filteredForCollege: true,
      trends: finalTrends,
    };

    fs.writeFileSync('trends.json', JSON.stringify(output, null, 2));
    console.log(`✅ ${finalTrends.length} trends collégiens enregistrées dans trends.json`);

  } catch (error) {
    console.error('❌ Erreur:', error.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

run();

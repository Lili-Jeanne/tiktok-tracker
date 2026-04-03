const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const googleTrends = require('google-trends-api');
const fs = require('fs');

chromium.use(stealth);

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const MIN_VIEWS        = 500_000;   // Vues historiques minimum (filtre permissif)
const MIN_TREND_SCORE  = 10;        // Score Google Trends minimum sur 7 jours (0-100)
const MAX_HASHTAGS     = 15;        // Nombre max à vérifier (pour limiter le temps)

// ---------------------------------------------------------------------------
// MOTS-CLÉS COLLÉGIENS (11-15 ans) — filtre strict
// ---------------------------------------------------------------------------
const COLLEGE_KEYWORDS = [
  // Argot "brainrot" & internet slang
  'skibidi', 'sigma', 'rizz', 'gyatt', 'slay', 'npc', 'grind', 'ratio',
  'cap', 'nocap', 'bussin', 'lowkey', 'highkey', 'goat', 'ong', 'fanum',
  'tax', 'delulu', 'situationship', 'vibe', 'aura', 'alpha', 'based',
  'cringe', 'sus', 'glaze', 'glazing', 'mewing', 'looksmax', 'looksmaxing',
  'glow', 'glowup', 'mogging', 'pookie', 'twin', 'bestie', 'ate',

  // Gaming
  'fortnite', 'roblox', 'minecraft', 'freefire', 'brawlstars', 'brawl',
  'clashofclans', 'clashroyale', 'valorant', 'fncs', 'cod', 'warzone',
  'genshin', 'honkai', 'pubg', 'apex', 'overwatch', 'mario', 'nintendo',
  'pokemon', 'ps5', 'xbox', 'gaming', 'gamer', 'streamer', 'stream',
  'twitch', 'youtube',

  // Emotes & danses virales
  'emote', 'dance', 'choreo', 'shuffle', 'griddy', 'phonk', 'drift', 'edit',

  // Personnages / mèmes ados
  'grimace', 'bibble', 'quandale', 'dingle', 'ohio', 'peter', 'griffin',
  'spongebob', 'thug', 'hawk', 'tuah', 'ambatukam',

  // Vie scolaire
  'college', 'collège', 'lycee', 'lycée', 'prof', 'cours', 'classe',
  'ecole', 'école', 'brevet', 'bac', 'devoirs', 'exam', 'interro',
  'cantine', 'recre', 'rentree', 'rentrée',

  // Contenu viral typique ados
  'pov', 'challenge', 'duet', 'stitch', 'grwm', 'aesthetic', 'thrift',
  'transformation', 'reveal', 'fit', 'outfit', 'drip', 'sneaker', 'hype',
  'vlog', 'fyp', 'viral',

  // Musiques / artistes ados
  'phonk', 'trap', 'drill', 'rap', 'freestyle', 'afro', 'rnb', 'jul',
  'niska', 'sch', 'sdm', 'booba', 'damso', 'taylorswift', 'swift',
  'sabrina', 'carpenter', 'olivia', 'rodrigo', 'ariana', 'grande',
  'doja', 'cat', 'centralcee',

  // Autres termes viraux
  'satisfying', 'asmr', 'mukbang', 'unboxing', 'prank', 'reaction',
  'tutorial', 'hack', 'iykyk', '67', 'sixseven', 'sksksk',
];

// ---------------------------------------------------------------------------
// CATÉGORIES pour les parents
// ---------------------------------------------------------------------------
function getCategory(tag) {
  const t = tag.toLowerCase();
  const check = (kw) => kw.some(k => t.includes(k));
  if (check(['skibidi','sigma','rizz','gyatt','npc','fanum','delulu','aura','alpha','mewing','looksmax','mogging','glazing','sus','cap','nocap','bussin','goat','ong','based','cringe','pookie'])) return 'Argot internet / Brainrot';
  if (check(['fortnite','roblox','minecraft','freefire','brawl','clash','valorant','cod','genshin','pubg','apex','overwatch','pokemon','mario','gaming','gamer','streamer','twitch'])) return 'Gaming';
  if (check(['emote','dance','choreo','shuffle','griddy','phonk','drift'])) return 'Danse / Emote';
  if (check(['college','collège','lycee','prof','cours','brevet','bac','cantine','recre','vacances','rentrée','rentree'])) return 'Vie scolaire';
  if (check(['pov','challenge','duet','grwm','aesthetic','outfit','drip','sneaker','vlog','viral'])) return 'Contenu viral';
  if (check(['rap','drill','trap','afro','rnb','taylorswift','sabrina','olivia','ariana','doja','centralcee','jul','niska','sch'])) return 'Musique';
  return 'Tendance ados';
}

// ---------------------------------------------------------------------------
// PARSE des nombres : "20.5 Trillion", "2 Billion", "500 Million", "1.2K"…
// ---------------------------------------------------------------------------
function parseCount(str) {
  if (!str) return 0;
  const s = str.trim().replace(/,/g, '');
  const num = parseFloat(s);
  if (isNaN(num)) return 0;
  const low = s.toLowerCase();
  if (low.includes('trillion')) return Math.round(num * 1_000_000_000_000);
  if (low.includes('billion')  || low.endsWith('b')) return Math.round(num * 1_000_000_000);
  if (low.includes('million')  || low.endsWith('m')) return Math.round(num * 1_000_000);
  if (low.includes('thousand') || low.endsWith('k')) return Math.round(num * 1_000);
  return Math.round(num);
}

// ---------------------------------------------------------------------------
// ÉTAPE 1 — tiktokhashtags.com/best-hashtags.php → liste brute
// ---------------------------------------------------------------------------
async function getBestHashtags(page) {
  console.log('\n📋 ÉTAPE 1 — Scraping tiktokhashtags.com/best-hashtags.php...');
  try {
    await page.goto('https://tiktokhashtags.com/best-hashtags.php', {
      waitUntil: 'domcontentloaded',
      timeout: 45000,
    });
    await page.waitForTimeout(3000);

    const hashtags = await page.evaluate(() => {
      const rows = document.querySelectorAll('table tbody tr');
      const results = [];
      rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length < 2) return;
        const link = cells[1]?.querySelector('a');
        const name = (link?.textContent || cells[1]?.textContent || '')
          .trim().replace(/^#/, '').toLowerCase();
        if (name) results.push(name);
      });
      return results;
    });

    console.log(`   → ${hashtags.length} hashtags récupérés`);
    return hashtags;
  } catch (e) {
    console.warn(`   ⚠️  Erreur: ${e.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// ÉTAPE 2 — Filtre collégiens
// ---------------------------------------------------------------------------
function filterCollegeHashtags(hashtags) {
  console.log('\n🎯 ÉTAPE 2 — Filtre mots-clés collégiens...');
  const filtered = hashtags.filter(tag =>
    COLLEGE_KEYWORDS.some(kw => tag.includes(kw))
  );
  console.log(`   → ${filtered.length}/${hashtags.length} correspondances`);
  return filtered;
}

// ---------------------------------------------------------------------------
// ÉTAPE 3 — tiktokhashtags.com/hashtag/[tag]/ → vues & posts (tout-temps)
// ---------------------------------------------------------------------------
async function getHashtagStats(page, hashtag) {
  try {
    await page.goto(`https://tiktokhashtags.com/hashtag/${encodeURIComponent(hashtag)}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(2500);

    const { viewsRaw, postsRaw } = await page.evaluate(() => {
      function getStatByLabel(label) {
        const blocks = Array.from(document.querySelectorAll('.g-line-height-1'));
        const block = blocks.find(el => {
          const h4 = el.querySelector('h4, .h5');
          return h4 && h4.innerText.toUpperCase().includes(label.toUpperCase());
        });
        return block?.querySelector('.g-font-size-26')?.innerText?.trim() || null;
      }
      return {
        viewsRaw: getStatByLabel('Overall Views'),
        postsRaw: getStatByLabel('Overall Posts'),
      };
    });

    return {
      views: parseCount(viewsRaw),
      posts: parseCount(postsRaw),
    };
  } catch (e) {
    return { views: 0, posts: 0 };
  }
}

// ---------------------------------------------------------------------------
// ÉTAPE 4 — Google Trends → score d'actualité (7 derniers jours, France)
// Retourne un score entre 0 et 100.
// 0  = aucune recherche récente
// 100 = pic maximum d'intérêt
// ---------------------------------------------------------------------------
async function getTrendScore(keyword) {
  // Petite pause pour ne pas flooder Google
  await new Promise(r => setTimeout(r, 1200));

  try {
    const raw = await googleTrends.interestOverTime({
      keyword: keyword,   // on cherche le mot sans #
      geo: 'FR',
      startTime: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000), // 7 jours
      hl: 'fr',
    });

    const data = JSON.parse(raw);
    const timeline = data?.default?.timelineData || [];

    if (timeline.length === 0) return 0;

    // Score moyen sur les 7 derniers jours
    const values = timeline.map(d => d.value?.[0] ?? 0);
    const avg = values.reduce((sum, v) => sum + v, 0) / values.length;
    return Math.round(avg);

  } catch (e) {
    // Google Trends peut bloquer ponctuellement — on retourne null (inconnu)
    return null;
  }
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.setExtraHTTPHeaders({
    'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  });

  try {
    // ÉTAPE 1 : liste brute
    const allHashtags = await getBestHashtags(page);
    if (allHashtags.length === 0) {
      console.error('❌ Aucun hashtag récupéré — site inaccessible ?');
      process.exit(1);
    }

    // ÉTAPE 2 : filtre collégiens
    let collegeHashtags = filterCollegeHashtags(allHashtags);
    if (collegeHashtags.length < 3) {
      console.warn('   ⚠️  Peu de matches — ajout des 10 premiers hashtags globaux en fallback.');
      const extras = allHashtags.slice(0, 10).filter(h => !collegeHashtags.includes(h));
      collegeHashtags = [...collegeHashtags, ...extras];
    }

    const toCheck = collegeHashtags.slice(0, MAX_HASHTAGS);

    // ÉTAPE 3 : stats historiques (tiktokhashtags.com)
    console.log(`\n📊 ÉTAPE 3 — Stats historiques sur tiktokhashtags.com (${toCheck.length} hashtags)...`);
    const withStats = [];
    for (const tag of toCheck) {
      process.stdout.write(`   📈 #${tag} ... `);
      const { views, posts } = await getHashtagStats(page, tag);
      const hasMinViews = views >= MIN_VIEWS;
      console.log(views > 0
        ? `${(views / 1_000_000).toFixed(1)}M vues, ${posts.toLocaleString()} posts ${hasMinViews ? '✓' : '(faible)'}`
        : `données indisponibles`
      );
      withStats.push({ tag, views, posts, hasMinViews });
    }

    // ÉTAPE 4 : score d'actualité Google Trends (7 jours, France)
    console.log('\n🔥 ÉTAPE 4 — Vérification actualité Google Trends (7 jours, France)...');
    const results = [];

    for (const item of withStats) {
      process.stdout.write(`   🌡️  #${item.tag} → score Trends : `);
      const trendScore = await getTrendScore(item.tag);

      const scoreLabel = trendScore === null
        ? 'inconnu ⚠️'
        : `${trendScore}/100`;

      const isTrending = trendScore === null || trendScore >= MIN_TREND_SCORE;
      const status = isTrending ? '✅ ACTUEL' : '⛔ plus en vogue';
      console.log(`${scoreLabel} → ${status}`);

      if (isTrending) {
        results.push({
          tag: item.tag,
          views: item.views > 0 ? item.views : null,
          posts: item.posts > 0 ? item.posts : null,
          trendScore,                      // score Google Trends 0-100 (null = inconnu)
          category: getCategory(item.tag),
        });
      }
    }

    console.log(`\n📦 ${results.length} trends collégiens actuels retenus.`);

    // Tri : score Google Trends décroissant (les plus chauds en premier)
    results.sort((a, b) => {
      if (b.trendScore === null && a.trendScore === null) return 0;
      if (b.trendScore === null) return -1;
      if (a.trendScore === null) return 1;
      return b.trendScore - a.trendScore;
    });

    const output = {
      lastUpdate: new Date().toISOString(),
      sources: ['tiktokhashtags.com', 'Google Trends (FR, 7j)'],
      filteredForCollege: true,
      trends: results,
    };

    fs.writeFileSync('trends.json', JSON.stringify(output, null, 2));
    console.log(`\n✅ trends.json mis à jour avec ${results.length} entrées.`);

  } catch (error) {
    console.error('❌ Erreur fatale:', error.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

run();

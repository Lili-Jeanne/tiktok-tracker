const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const googleTrends = require('google-trends-api');
const fs = require('fs');

chromium.use(stealth);

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const MIN_TREND_SCORE_30D = 15;  // Score moyen Google Trends minimum sur les 30 derniers jours
const RISING_RATIO = 1.5; // Le score 30j doit être 1.5x plus élevé qu'avant pour être "récent"
const MAX_FINAL_TRENDS = 20;  // Nombre max de trends dans le JSON final
const MAX_POOL_FOR_GT = 40;  // Nombre max de candidats envoyés à Google Trends
const GT_BATCH_SIZE = 4;   // Requêtes Google Trends en parallèle (anti-throttle)
const GT_BATCH_DELAY_MS = 600; // Délai entre chaque batch GT (ms)

// ---------------------------------------------------------------------------
// MOTS-CLÉS "GRAINE" — ce sont les termes qu'on va taper dans la recherche
// tiktokhashtags.com pour récolter les hashtags connexes utilisés par les ados.
// On cible les plus spécifiques à la culture collégienne.
// ---------------------------------------------------------------------------
// Seeds réduits aux 15 plus représentatifs pour limiter le temps de scraping
const SEED_KEYWORDS = [
  // Brainrot / argot internet
  'skibidi', 'sigma', 'rizz', 'npc', 'aura', 'mewing', 'pookie',
  // Gaming
  'fortnite', 'roblox', 'freefire', 'brawlstars',
  // Danses / emotes
  'phonk', 'drift',
  // Contenu viral
  'pov', 'ohio',
];

// ---------------------------------------------------------------------------
// CATÉGORIES pour les parents
// ---------------------------------------------------------------------------
function getCategory(tag) {
  const t = tag.toLowerCase();
  const check = (kw) => kw.some(k => t.includes(k));
  if (check(['skibidi', 'sigma', 'rizz', 'gyatt', 'npc', 'fanum', 'delulu', 'aura', 'alpha', 'mewing', 'looksmax', 'mogging', 'glazing', 'sus', 'cap', 'nocap', 'bussin', 'goat', 'based', 'cringe', 'pookie', 'brainrot'])) return 'Argot internet / Brainrot';
  if (check(['fortnite', 'roblox', 'minecraft', 'freefire', 'brawl', 'clash', 'valorant', 'cod', 'genshin', 'pubg', 'apex', 'overwatch', 'pokemon', 'mario', 'gaming', 'gamer', 'streamer', 'twitch'])) return 'Gaming';
  if (check(['emote', 'dance', 'choreo', 'shuffle', 'griddy', 'phonk', 'drift'])) return 'Danse / Emote';
  if (check(['college', 'collège', 'lycee', 'prof', 'cours', 'brevet', 'bac', 'cantine', 'recre', 'rentree'])) return 'Vie scolaire';
  if (check(['pov', 'challenge', 'duet', 'grwm', 'aesthetic', 'outfit', 'drip', 'sneaker', 'vlog', 'viral', 'ohio'])) return 'Contenu viral';
  if (check(['rap', 'drill', 'trap', 'afro', 'rnb', 'taylorswift', 'sabrina', 'olivia', 'ariana', 'doja', 'centralcee', 'jul', 'niska', 'sch'])) return 'Musique';
  return 'Tendance ados';
}

// ---------------------------------------------------------------------------
// PARSE des nombres : "20.5 Trillion", "2 Billion", "500K"…
// ---------------------------------------------------------------------------
function parseCount(str) {
  if (!str) return 0;
  const s = str.trim().replace(/,/g, '');
  const num = parseFloat(s);
  if (isNaN(num)) return 0;
  const low = s.toLowerCase();
  if (low.includes('trillion')) return Math.round(num * 1_000_000_000_000);
  if (low.includes('billion') || low.endsWith('b')) return Math.round(num * 1_000_000_000);
  if (low.includes('million') || low.endsWith('m')) return Math.round(num * 1_000_000);
  if (low.includes('thousand') || low.endsWith('k')) return Math.round(num * 1_000);
  return Math.round(num);
}

// ---------------------------------------------------------------------------
// ÉTAPE 1 — Pour chaque mot-clé graine, visite sa page sur tiktokhashtags.com
// et récupère : ses propres stats + les hashtags connexes du tableau "Top 10"
// ---------------------------------------------------------------------------
async function scrapeKeywordPage(page, keyword) {
  try {
    await page.goto(`https://tiktokhashtags.com/hashtag/${encodeURIComponent(keyword)}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 25000,
    });
    await page.waitForTimeout(1200);

    return await page.evaluate((kw) => {
      // --- Stats du hashtag principal ---
      function getStatByLabel(label) {
        const blocks = Array.from(document.querySelectorAll('.g-line-height-1'));
        const block = blocks.find(el => {
          const h4 = el.querySelector('h4, .h5');
          return h4 && h4.innerText.toUpperCase().includes(label.toUpperCase());
        });
        return block?.querySelector('.g-font-size-26')?.innerText?.trim() || null;
      }
      const selfViewsRaw = getStatByLabel('Overall Views');
      const selfPostsRaw = getStatByLabel('Overall Posts');

      // --- Hashtags connexes dans le tableau "Top 10" ---
      const relatedHashtags = [];
      const rows = document.querySelectorAll('table tbody tr');
      rows.forEach(row => {
        const cells = row.querySelectorAll('td');
        if (cells.length < 2) return;
        const link = cells[1]?.querySelector('a');
        const name = (link?.textContent || cells[1]?.textContent || '')
          .trim().replace(/^#/, '').toLowerCase();
        const viewsRaw = cells[3]?.textContent?.trim() || null;
        const postsRaw = cells[2]?.textContent?.trim() || null;
        if (name && name !== kw) {
          relatedHashtags.push({ tag: name, viewsRaw, postsRaw });
        }
      });

      return {
        self: { tag: kw, viewsRaw: selfViewsRaw, postsRaw: selfPostsRaw },
        related: relatedHashtags,
      };
    }, keyword);

  } catch (e) {
    console.warn(`   ⚠️  Échec pour #${keyword}: ${e.message}`);
    return { self: { tag: keyword, viewsRaw: null, postsRaw: null }, related: [] };
  }
}

// ---------------------------------------------------------------------------
// ÉTAPE 2 — Google Trends (90 jours, France) → détecte si le hashtag EST
// populaire sur les 30 DERNIERS jours (et pas juste historiquement).
// ---------------------------------------------------------------------------
async function analyzeGoogleTrends(keyword) {
  try {
    const raw = await googleTrends.interestOverTime({
      keyword,
      geo: 'FR',
      startTime: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
      hl: 'fr',
    });
    const data = JSON.parse(raw);
    const timeline = data?.default?.timelineData || [];
    if (timeline.length === 0) return null;

    const values = timeline.map(d => d.value?.[0] ?? 0);
    const third = Math.floor(values.length / 3);
    const avg = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;

    const score30d = avg(values.slice(2 * third));
    const scorePrev60 = avg(values.slice(0, 2 * third));
    const isRising = score30d >= MIN_TREND_SCORE_30D &&
      (scorePrev60 === 0 || score30d >= scorePrev60 * RISING_RATIO);
    const isActive = score30d >= MIN_TREND_SCORE_30D;

    return {
      score30d: Math.round(score30d),
      scorePrev60: Math.round(scorePrev60),
      isRising,
      isActive,
      isTrending: isActive,
    };
  } catch (e) {
    return null;
  }
}

// Exécute Google Trends en parallèle par batch pour réduire le temps total
async function analyzeGoogleTrendsBatch(items) {
  const results = [];
  for (let i = 0; i < items.length; i += GT_BATCH_SIZE) {
    const batch = items.slice(i, i + GT_BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(item => analyzeGoogleTrends(item.tag)));
    batchResults.forEach((gt, j) => results.push({ item: batch[j], gt }));
    // Petite pause entre les batchs pour ne pas se faire bloquer par Google
    if (i + GT_BATCH_SIZE < items.length) {
      await new Promise(r => setTimeout(r, GT_BATCH_DELAY_MS));
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// ÉTAPE 3 — Visite tiktok.com/tag/[hashtag] et récupère la 1ère vidéo populaire
// Retourne { videoUrl, videoId, embedUrl, author, description } ou null
// ---------------------------------------------------------------------------
async function getExampleVideo(page, hashtag) {
  try {
    await page.goto(`https://www.tiktok.com/tag/${encodeURIComponent(hashtag)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 25000,
    });
    await page.waitForTimeout(2500);

    // Récupère les liens de vidéos présents sur la page (format /@user/video/ID)
    const videoData = await page.evaluate(() => {
      const links = Array.from(document.querySelectorAll('a[href*="/video/"]'));
      for (const link of links) {
        const href = link.href || '';
        const match = href.match(/\/@([^/]+)\/video\/(\d+)/);
        if (match) {
          // Cherche la description dans les éléments proches
          const container = link.closest('[class*="item"], [class*="card"], article, li') || link;
          const desc = container.querySelector('[class*="desc"], p, span[class*="text"]')?.textContent?.trim() || '';
          return {
            author: '@' + match[1],
            videoId: match[2],
            videoUrl: href,
            description: desc.slice(0, 120) || null,
          };
        }
      }
      return null;
    });

    if (!videoData) return null;

    return {
      ...videoData,
      embedUrl: `https://www.tiktok.com/embed/v2/${videoData.videoId}`,
    };

  } catch (e) {
    return null; // TikTok a bloqué ou timeout
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
    // ── ÉTAPE 1 : Scraping de chaque mot-clé sur tiktokhashtags.com ─────────
    console.log(`\n🔍 ÉTAPE 1 — Recherche de ${SEED_KEYWORDS.length} mots-clés sur tiktokhashtags.com...`);
    const seen = new Set();
    const pool = []; // { tag, views, posts }

    for (const kw of SEED_KEYWORDS) {
      process.stdout.write(`   🌐 #${kw} ... `);
      const { self, related } = await scrapeKeywordPage(page, kw);

      // Ajoute le hashtag graine lui-même
      if (!seen.has(kw)) {
        seen.add(kw);
        pool.push({
          tag: kw,
          views: parseCount(self.viewsRaw),
          posts: parseCount(self.postsRaw),
        });
      }

      // Ajoute les hashtags connexes trouvés
      let newRelated = 0;
      for (const r of related) {
        if (!seen.has(r.tag)) {
          seen.add(r.tag);
          pool.push({
            tag: r.tag,
            views: parseCount(r.viewsRaw),
            posts: parseCount(r.postsRaw),
          });
          newRelated++;
        }
      }
      console.log(`${related.length} connexes (+${newRelated} nouveaux)`);
    }

    console.log(`\n   📦 Pool total dédupliqué : ${pool.length} hashtags candidats`);

    // ── ÉTAPE 2 : Google Trends en parallèle (batchs de 4) ──────────────────
    // Pré-filtre : on limite le pool aux MAX_POOL_FOR_GT candidats les plus vus
    // pour éviter d'envoyer 300 requêtes à Google.
    const poolForGT = pool
      .sort((a, b) => (b.views || 0) - (a.views || 0))
      .slice(0, MAX_POOL_FOR_GT);

    console.log(`\n📈 ÉTAPE 2 — Google Trends (batchs de ${GT_BATCH_SIZE}, ${poolForGT.length} candidats)...`);
    console.log(`   Seuil : score 30j ≥ ${MIN_TREND_SCORE_30D}/100`);

    const batchResults = await analyzeGoogleTrendsBatch(poolForGT);
    const results = [];

    for (const { item, gt } of batchResults) {
      if (gt === null) {
        console.log(`   ⚠️  #${item.tag} → données indisponibles (gardé)`);
        results.push({
          tag: item.tag, views: item.views || null, posts: item.posts || null,
          trendScore: null, isRising: null, category: getCategory(item.tag),
        });
      } else if (gt.isTrending) {
        console.log(`   ✅ #${item.tag} → ${gt.score30d}/100 ${gt.isRising ? '📈' : '📊'}`);
        results.push({
          tag: item.tag, views: item.views || null, posts: item.posts || null,
          trendScore: gt.score30d, isRising: gt.isRising, category: getCategory(item.tag),
        });
      } else {
        console.log(`   ⛔ #${item.tag} → ${gt.score30d}/100 (ignoré)`);
      }
    }

    console.log(`\n   ✅ ${results.length} hashtags actifs chez les collégiens (30j)`);

    // Tri : en hausse d'abord, puis par score décroissant
    results.sort((a, b) => {
      if (a.isRising && !b.isRising) return -1;
      if (!a.isRising && b.isRising) return 1;
      return (b.trendScore ?? 0) - (a.trendScore ?? 0);
    });

    const finalTrends = results.slice(0, MAX_FINAL_TRENDS);

    // ── ÉTAPE 3 : Récupération d'une vidéo exemple sur TikTok ───────────────
    console.log(`\n🎬 ÉTAPE 3 — Recherche d'une vidéo exemple sur TikTok pour chaque trend...`);

    for (const trend of finalTrends) {
      process.stdout.write(`   🎥 #${trend.tag} → `);
      const video = await getExampleVideo(page, trend.tag);
      if (video) {
        trend.exampleVideo = video;
        console.log(`✅ ${video.author} (ID: ${video.videoId})`);
      } else {
        trend.exampleVideo = null;
        console.log(`⚠️  aucune vidéo trouvée`);
      }
    }

    const output = {
      lastUpdate: new Date().toISOString(),
      sources: ['tiktokhashtags.com (recherche par mot-clé)', 'Google Trends FR (90j)', 'TikTok (vidéo exemple)'],
      filteredForCollege: true,
      methodology: 'Hashtags connexes aux mots-clés collégiens, actifs sur les 30 derniers jours en France',
      trends: finalTrends,
    };

    fs.writeFileSync('trends.json', JSON.stringify(output, null, 2));
    console.log(`\n✅ trends.json mis à jour avec ${finalTrends.length} entrées.`);

  } catch (error) {
    console.error('❌ Erreur fatale:', error.message);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

run();

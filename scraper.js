const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const googleTrends = require('google-trends-api');
const fs = require('fs');

chromium.use(stealth);

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const MIN_TREND_SCORE_30D = 15;  // Score moyen Google Trends minimum sur les 30 derniers jours
const RISING_RATIO        = 1.5; // Le score 30j doit être 1.5x plus élevé qu'avant pour être "récent"
const MAX_FINAL_TRENDS    = 20;  // Nombre max de trends dans le JSON final

// ---------------------------------------------------------------------------
// MOTS-CLÉS "GRAINE" — ce sont les termes qu'on va taper dans la recherche
// tiktokhashtags.com pour récolter les hashtags connexes utilisés par les ados.
// On cible les plus spécifiques à la culture collégienne.
// ---------------------------------------------------------------------------
const SEED_KEYWORDS = [
  // Brainrot / argot internet
  'skibidi', 'sigma', 'rizz', 'gyatt', 'npc', 'aura', 'mewing', 'looksmax',
  'delulu', 'fanum', 'pookie', 'mogging', 'glazing', 'slay', 'based', 'sus',
  // Gaming
  'fortnite', 'roblox', 'minecraft', 'freefire', 'brawlstars', 'valorant',
  'genshin', 'pokemon',
  // Danses / emotes
  'phonk', 'drift', 'griddy', 'emote',
  // Contenu viral
  'pov', 'fyp', 'challenge', 'ohio', 'brainrot',
];

// ---------------------------------------------------------------------------
// CATÉGORIES pour les parents
// ---------------------------------------------------------------------------
function getCategory(tag) {
  const t = tag.toLowerCase();
  const check = (kw) => kw.some(k => t.includes(k));
  if (check(['skibidi','sigma','rizz','gyatt','npc','fanum','delulu','aura','alpha','mewing','looksmax','mogging','glazing','sus','cap','nocap','bussin','goat','based','cringe','pookie','brainrot'])) return 'Argot internet / Brainrot';
  if (check(['fortnite','roblox','minecraft','freefire','brawl','clash','valorant','cod','genshin','pubg','apex','overwatch','pokemon','mario','gaming','gamer','streamer','twitch'])) return 'Gaming';
  if (check(['emote','dance','choreo','shuffle','griddy','phonk','drift'])) return 'Danse / Emote';
  if (check(['college','collège','lycee','prof','cours','brevet','bac','cantine','recre','rentree'])) return 'Vie scolaire';
  if (check(['pov','challenge','duet','grwm','aesthetic','outfit','drip','sneaker','vlog','viral','ohio'])) return 'Contenu viral';
  if (check(['rap','drill','trap','afro','rnb','taylorswift','sabrina','olivia','ariana','doja','centralcee','jul','niska','sch'])) return 'Musique';
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
  if (low.includes('billion')  || low.endsWith('b')) return Math.round(num * 1_000_000_000);
  if (low.includes('million')  || low.endsWith('m')) return Math.round(num * 1_000_000);
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
      timeout: 30000,
    });
    await page.waitForTimeout(2000);

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
//
// Retourne :
//   { score30d, score60to90d, isRecent, trendScore }
//   isRecent = true si le score 30j est au moins RISING_RATIO fois > le score précédent
// ---------------------------------------------------------------------------
async function analyzeGoogleTrends(keyword) {
  await new Promise(r => setTimeout(r, 1000 + Math.random() * 500)); // anti-throttle

  try {
    const raw = await googleTrends.interestOverTime({
      keyword,
      geo: 'FR',
      startTime: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000), // 90 jours
      hl: 'fr',
    });

    const data = JSON.parse(raw);
    const timeline = data?.default?.timelineData || [];
    if (timeline.length === 0) return null;

    const values = timeline.map(d => d.value?.[0] ?? 0);
    const total = values.length;

    // Découpe en 3 périodes : j-90→j-60, j-60→j-30, j-30→aujourd'hui
    const third = Math.floor(total / 3);
    const old   = values.slice(0, third);
    const mid   = values.slice(third, 2 * third);
    const recent= values.slice(2 * third);

    const avg = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0;

    const scoreOld    = avg(old);
    const scoreMid    = avg(mid);
    const score30d    = avg(recent);
    const scorePrev60 = avg([...old, ...mid]);

    // "Récent" : le score des 30 derniers jours est plus élevé qu'avant
    const isRising = score30d >= MIN_TREND_SCORE_30D &&
                     (scorePrev60 === 0 || score30d >= scorePrev60 * RISING_RATIO);

    // "Actif" : encore populaire maintenant même si ça dure un peu
    const isActive = score30d >= MIN_TREND_SCORE_30D;

    return {
      score30d: Math.round(score30d),
      scorePrev60: Math.round(scorePrev60),
      isRising,
      isActive,
      isTrending: isActive, // on garde tout ce qui est actif dans les 30j
    };

  } catch (e) {
    return null; // Google Trends throttling → on garde le hashtag par défaut
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
    const seen  = new Set();
    const pool  = []; // { tag, views, posts }

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

    // ── ÉTAPE 2 : Google Trends — filtrage par actualité (30 derniers jours) ─
    console.log(`\n📈 ÉTAPE 2 — Analyse Google Trends (90j, France) pour chaque candidat...`);
    console.log(`   Seuil : score 30j ≥ ${MIN_TREND_SCORE_30D}/100`);

    const results = [];

    for (const item of pool) {
      process.stdout.write(`   🌡️  #${item.tag} → `);
      const gt = await analyzeGoogleTrends(item.tag);

      if (gt === null) {
        // Google Trends n'a pas de données → on garde mais on marque
        console.log(`données indisponibles → ⚠️ gardé (inconnu)`);
        results.push({
          tag:        item.tag,
          views:      item.views > 0 ? item.views : null,
          posts:      item.posts > 0 ? item.posts : null,
          trendScore: null,
          isRising:   null,
          category:   getCategory(item.tag),
        });
      } else if (gt.isTrending) {
        const risingLabel = gt.isRising ? '📈 EN HAUSSE' : '📊 stable';
        console.log(`score 30j: ${gt.score30d}/100, avant: ${gt.scorePrev60}/100 → ✅ ${risingLabel}`);
        results.push({
          tag:        item.tag,
          views:      item.views > 0 ? item.views : null,
          posts:      item.posts > 0 ? item.posts : null,
          trendScore: gt.score30d,
          isRising:   gt.isRising,
          category:   getCategory(item.tag),
        });
      } else {
        console.log(`score 30j: ${gt.score30d}/100 → ⛔ pas assez actif`);
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

    const output = {
      lastUpdate: new Date().toISOString(),
      sources: ['tiktokhashtags.com (recherche par mot-clé)', 'Google Trends FR (90j)'],
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

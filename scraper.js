require('dotenv').config();
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
// SEEDS DE SECOURS — utilisés si Gemini est indisponible
// ---------------------------------------------------------------------------
const FALLBACK_SEEDS = [
  'skibidi', 'sigma', 'rizz', 'npc', 'aura', 'mewing', 'pookie',
  'fortnite', 'roblox', 'freefire', 'brawlstars',
  'phonk', 'drift', 'pov', 'ohio',
];

// ---------------------------------------------------------------------------
// GÉNÉRATION DES MOTS-CLÉS PAR IA
// Demande à Gemini quels hashtags / termes sont utilisés en ce moment
// par les collégiens français (11-15 ans). Résultat = liste de ~20 mots-clés.
// ---------------------------------------------------------------------------
async function generateSeedKeywords() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('   ⚠️  GEMINI_API_KEY absente — utilisation des seeds de secours.');
    return FALLBACK_SEEDS;
  }

  const today = new Date().toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });

  const prompt = `Tu es un expert de la culture internet et des tendances TikTok des collégiens français (11-15 ans), en ${today}.

Génère une liste de 20 mots-clés / hashtags TikTok qui sont en ce moment les plus utilisés par les collégiens français.
Inclus : argot brainrot, gaming, memes viraux, danses, termes musicaux ados, etc.
Les termes doivent être courts (1 mot ou expression collée), en minuscules, sans #.
Préfère les termes qui donnent le plus de hashtags connexes sur TikTok.

Réponds UNIQUEMENT avec un tableau JSON valide de chaînes, sans markdown :
["terme1","terme2",...]`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.4 },
        }),
      }
    );
    const data = await res.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
    const jsonMatch = raw.match(/\[.*?\]/s);
    if (!jsonMatch) throw new Error('Pas de JSON dans la réponse');

    const keywords = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(keywords) || keywords.length === 0) throw new Error('Liste vide');

    // Nettoyage : minuscules, sans #, uniquement alphanumérique
    const cleaned = keywords
      .map(k => String(k).toLowerCase().replace(/^#/, '').trim())
      .filter(k => k.length > 1 && k.length < 30);

    console.log(`   🤖 Gemini a généré ${cleaned.length} seeds : ${cleaned.slice(0, 8).join(', ')}…`);
    return cleaned;

  } catch (e) {
    console.warn(`   ⚠️  Erreur génération seeds (${e.message}) — seeds de secours utilisés.`);
    return FALLBACK_SEEDS;
  }
}

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
// ÉTAPE 2a — Gemini AI : filtre principal
// Vérifie lesquels sont vraiment des trends collégiens ET génère des explications
// pour les parents. Envoi en une seule requête batch → rapide.
// ---------------------------------------------------------------------------
async function classifyWithAI(candidates) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.warn('   ⚠️  GEMINI_API_KEY absente — classification IA ignorée (tous gardés).');
    // Sans clé, on retourne tous les candidats comme "valides" mais sans explication
    return Object.fromEntries(candidates.map(c => [c.tag, { isCollegeTrend: true, confidence: 50, explanation: null }]));
  }

  const tagList = candidates.map(c => c.tag).join(', ');

  const prompt = `Tu es un expert de la culture internet et des tendances TikTok chez les adolescents français de 11 à 15 ans (collégiens).

Je te donne une liste de hashtags TikTok. Pour chacun :
1. Détermine si ce hashtag est actuellement utilisé ou apprécié par les collégiens français (pas juste en général, mais spécifiquement dans la tranche 11-15 ans en 2024-2025).
2. Si oui, rédige en français une explication courte (1-2 phrases max) destinée aux parents qui ne connaissent pas ce terme. Commence par "Ce hashtag", "Tendance où" ou "Mème où".
3. Donne une confiance de 0 à 100 sur le fait que ce soit une vraie trend collégienne active.

Réponds UNIQUEMENT en JSON valide, sans markdown, format exact :
[{"tag":"nom","isCollegeTrend":true,"confidence":85,"explanation":"..."},...]

Hashtags à analyser : ${tagList}`;

  try {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2 },
        }),
      }
    );

    const data = await res.json();
    const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';

    // Extrait le JSON même si Gemini ajoute du texte autour
    const jsonMatch = raw.match(/\[.*\]/s);
    if (!jsonMatch) throw new Error('Pas de JSON dans la réponse Gemini');

    const parsed = JSON.parse(jsonMatch[0]);
    const map = {};
    for (const item of parsed) {
      if (item.tag) map[item.tag.toLowerCase()] = {
        isCollegeTrend: item.isCollegeTrend === true,
        confidence: item.confidence ?? 50,
        explanation: item.explanation || null,
      };
    }
    return map;

  } catch (e) {
    console.warn(`   ⚠️  Erreur Gemini: ${e.message} — tous les candidats seront gardés.`);
    return Object.fromEntries(candidates.map(c => [c.tag, { isCollegeTrend: true, confidence: 50, explanation: null }]));
  }
}

// ---------------------------------------------------------------------------
// ÉTAPE 2b — Google Trends (signal secondaire, non bloquant)
// Donne un trendScore 0-100 pour l'affichage (barre de progression).
// Ne filtre plus — sert juste à trier et afficher.
// ---------------------------------------------------------------------------
async function getGoogleTrendScore(keyword) {
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
    return { score30d: Math.round(score30d), isRising };
  } catch (e) {
    return null;
  }
}

async function getGoogleTrendsBatch(items) {
  const results = [];
  for (let i = 0; i < items.length; i += GT_BATCH_SIZE) {
    const batch = items.slice(i, i + GT_BATCH_SIZE);
    const batchResults = await Promise.all(batch.map(item => getGoogleTrendScore(item.tag)));
    batchResults.forEach((gt, j) => results.push({ item: batch[j], gt }));
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
    // ── ÉTAPE 0 : Génération des mots-clés de recherche par IA ───────────────
    console.log('\n🤖 ÉTAPE 0 — Génération des mots-clés de recherche par Gemini AI...');
    const seedKeywords = await generateSeedKeywords();

    // ── ÉTAPE 1 : Scraping de chaque mot-clé sur tiktokhashtags.com ──────────
    console.log(`\n🔍 ÉTAPE 1 — Recherche de ${seedKeywords.length} mots-clés sur tiktokhashtags.com...`);
    const seen = new Set();
    const pool = []; // { tag, views, posts }

    for (const kw of seedKeywords) {
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

    // ── ÉTAPE 2a : Gemini AI — filtre principal ──────────────────────────────
    // Limite le pool aux MAX_POOL_FOR_GT plus vus avant d'appeler l'IA
    const poolForAI = pool
      .sort((a, b) => (b.views || 0) - (a.views || 0))
      .slice(0, MAX_POOL_FOR_GT);

    console.log(`\n🤖 ÉTAPE 2a — Classification Gemini AI (${poolForAI.length} candidats)...`);
    const aiResults = await classifyWithAI(poolForAI);

    const aiFiltered = poolForAI.filter(item => {
      const ai = aiResults[item.tag.toLowerCase()];
      const keep = !ai || ai.isCollegeTrend === true;
      if (ai) {
        const icon = ai.isCollegeTrend ? '✅' : '⛔';
        console.log(`   ${icon} #${item.tag} (confiance: ${ai.confidence ?? '?'}/100)${ai.explanation ? ' — ' + ai.explanation.slice(0, 60) + '…' : ''}`);
      }
      return keep;
    });

    console.log(`\n   → ${aiFiltered.length} trends collégiens validés par l'IA`);

    // ── ÉTAPE 2b : Google Trends — signal secondaire (trendScore uniquement) ──
    console.log(`\n📈 ÉTAPE 2b — Google Trends (signal secondaire, batchs de ${GT_BATCH_SIZE})...`);
    const gtBatch = await getGoogleTrendsBatch(aiFiltered);

    const results = aiFiltered.map(item => {
      const gtData = gtBatch.find(r => r.item.tag === item.tag)?.gt || null;
      const ai = aiResults[item.tag.toLowerCase()];
      console.log(`   📊 #${item.tag} → score GT: ${gtData ? gtData.score30d : '—'}/100`);
      return {
        tag: item.tag,
        views: item.views || null,
        posts: item.posts || null,
        trendScore: gtData?.score30d ?? null,
        isRising: gtData?.isRising ?? null,
        aiConfidence: ai?.confidence ?? null,
        explanation: ai?.explanation ?? null,
        category: getCategory(item.tag),
      };
    });

    // Tri : confiance IA décroissante, puis score GT
    results.sort((a, b) => {
      const ca = a.aiConfidence ?? 50;
      const cb = b.aiConfidence ?? 50;
      if (cb !== ca) return cb - ca;
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
      sources: ['tiktokhashtags.com', 'Gemini AI (filtre principal)', 'Google Trends FR 90j (score)', 'TikTok (vidéo)'],
      filteredForCollege: true,
      methodology: 'Hashtags connexes aux mots-clés collégiens, validés par Gemini AI, scorés par Google Trends',
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

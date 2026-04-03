const { chromium } = require('playwright-extra');
const stealth = require('puppeteer-extra-plugin-stealth')();
const fs = require('fs');

chromium.use(stealth);

// ---------------------------------------------------------------------------
// MOTS-CLÉS COLLÉGIENS (11-15 ans) — filtre strict
// Un hashtag doit contenir AU MOINS UN de ces termes pour être gardé.
// ---------------------------------------------------------------------------
const COLLEGE_KEYWORDS = [
  // Argot "brainrot" & internet slang
  'skibidi', 'sigma', 'rizz', 'gyatt', 'slay', 'npc', 'grind', 'ratio',
  'cap', 'nocap', 'bussin', 'lowkey', 'highkey', 'goat', 'ong', 'fanum',
  'tax', 'delulu', 'situationship', 'vibe', 'aura', 'alpha', 'based',
  'cringe', 'sus', 'glaze', 'glazing', 'mewing', 'looksmax', 'looksmaxing',
  'glow', 'glowup', 'mogging', 'pookie', 'twin', 'bestie', 'ate',

  // Gaming (très présent chez les collégiens)
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
// SEUIL DE POPULARITÉ : on ne garde que les hashtags avec assez de vues.
// Ajustable selon les résultats.
// ---------------------------------------------------------------------------
const MIN_VIEWS = 1_000_000; // 1 million de vues minimum

// ---------------------------------------------------------------------------
// CATÉGORIES pour aider les parents
// ---------------------------------------------------------------------------
function getCategory(tag) {
  const t = tag.toLowerCase();
  const check = (keywords) => keywords.some(k => t.includes(k));

  if (check(['skibidi','sigma','rizz','gyatt','npc','fanum','delulu','aura','alpha','mewing','looksmax','mogging','glazing','sus','cap','nocap','bussin','goat','ong','based','cringe','pookie'])) return 'Argot internet / Brainrot';
  if (check(['fortnite','roblox','minecraft','freefire','brawl','clash','valorant','cod','genshin','pubg','apex','overwatch','pokemon','mario','gaming','gamer','streamer','twitch'])) return 'Gaming';
  if (check(['emote','dance','choreo','shuffle','griddy','phonk','drift'])) return 'Danse / Emote';
  if (check(['college','collège','lycee','prof','cours','brevet','bac','cantine','recre','vacances','rentrée','rentree'])) return 'Vie scolaire';
  if (check(['pov','challenge','duet','grwm','aesthetic','outfit','drip','sneaker','vlog','viral'])) return 'Contenu viral';
  if (check(['rap','drill','trap','afro','rnb','taylorswift','sabrina','olivia','ariana','doja','centralcee','jul','niska','sch'])) return 'Musique';
  return 'Tendance ados';
}

// ---------------------------------------------------------------------------
// PARSE des nombres (ex: "177.9K", "2.3M", "1,500,000")
// ---------------------------------------------------------------------------
function parseCount(str) {
  if (!str) return 0;
  const s = str.trim().replace(/,/g, '');
  const num = parseFloat(s);
  if (isNaN(num)) return 0;
  if (s.endsWith('B') || s.toLowerCase().includes('billion')) return Math.round(num * 1_000_000_000);
  if (s.endsWith('M') || s.toLowerCase().includes('million')) return Math.round(num * 1_000_000);
  if (s.endsWith('K') || s.toLowerCase().includes('thousand')) return Math.round(num * 1_000);
  return Math.round(num);
}

// ---------------------------------------------------------------------------
// ÉTAPE 1 : Récupère les 100 hashtags les plus populaires sur tiktokhashtags.com
// ---------------------------------------------------------------------------
async function getBestHashtags(page) {
  console.log('\n📋 ÉTAPE 1 — Récupération des hashtags populaires (tiktokhashtags.com)...');
  
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
        // La 2ème colonne contient le lien avec le nom du hashtag
        const link = cells[1]?.querySelector('a');
        const name = link?.textContent?.trim()?.replace(/^#/, '') || cells[1]?.textContent?.trim()?.replace(/^#/, '');
        if (name) results.push(name.toLowerCase());
      });
      return results;
    });

    console.log(`   → ${hashtags.length} hashtags récupérés depuis best-hashtags.php`);
    return hashtags;

  } catch (e) {
    console.warn(`   ⚠️  Erreur best-hashtags.php: ${e.message}`);
    return [];
  }
}

// ---------------------------------------------------------------------------
// ÉTAPE 2 : Filtre par mots-clés collégiens
// ---------------------------------------------------------------------------
function filterCollegeHashtags(hashtags) {
  console.log('\n🎯 ÉTAPE 2 — Filtrage par mots-clés collégiens...');
  const filtered = hashtags.filter(tag =>
    COLLEGE_KEYWORDS.some(keyword => tag.includes(keyword))
  );
  console.log(`   → ${filtered.length} hashtags collégiens détectés sur ${hashtags.length} au total`);
  return filtered;
}

// ---------------------------------------------------------------------------
// ÉTAPE 3 : Vérifie la popularité de chaque hashtag sur sa page de détail
// ---------------------------------------------------------------------------
async function getHashtagDetails(page, hashtag) {
  try {
    await page.goto(`https://tiktokhashtags.com/hashtag/${encodeURIComponent(hashtag)}/`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000,
    });
    await page.waitForTimeout(2000);

    const details = await page.evaluate(() => {
      // Les stats sont dans des boîtes colorées en haut de la page
      // Structure générique : on cherche les grands chiffres affichés
      const statBoxes = document.querySelectorAll('.card-body h3, .card-body .h3, .stat-box h3, .info-box h3, [class*="card"] h4, [class*="stat"] span');
      const texts = Array.from(statBoxes).map(el => el.textContent?.trim()).filter(Boolean);

      // Fallback : cherche tous les éléments qui ressemblent à des nombres grands
      const allText = document.body.innerText;
      
      // Cherche "posts" et "views" dans le texte de la page
      const postsMatch = allText.match(/(\d[\d,.\s]*[KMB]?)\s*(?:posts?|vidéos?)/i);
      const viewsMatch = allText.match(/(\d[\d,.\s]*[KMB]?)\s*(?:views?|vues?)/i);

      // Cherche aussi dans les éléments de stat stylisés
      const bigNumbers = Array.from(document.querySelectorAll('h2, h3, h4, .display-4, .display-5, strong'))
        .map(el => el.textContent?.trim())
        .filter(t => /^[\d,.\s]+[KMBkmb]?$/.test(t || ''));

      return {
        rawTexts: texts.slice(0, 10),
        postsRaw: postsMatch ? postsMatch[1] : null,
        viewsRaw: viewsMatch ? viewsMatch[1] : null,
        bigNumbers: bigNumbers.slice(0, 6),
        pageTitle: document.title,
      };
    });

    const views = parseCount(details.viewsRaw || details.bigNumbers[1] || details.bigNumbers[0] || '0');
    const posts = parseCount(details.postsRaw || details.bigNumbers[0] || '0');

    return { views, posts, raw: details };

  } catch (e) {
    console.warn(`   ⚠️  Impossible de charger la page pour #${hashtag}: ${e.message}`);
    return { views: 0, posts: 0 };
  }
}

// ---------------------------------------------------------------------------
// MAIN
// ---------------------------------------------------------------------------
async function run() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // Headers réalistes pour éviter le blocage
  await page.setExtraHTTPHeaders({
    'Accept-Language': 'fr-FR,fr;q=0.9,en;q=0.8',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  });

  try {
    // --- ÉTAPE 1 : Récupère les hashtags populaires ---
    const allHashtags = await getBestHashtags(page);

    if (allHashtags.length === 0) {
      console.error('❌ Aucun hashtag récupéré — le site est peut-être inaccessible.');
      process.exit(1);
    }

    // --- ÉTAPE 2 : Filtre collégiens ---
    let collegeHashtags = filterCollegeHashtags(allHashtags);

    // Si trop peu de résultats (<3), on élargit et on prend les 10 premiers bruts
    if (collegeHashtags.length < 3) {
      console.warn('   ⚠️  Peu de correspondances — on inclut aussi les 10 premiers hashtags globaux.');
      const extras = allHashtags.slice(0, 10).filter(h => !collegeHashtags.includes(h));
      collegeHashtags = [...collegeHashtags, ...extras];
    }

    // Limite à 15 hashtags max pour ne pas trop surcharger les requêtes
    const toCheck = collegeHashtags.slice(0, 15);

    // --- ÉTAPE 3 : Vérifie la popularité sur les pages de détail ---
    console.log(`\n🔍 ÉTAPE 3 — Vérification de la popularité (${toCheck.length} hashtags)...`);
    const results = [];

    for (const tag of toCheck) {
      process.stdout.write(`   🔎 #${tag} ... `);
      const { views, posts } = await getHashtagDetails(page, tag);

      const isPopular = views >= MIN_VIEWS || posts >= 10_000;

      console.log(
        views > 0
          ? `${(views / 1_000_000).toFixed(1)}M vues, ${posts.toLocaleString()} posts → ${isPopular ? '✅ PERTINENT' : '⛔ ignoré (trop petit)'}`
          : 'données indisponibles → ⚠️ gardé par défaut'
      );

      if (isPopular || views === 0) {
        results.push({
          tag,
          views: views > 0 ? views : null,
          posts: posts > 0 ? posts : null,
          category: getCategory(tag),
          isPopular: views > 0 ? isPopular : null,
        });
      }
    }

    console.log(`\n📦 ${results.length} trends collégiens pertinents trouvés.`);

    // Tri : d'abord les plus vus
    results.sort((a, b) => (b.views || 0) - (a.views || 0));

    const output = {
      lastUpdate: new Date().toISOString(),
      source: 'tiktokhashtags.com',
      filteredForCollege: true,
      minViewsThreshold: MIN_VIEWS,
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

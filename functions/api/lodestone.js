/**
 * Cloudflare Pages Function: GET /api/lodestone?id=<character id>&region=<na|jp|eu|fr|de>&portrait=1
 *
 * Browsers cannot read Lodestone pages directly (no CORS headers), so the card maker asks this
 * same-origin endpoint instead. It fetches the public character page once, pulls out the few
 * fields the card uses, and caches the result for an hour so repeat clicks do not hit Lodestone.
 * It only runs when a visitor presses "load", and only reads the public profile page.
 */
const REGIONS = ['na', 'jp', 'eu', 'fr', 'de'];
const TTL = 3600;

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': status === 200 ? `public, max-age=${TTL}` : 'no-store'},
});

const decode = s => s
  .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
  .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
  .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
  .trim();

const pick = (html, re) => { const m = html.match(re); return m ? decode(m[1]) : ''; };

function parseCharacter(html) {
  const name = pick(html, /class="frame__chara__name"[^>]*>([^<]+)</);
  const title = pick(html, /class="frame__chara__title"[^>]*>([^<]+)</);
  // "Asura [Mana]" — the home-world icon sits in front of the text
  const worldRaw = pick(html, /class="frame__chara__world"[^>]*>(?:\s*<i[^>]*>\s*<\/i>)?\s*([^<]+)</);
  const wm = worldRaw.match(/^(.+?)\s*[\[(（](.+?)[\])）]\s*$/);
  const world = wm ? wm[1].trim() : worldRaw, dc = wm ? wm[2].trim() : '';
  // first character block is Race/Clan/Gender: "Miqo'te<br />Seeker of the Sun / ♀"
  let race = '', clan = '', gender = '';
  const rb = html.match(/class="character-block__name"[^>]*>([^<]*)<br\s*\/?>([^<]*)</);
  if (rb) {
    race = decode(rb[1]);
    const rest = decode(rb[2]).split('/').map(x => x.trim());
    clan = rest[0] || '';
    gender = (rest[1] || '').includes('♀') ? '♀' : (rest[1] || '').includes('♂') ? '♂' : '';
  }
  const portrait = pick(html, /class="character__detail__image"[^>]*>\s*<a[^>]*href="([^"]+)"/) ||
                   pick(html, /class="character__detail__image"[\s\S]*?<img[^>]*src="([^"]+)"/);
  // level list: <li><img ... data-tooltip="Paladin / Gladiator" ...>100</li>
  const jobs = [];
  const re = /<li[^>]*>\s*<img([^>]*)>\s*([0-9]+|-)\s*<\/li>/g;
  let m;
  while ((m = re.exec(html))) {
    const tip = (m[1].match(/data-tooltip="([^"]+)"/) || [])[1];
    if (tip) jobs.push({name:decode(tip), level:m[2] === '-' ? 0 : +m[2]});
  }
  return {name, title, world, dc, race, clan, gender, portrait, jobs};
}

function toBase64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export async function onRequestGet({request}) {
  const url = new URL(request.url);
  const id = (url.searchParams.get('id') || '').trim();
  if (!/^\d{1,12}$/.test(id)) return json({error:'bad_id'}, 400);
  const region = REGIONS.includes(url.searchParams.get('region')) ? url.searchParams.get('region') : 'na';
  const wantPortrait = url.searchParams.get('portrait') === '1';

  const cache = caches.default;
  const key = new Request(`https://lodestone-cache.invalid/${region}/${id}/${wantPortrait ? 'p' : 'n'}`);
  const hit = await cache.match(key);
  if (hit) return hit;

  let res;
  try {
    res = await fetch(`https://${region}.finalfantasyxiv.com/lodestone/character/${id}/`, {
      headers: {'User-Agent': 'Mozilla/5.0 (compatible; WoL-card-maker/1.0; fan tool)', 'Accept': 'text/html'},
      cf: {cacheTtl: TTL, cacheEverything: true},
    });
  } catch (e) { return json({error:'upstream'}, 502); }
  if (res.status === 404) return json({error:'not_found'}, 404);
  if (!res.ok) return json({error:'upstream', status:res.status}, 502);

  const data = parseCharacter(await res.text());
  if (!data.name) return json({error:'private_or_changed'}, 422);   // profile hidden, or Lodestone markup changed

  if (wantPortrait && /^https:\/\/img2?\.finalfantasyxiv\.com\//.test(data.portrait)) {
    try {
      const im = await fetch(data.portrait);
      if (im.ok) data.portraitData = `data:${im.headers.get('content-type') || 'image/jpeg'};base64,${toBase64(await im.arrayBuffer())}`;
    } catch (e) { /* the rest of the profile is still useful */ }
  }

  const out = json({ok:true, id, region, ...data});
  await cache.put(key, out.clone());
  return out;
}

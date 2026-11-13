// scout.mjs — find the clipping campaigns worth joining, every day.
//
//   node scout.mjs
//
// Source: ClippingAlpha's MCP server, whose terms explicitly let AI agents
// connect to it. It tracks Vyro, Whop Content Rewards and others in one
// place. We do NOT read Vyro or Whop directly: both forbid scraping.
//
// For every open campaign it reads the brief and the footage list, then:
//   1. rejects what our pipeline must not or cannot do (briefs that ban AI or
//      repurposing tools, demand a dedicated page per brand, or only offer
//      YouTube footage, which the cloud cannot download), and what put our
//      accounts at risk (ACCOUNT_RISKS: learnt from CONCESSIONS, Nov 2026,
//      where every YouTube and Instagram post sat at 0 views: identical
//      pre-cut files every clipper posts, a burned-in "now available on"
//      banner, #ad + "link in bio" captions, 50% US audience);
//   2. scores the rest (ClippingAlpha's Alpha Score, plus our own fit:
//      downloadable footage, all three platforms, low payout threshold, days
//      of budget left);
//   3. assigns each to one of our accounts by topic;
//   4. writes docs/scout.html (the phone page) and a ready draft config per
//      pick in campaigns/_proposed-*.json (ignored until enabled).
// Joining stays with the person: it is their account.

import { readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';

const ROOT = import.meta.dirname;
const MCP = 'https://clippingalpha.com/mcp';
const OUR = ['tiktok', 'instagram', 'youtube'];
const log = (...a) => console.log('·', ...a);

// ── MCP client (streamable HTTP, JSON-RPC) ────────────────────

let sid = null, rid = 0;
async function rpc(method, params, notify = false) {
  const body = notify ? { jsonrpc: '2.0', method, params } : { jsonrpc: '2.0', id: ++rid, method, params };
  const r = await fetch(MCP, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...(sid ? { 'mcp-session-id': sid } : {}) },
    body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
  });
  sid = r.headers.get('mcp-session-id') || sid;
  const t = await r.text();
  if (notify) return null;
  const lines = t.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim()).filter(Boolean);
  const msg = JSON.parse(lines.length ? lines[lines.length - 1] : t);
  if (msg.error) throw new Error(`${method}: ${msg.error.message}`);
  return msg.result;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// Polite pacing: one request every ~2.5s, and a long pause if the server says slow down.
async function tool(name, args) {
  let r;
  for (let attempt = 0; ; attempt++) {
    await sleep(2500);
    r = await rpc('tools/call', { name, arguments: args });
    const msg = r.isError ? (r.content || []).map((x) => x.text).join(' ') : '';
    if (/too many requests|slow down/i.test(msg) && attempt < 3) { await sleep(30000 * (attempt + 1)); continue; }
    break;
  }
  if (r.isError) throw new Error(`${name}: ${(r.content || []).map((x) => x.text).join(' ').slice(0, 300)}`);
  return r.structuredContent || {};
}

// ── judging a campaign ────────────────────────────────────────

// Rules our automated pipeline cannot honestly follow.
const DEALBREAKERS = [
  [/\b(no|not?|don'?t|never)\b[^.]{0,40}\b(ai|a\.i\.)\b[^.]{0,30}\b(clip|edit|generat|tool)/i, 'bans AI clipping/editing tools'],
  [/\bai[- ]generated (visuals|clips|content|edits)\b/i, 'bans AI-generated content'],
  [/\brepurpos(ing|e) tools?\b/i, 'bans repurposing tools'],
  [/\b(dedicated|separate) (page|account)\b|\bpage name must\b|\bkeep (the )?account dedicated\b/i, 'needs a dedicated page for this brand'],
  [/\bprofile picture\b/i, 'needs the brand as profile picture'],
  [/\bfollow the example (edit|style)\b|\bmatch the style of the reference\b|\bdon'?t stray from the example style\b/i, 'requires copying a specific edit style'],
  [/\bface ?cam|on[- ]camera|your (own )?face\b/i, 'needs you on camera'],
];

// Briefs that make our posts look like everyone else's ads. The CONCESSIONS
// campaign (Nov 2026) had all of these and got 0 views on YouTube and
// Instagram; both platforms hold back near-identical re-uploads.
const ACCOUNT_RISKS = [
  // Any "this is an ad" wording in the caption or on screen. Branded partner
  // tags (#TheDropPartner) and the platforms' own paid-promotion switches are
  // fine: The Drop runs with both on TikTok.
  [/(^|[^\w])#(ad|ads|advert|advertisement|sponsored|spon|paidad|paidpartnership|paid)\b/i, 'requires #ad-style tag in captions'],
  [/\b(label|mark|disclose|flag)\w*\b[^.]{0,40}\bas (an? )?(ad|advert|advertisement|sponsored)\b/i, 'requires labelling posts as an ad'],
  [/(["'\u201c]|\bwith\s+)(ad|sponsored)\s*[:|]/i, 'requires an "Ad:" caption prefix'],
  [/\b(logo|watermark|banner|end ?card|lower third|cta)\b[^.]{0,40}\b(on[- ]screen|in the video|visible|keep|must stay|burned)\b|\bkeep (the )?(brand )?(logo|banner|watermark)\b/i, 'brand logo/banner must stay on screen'],
  [/\blink in (your |their |its |the )?bio\b|\b(campaign |brand )?link in (your )?(bio|profile)\b/i, 'caption must push a link in bio'],
  [/\b(use|post) (the )?(approved |official )?(clips?|footage|videos?) as (provided|supplied|is)\b|\bdo not alter\b|\bno (cropping|trimming|cutting|edits)\b/i, 'clips must be posted as supplied (same file as every other clipper)'],
  [/\b([5-9]\d)\s?%[^.]{0,30}\b(us|usa|u\.s\.|united states|american)\b|\b(us|usa|united states)\b[^.]{0,25}\b([5-9]\d)\s?%/i, 'needs 50%+ US audience (a UK account rarely clears it)'],
];
const MAX_MIN_VIEWS = 1500;   // our posts get ~700 (TikTok) to ~1,100 (YouTube)

const ACCOUNTS = [
  ['The Deal Room', /\b(financ|trading|trader|invest|money|business|startup|founder|ceo|shark tank|crypto|stock|real estate|entrepreneur|fintech|sales)\b/i],
  ['Off Mic', /\b(podcast|pod\b|interview|talk ?show|conversation|q&a|ama)\b/i],
  ['ReplayRoom', /./],   // film & TV; anything else that lands here is flagged off-topic below
];

function sourceKind(url = '') {
  if (/youtube\.com|youtu\.be/i.test(url)) return 'youtube';
  if (/f\.io|frame\.io/i.test(url)) return 'frameio';
  if (/drive\.google\.com/i.test(url)) return 'drive';
  if (/dropbox\.com/i.test(url)) return 'dropbox';
  if (/\.(mp4|mov|m4v)(\?|$)/i.test(url)) return 'file';
  return 'other';
}
const DOWNLOADABLE = new Set(['frameio', 'drive', 'dropbox', 'file']);

export function judge(c, brief, assets) {
  const why = [], reject = [];
  const lines = [
    ...(brief.checklist || []).map((x) => x.text),
    ...Object.values(brief.wants || {}).flat().filter((x) => typeof x === 'string'),
    ...(Array.isArray(brief.rules) ? brief.rules.map((x) => (typeof x === 'string' ? x : x?.text || '')) : []),
  ].filter(Boolean);
  const text = lines.join('. ');
  for (const [re, label] of DEALBREAKERS) if (re.test(text)) reject.push(label);
  for (const [re, label] of ACCOUNT_RISKS) if (re.test(text)) reject.push(label);

  const urls = [
    ...(assets.videos || []).map((v) => v.url || v.sourceUrl),
    ...(assets.brandAssets || []).map((v) => v.url),
    assets.library?.url,
  ].filter(Boolean);
  const kinds = [...new Set(urls.map(sourceKind))];
  const downloadable = urls.filter((u) => DOWNLOADABLE.has(sourceKind(u)));
  let footage;
  if (downloadable.length) { footage = 'downloadable'; why.push(`footage on ${[...new Set(downloadable.map(sourceKind))].join('/')}`); }
  else if (kinds.length && kinds.every((k) => k === 'youtube')) { footage = 'youtube'; reject.push('footage is YouTube only (cloud can\'t download it)'); }
  else { footage = 'after-join'; why.push('footage shown after joining'); }

  const plats = (c.platforms || []).filter((p) => OUR.includes(p));
  if (plats.length < 2) reject.push(`only ${plats.join('/') || 'other'} platforms`);
  const payoutLine = (brief.checklist || []).find((x) => x.kind === 'payout')?.text || '';
  const minViews = Number((payoutLine.match(/([\d,]+)\s*views/) || [])[1]?.replace(/,/g, '')) || null;
  const days = c.drainP50 ? (Date.parse(c.drainP50) - Date.now()) / 864e5 : null;
  if (days !== null && days < 3) reject.push('budget forecast to run out within 3 days');
  if ((c.budgetLeftUsd || 0) < 300) reject.push('under $300 of budget left');
  if (c.region && !/global|uk|gb|united kingdom|worldwide/i.test(c.region)) why.push(`audience: ${c.region}`);
  if (c.region && /^\s*(us|usa|united states)( only)?\s*$/i.test(c.region)) reject.push('US-only audience');
  if (minViews && minViews > MAX_MIN_VIEWS) reject.push(`pays only from ${minViews.toLocaleString('en-GB')} views (ours get ~700-1,100)`);
  const longForm = /\b(podcast|episode|stream|vod|full (video|interview)|long[- ]form|your own moments|find (the )?best moments)\b/i.test(`${c.title} ${text}`);
  const preCut = /\b(pre-?cut|ready-?made|provided|supplied) (clips|edits|videos)\b/i.test(text);

  let score = c.alphaScore || 0;
  if (footage === 'downloadable') score += 15; else if (footage === 'after-join') score -= 5;
  if (plats.length === 3) score += 5;
  if (minViews && minViews <= 3000) { score += 5; why.push(`pays from ${minViews.toLocaleString('en-GB')} views`); }
  if (days !== null && days < 7) score -= 10;
  if (longForm) { score += 10; why.push('long-form source: our clips are our own picks'); }
  if (preCut) { score -= 15; why.push('pre-cut clips: everyone posts the same files'); }
  const topic = `${c.title} ${c.brand} ${c.niche || ''} ${text.slice(0, 400)}`;
  const account = ACCOUNTS.find(([, re]) => re.test(topic))[0];
  const filmTv = c.niche === 'film-and-tv' || /\b(film|movie|tv|series|episode|season|trailer|netflix|hulu|prime video|hbo|apple tv|disney|paramount|peacock)\b/i.test(topic);
  if (account === 'ReplayRoom' && !filmTv) reject.push('not film/TV (ReplayRoom is a film & TV page)');

  const tags = [...new Set((text.match(/[#@][A-Za-z0-9_.]{2,40}/g) || []).map((t) => t.replace(/[.]$/, '')))];
  const disclosure = (brief.checklist || []).filter((x) => x.kind === 'disclosure').map((x) => x.text);
  return {
    ref: brief.campaign?.ref, title: c.title, brand: c.brand, board: c.board, rate: c.ratePer1kUsd,
    budgetLeft: Math.round(c.budgetLeftUsd || 0), alpha: c.alphaScore, tier: c.tier, platforms: plats,
    days: days === null ? null : Math.round(days), minViews, footage, sources: downloadable, account,
    score, why, reject, tags, disclosure, rules: lines.slice(0, 30), joinUrl: c.joinUrl, pageUrl: c.pageUrl,
  };
}

// ── draft campaign config for a pick ─────────────────────────

function draftConfig(p) {
  const id = p.ref.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  return [id, {
    name: `${p.brand} (${p.board})`,
    type: 'creator', enabled: false, account: p.account,
    _scout: `Proposed by the scout on ${new Date().toISOString().slice(0, 10)}. Alpha ${p.alpha}, $${p.rate}/1K, $${p.budgetLeft} left, ~${p.days ?? '?'} days. Join first: ${p.joinUrl}`,
    _rules: p.rules,
    sources: p.sources,
    platforms: p.platforms, perDay: 2, minSeconds: 20, maxSeconds: 45, layout: 'blurfill', zoom: 1.3,
    credit: '', quoteHooks: false, hooks: [], captionLines: [],
    hashtags: p.tags.filter((t) => t.startsWith('#')),
    mentions: p.tags.filter((t) => t.startsWith('@')),
    endsOn: p.days !== null ? new Date(Date.now() + p.days * 864e5).toISOString().slice(0, 10) : null,
    postingNotes: [...p.disclosure, p.minViews ? `Payout from ${p.minViews} views` : ''].filter(Boolean).join(' · '),
  }];
}

// ── page ──────────────────────────────────────────────────────

function page(report) {
  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const card = (p) => `
  <article>
    <div class="top"><span class="acct">${esc(p.account)}</span><span class="score">${p.score}</span></div>
    <h3>${esc(p.title)}</h3>
    <p class="meta">${esc(p.board)} · $${esc(p.rate)}/1K · $${esc(p.budgetLeft.toLocaleString('en-GB'))} left${p.days !== null ? ` · ~${p.days} days` : ''} · ${esc(p.platforms.join(', '))}</p>
    ${p.why.length ? `<p class="why">✓ ${p.why.map(esc).join(' · ')}</p>` : ''}
    ${p.disclosure.length || p.tags.length ? `<p class="rules"><b>Must include:</b> ${esc([...p.disclosure, ...p.tags].join(' · '))}</p>` : ''}
    <a class="btn" href="${esc(p.joinUrl)}">Open &amp; join</a>
  </article>`;
  const groups = ['ReplayRoom', 'Off Mic', 'The Deal Room'].map((a) => {
    const ps = report.picks.filter((p) => p.account === a);
    return `<section><h2>${esc(a)}</h2>${ps.length ? ps.map(card).join('') : '<p class="muted">Nothing that fits today.</p>'}</section>`;
  }).join('');
  const rejected = report.rejected.slice(0, 25).map((p) => `<li><b>${esc(p.title)}</b> · ${esc(p.reject.join('; '))}</li>`).join('');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Campaign scout</title>
<style>
:root{--bg:#f1f1f4;--card:#fff;--ink:#16161d;--muted:#5d5d6b;--line:#dcdce4;--acc:#5b4bdb;--go:#1c7f55}
@media (prefers-color-scheme:dark){:root{--bg:#0d0d12;--card:#17171f;--ink:#ececf2;--muted:#9d9daf;--line:#2a2a36;--acc:#8f84ff;--go:#3cc48a}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,system-ui,sans-serif;padding:20px 16px 60px}
main{max-width:600px;margin:auto}h1{margin:.1em 0;font-size:26px}h2{font-size:15px;color:var(--muted);margin:24px 0 6px;text-transform:uppercase;letter-spacing:.06em}
article{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin:10px 0}
h3{margin:4px 0;font-size:18px}.meta,.muted,small{color:var(--muted);font-size:14px;margin:2px 0}
.top{display:flex;justify-content:space-between;align-items:center}.acct{font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--acc)}
.score{font-weight:800;font-variant-numeric:tabular-nums;color:var(--go)}.why{color:var(--go);font-size:14px;margin:6px 0}.rules{font-size:14px;margin:6px 0}
.btn{display:inline-block;background:var(--acc);color:#fff;text-decoration:none;border-radius:9px;padding:9px 14px;font-weight:700;margin-top:4px}
details{margin-top:24px}li{font-size:14px;margin:4px 0;color:var(--muted)}
</style><main>
<h1>Campaign scout</h1>
<p class="muted">${esc(report.at.slice(0, 16).replace('T', ' '))} UTC · checked ${report.checked} of ${report.total} live campaigns via ClippingAlpha. Join a pick, then tell Claude "joined" with the brief so the clips start.</p>
${groups}
<details><summary>Rejected and why (${report.rejected.length})</summary><ul>${rejected}</ul></details>
</main>`;
}

// ── run ───────────────────────────────────────────────────────

async function main() {
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'replayroom-scout', version: '1' } });
  await rpc('notifications/initialized', {}, true);
  // Two views (25 max each): the best-scored now, and anything launched in the
  // last 3 days, since the first 48 hours of a campaign hold the most budget.
  const best = await tool('search_campaigns', { type: 'clipping', open_join_only: true, limit: 25 });
  const fresh = await tool('search_campaigns', { type: 'clipping', open_join_only: true, limit: 25, new_within_hours: 72 }).catch(() => ({ campaigns: [] }));
  // ReplayRoom is a film & TV page: the general lists rarely surface those, so
  // search the niche directly too (newest first: early posts get the budget).
  const film = await tool('search_campaigns', { type: 'clipping', niche: 'film-and-tv', platforms: ['youtube', 'instagram'], open_join_only: true, limit: 25, sort: 'newest' }).catch(() => ({ campaigns: [] }));
  const seen = new Set();
  const found = { total: best.total, campaigns: [...(film.campaigns || []), ...(fresh.campaigns || []), ...(best.campaigns || [])].filter((c) => !seen.has(c.campaignId) && seen.add(c.campaignId)) };
  const camps = (found.campaigns || []).filter((c) => c.state === 'live' && !c.membersOnly && (c.platforms || []).some((p) => OUR.includes(p)));
  log(`${found.total} live, ${camps.length} candidates`);

  const judged = [];
  for (const c of camps.slice(0, Number(process.env.SCOUT_DEPTH || 30))) {
    const ref = `${c.brandSlug}/${c.seriesSlug}`;
    try {
      const [brief, assets] = [await tool('get_brief', { campaign: ref }), await tool('get_assets', { campaign: ref })];
      brief.campaign ||= { ref };
      brief.campaign.ref ||= ref;
      judged.push(judge(c, brief, assets));
    } catch (e) { log(`skip ${ref}: ${e.message}`); }
  }
  const ok = judged.filter((p) => !p.reject.length).sort((a, b) => b.score - a.score);
  const picks = ['ReplayRoom', 'Off Mic', 'The Deal Room'].flatMap((a) => ok.filter((p) => p.account === a).slice(0, 3));
  const rejected = judged.filter((p) => p.reject.length);
  const report = { at: new Date().toISOString(), total: found.total, checked: judged.length, picks, rejected };

  mkdirSync(path.join(ROOT, 'scout'), { recursive: true });
  writeFileSync(path.join(ROOT, 'scout', 'report.json'), JSON.stringify(report, null, 2));
  writeFileSync(path.join(ROOT, 'docs', 'scout.html'), page(report));
  for (const f of readdirSync(path.join(ROOT, 'campaigns'))) if (f.startsWith('_proposed-')) rmSync(path.join(ROOT, 'campaigns', f));
  for (const p of picks) {
    const [id, cfg] = draftConfig(p);
    writeFileSync(path.join(ROOT, 'campaigns', `_proposed-${id}.json`), JSON.stringify(cfg, null, 2) + '\n');
  }
  log(`${picks.length} picks, ${rejected.length} rejected`);
  for (const p of picks) log(`  ${p.account} · ${p.title} · score ${p.score} · ${p.footage}`);
}

if (process.argv[1] === import.meta.filename) main().catch((e) => { console.error('scout failed:', e.message); process.exit(1); });

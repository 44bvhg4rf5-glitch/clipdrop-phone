// clipfarm-cloud.mjs — the daily Vyro clip drop, made entirely in the cloud.
//
//   node clipfarm-cloud.mjs            fetch campaign footage, make today's clips
//   node clipfarm-cloud.mjs --publish  after upload: record them, rebuild the page
//
// Each campaign lives in campaigns/<name>.json. Supported type:
//
//   bank  The campaign supplies finished edits (a Frame.io link) that must be
//         posted whole — no cropping, trimming or audio changes. We only add a
//         border and an on-screen hook, which such briefs explicitly allow, and
//         never post the same edit twice.
//
// Posting and submitting links to Vyro stay manual: TikTok keeps posts from
// unaudited apps private, and Vyro has no submission API. Everything up to
// that point is automatic. Nothing here costs money.

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fetchSources, findMoments, hooksFor, renderMoment } from './clipfarm/creator.mjs';

const run = promisify(execFile);
const BIG = { maxBuffer: 64 * 1024 * 1024 };
const ROOT = import.meta.dirname;
const CAMPAIGNS = path.join(ROOT, 'campaigns');
const STATE = path.join(CAMPAIGNS, 'state.json');
const CACHE = path.join(ROOT, '.cache', 'banks');
const OUT = path.join(ROOT, 'out', 'clips');
const DOCS = path.join(ROOT, 'docs');
const FONT = process.env.CLIP_FONT || '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

const log = (...a) => console.log('·', ...a);
const warn = (...a) => console.warn('!', ...a);
const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(v, null, 2) + '\n'); };
const today = () => new Date().toISOString().slice(0, 10);
const slugify = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50);

const state = readJson(STATE, { used: {}, drops: [], status: null });
function setStatus(level, text) {
  state.status = { level, text, at: new Date().toISOString() };
  writeJson(STATE, state);
  (level === 'error' ? warn : log)(text);
}

function campaigns() {
  if (!existsSync(CAMPAIGNS)) return [];
  return readdirSync(CAMPAIGNS).filter((f) => f.endsWith('.json') && f !== 'state.json' && !f.startsWith('_'))
    .map((f) => ({ id: f.replace(/\.json$/, ''), ...readJson(path.join(CAMPAIGNS, f), {}) }))
    .filter((c) => c.enabled !== false);
}

// ── footage: download a Frame.io share's files ────────────────

async function browser() {
  let pw;
  try { pw = await import('playwright'); } catch { pw = await import('/opt/node22/lib/node_modules/playwright/index.mjs'); }
  const exe = process.env.CHROMIUM_PATH || (existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined);
  return pw.chromium.launch({ executablePath: exe });
}

/** Presses the share page's own "Download All" — the same thing a person would
 *  click — and saves each file it hands over. Returns the local files. */
async function fetchFrameIo(url, dir) {
  mkdirSync(dir, { recursive: true });
  const b = await browser();
  const saved = [];
  try {
    // An ordinary desktop Chrome identity: some share pages serve a stripped
    // page to anything announcing itself as headless.
    const ctx = await b.newContext({
      acceptDownloads: true, viewport: { width: 1280, height: 900 }, locale: 'en-GB',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
    });
    const p = await ctx.newPage();
    await p.goto(url, { waitUntil: 'networkidle', timeout: 90000 });
    // A folder share has "Download All"; a single-file share has "Download".
    await p.getByText(/^Download( All)?$/).first().waitFor({ timeout: 45000 }).catch(() => {});
    for (const name of ['Accept all', 'Accept', 'I agree', 'Got it']) {
      await p.getByRole('button', { name, exact: true }).first().click({ timeout: 1500 }).catch(() => {});
    }
    const body = await p.innerText('body');
    const single = !/Download All/.test(body);
    const expected = single ? 1 : Number((body.match(/(\d+)\s+Assets/) || [])[1]) || 0;
    const pending = [];
    p.on('download', (d) => pending.push((async () => {
      const name = d.suggestedFilename().replace(/[^\w .()-]/g, '_');
      const f = path.join(dir, name);
      await d.saveAs(f);
      saved.push(f);
      log(`  got ${name}`);
    })()));
    if (single) {
      await p.getByText('Download', { exact: true }).first().click({ timeout: 30000 });
      // The button opens a size menu: "Original" is only a heading, and the
      // first resolution line under it (e.g. "1920×1080") is the original file.
      const original = p.locator('[data-testid="Download original file"]');
      if (await original.count()) await original.first().click({ timeout: 8000 });
      else await p.getByRole('menuitem').first().click({ timeout: 8000 }).catch(() => {});
      await p.getByText('Download in Browser', { exact: true }).first().click({ timeout: 5000 }).catch(() => {});
    } else {
      await p.getByText('Download All').first().click({ timeout: 30000 });
    }
    // Frame.io asks one of two questions depending on the machine: "Continue
    // with download?" or "Download with the Desktop App / … in Browser".
    await p.getByText('Download in Browser', { exact: true }).first().click({ timeout: 8000 }).catch(() => {});
    await p.getByRole('button', { name: 'Continue' }).click({ timeout: 8000 }).catch(() => {});
    // Wait until every expected file has started and finished, or nothing new for 2 min.
    let last = -1, still = 0;
    while (still < (single ? 240 : 24) && (!expected || saved.length < expected)) {
      await p.waitForTimeout(5000);
      if (pending.length === last) still++; else { still = 0; last = pending.length; }
    }
    await Promise.allSettled(pending);
    log(`downloaded ${saved.length}${expected ? ` of ${expected}` : ''} file(s)`);
    if (!saved.length) {
      // Leave evidence for diagnosis: what the page looked like and said.
      const dbg = path.join(ROOT, 'out', 'debug'); mkdirSync(dbg, { recursive: true });
      await p.screenshot({ path: path.join(dbg, 'share-page.png'), fullPage: true }).catch(() => {});
      writeFileSync(path.join(dbg, 'share-page.txt'), (await p.innerText('body').catch(() => '')).slice(0, 5000));
      throw new Error(`the share page gave no files (expected ${expected || 'some'}) — see the debug screenshot`);
    }
  } finally { await b.close(); }
  return saved.filter((f) => /\.(mp4|mov|m4v)$/i.test(f));
}

// ── render: border + hook, footage untouched ──────────────────

/** On-screen text can't show emoji with a normal font, so hooks lose them. */
const plain = (t) => t.replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '').replace(/\s+/g, ' ').trim();

function wrap(text, max = 22) {
  const words = text.split(' '), lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > max && cur) { lines.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3);
}

/**
 * 1080x1920. The edit is scaled to fit (never cropped) inside the lower
 * 1080x1620, the hook sits in the 300px band above it, and the audio stream is
 * copied bit for bit — the brief forbids altering it.
 */
async function frameClip(input, hook, out, work) {
  const band = 300, area = 1920 - band;
  const lines = wrap(plain(hook));
  const size = lines.length > 2 ? 54 : 62;
  const gap = size + 14;
  // Sit the hook just above the picture: a wide edit leaves a tall gap, and a
  // hook stranded at the very top reads as unrelated to the video.
  const { w, h } = await dims(input);
  const shown = w && h ? Math.min(area, Math.round(1080 * h / w)) : area;
  const videoTop = band + Math.round((area - shown) / 2);
  const top = Math.max(40, videoTop - 36 - lines.length * gap);
  const draws = lines.map((l, i) => {
    const f = path.join(work, `hook${i}.txt`);
    writeFileSync(f, l);
    return `drawtext=fontfile=${FONT}:expansion=none:textfile=${f}:fontsize=${size}:fontcolor=white:borderw=3:bordercolor=black@0.6:x=(w-text_w)/2:y=${top + i * gap}`;
  });
  const vf = [
    `scale=1080:${area}:force_original_aspect_ratio=decrease:flags=lanczos`,
    `pad=1080:1920:(ow-iw)/2:${band}+(${area}-ih)/2:color=0x0b0b0f`,
    'setsar=1',
    ...draws,
  ].join(',');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', input,
    '-vf', vf, '-c:v', 'libx264', '-preset', 'medium', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-c:a', 'copy', '-movflags', '+faststart', '-y', out], BIG);
  return out;
}

async function dims(f) {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', f]);
    const [w, h] = stdout.trim().split(',').map(Number);
    return { w, h };
  } catch { return {}; }
}

async function duration(f) {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', f]);
    return Number(stdout.trim()) || 0;
  } catch { return 0; }
}

// ── one day's drop ────────────────────────────────────────────

async function makeDrop() {
  const live = campaigns().filter((c) => !c.endsOn || c.endsOn >= today());
  if (!live.length) return setStatus('ok', 'No live campaigns. Send Claude a new Vyro campaign to add.');
  if (state.drops.some((d) => d.date === today()) && process.env.CLIP_FORCE !== 'true') {
    return setStatus('ok', 'Today\'s clips are already made.');
  }

  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const items = [];
  let exhausted = 0;

  for (const c of live) {
    if (c.type === 'creator') {
      const got = await creatorDrop(c).catch((e) => { warn(`${c.name}: ${e.message}`); return []; });
      if (!got.length) exhausted++;
      items.push(...got);
      continue;
    }
    if (c.type !== 'bank') { warn(`${c.name}: type ${c.type} not supported yet`); continue; }
    const used = new Set(state.used[c.id] || []);
    log(`${c.name}: fetching the clip bank`);
    let files = [];
    try { files = await fetchFrameIo(c.source, path.join(CACHE, c.id)); }
    catch (e) { warn(`${c.name}: could not fetch footage — ${e.message}`); continue; }

    const fresh = files.map((f) => path.basename(f)).filter((n) => !used.has(n)).sort();
    if (!fresh.length) { warn(`${c.name}: every edit has been used`); exhausted++; continue; }
    const want = c.perDay || 3;
    let made = 0;
    const work = path.join(ROOT, '.produce', 'clips', c.id);
    mkdirSync(work, { recursive: true });

    for (const [i, name] of fresh.entries()) {
      if (made >= want) break;
      const n = used.size + i;                            // rotate hooks/captions across the whole run
      const hook = c.hooks[n % c.hooks.length];
      const line = c.captionLines[n % c.captionLines.length];
      const src = path.join(CACHE, c.id, name);
      const secs = await duration(src);
      if (c.minSeconds && secs && secs < c.minSeconds) {
        // Can't be padded (the brief forbids altering the edit), so never usable.
        warn(`${name}: ${secs.toFixed(1)}s is under the ${c.minSeconds}s minimum — skipped for good`);
        (state.used[c.id] ||= []).push(name);
        continue;
      }
      const out = path.join(OUT, `${today()}-${c.id}-${slugify(name.replace(/\.\w+$/, ''))}.mp4`);
      try {
        log(`${c.name}: ${name} · "${plain(hook)}"`);
        await frameClip(src, hook, out, work);
        items.push({
          campaign: c.name, campaignId: c.id, source: name, file: path.basename(out),
          seconds: +secs.toFixed(1), hook: plain(hook),
          caption: `${line}\n\n${(c.hashtags || []).join(' ')}`.trim(),
          platforms: c.platforms || ['tiktok'], notes: c.postingNotes || '',
        });
        made++;
      } catch (e) { warn(`${name}: render failed — ${e.message}`); }
    }
  }

  if (!items.length) {
    return exhausted === live.length
      ? setStatus('ok', 'Every live campaign is used up. Send Claude a new campaign to add.')
      : setStatus('error', 'No clips could be made today — see the run log.');
  }
  writeJson(path.join(OUT, 'manifest.json'), { date: today(), tag: `clips-${today()}`, items });
  setStatus('ok', `${items.length} clip(s) made for ${today()}.`);
}

/**
 * A creator campaign: fetch its long videos, find the day's best unused
 * moments, and render one distinct edit per allowed platform for each.
 */
async function creatorDrop(c) {
  const ranges = state.ranges?.[c.id] || [];
  log(`${c.name}: fetching creator footage`);
  const videos = await fetchSources(c.sources || [], path.join(CACHE, c.id), { fetchFrameIo, log, warn });
  if (!videos.length) throw new Error('no usable source videos (YouTube-only campaigns need the Mac)');
  const want = c.perDay || 3;
  const per = [];
  for (const v of videos) {
    const name = path.basename(v);
    const used = ranges.filter((r) => r.src === name);
    log(`${c.name}: finding moments in ${name}`);
    const found = await findMoments(v, ROOT, { min: c.minSeconds || 20, max: c.maxSeconds || 45, want, used });
    per.push(...found.map((m) => ({ ...m, video: v, src: name })));
  }
  const best = per.sort((a, b) => b.score - a.score).slice(0, want);
  const platforms = (c.platforms || ['tiktok']).filter((p) => ['tiktok', 'instagram', 'youtube'].includes(p));
  const work = path.join(ROOT, '.produce', 'clips', c.id);
  const items = [];
  for (const [k, m] of best.entries()) {
    const hooks = hooksFor(m, c.hooks || []);
    const momentId = `${slugify(m.src.replace(/\.\w+$/, ''))}-${Math.round(m.s)}`;
    const captionBase = (c.captionLines?.length ? c.captionLines[(ranges.length + k) % c.captionLines.length] : hooks[0].replace(/"/g, ''));
    for (const [pi, platform] of platforms.entries()) {
      const out = path.join(OUT, `${today()}-${c.id}-${momentId}-${platform}.mp4`);
      try {
        log(`${c.name}: ${m.src} @${m.s.toFixed(0)}s → ${platform} · ${hooks[pi % hooks.length]}`);
        await renderMoment({ video: m.video, moment: m, hook: hooks[pi % hooks.length], platform, out, work, font: FONT, layout: c.layout || 'blurfill', credit: c.credit || '' });
        items.push({
          kind: 'creator', campaign: c.name, campaignId: c.id, source: m.src, moment: momentId,
          range: { src: m.src, s: m.s, e: m.e }, file: path.basename(out),
          seconds: +(m.e - m.s).toFixed(1), hook: hooks[pi % hooks.length],
          caption: `${captionBase}${c.credit ? ' ' + c.credit : ''}\n\n${(c.hashtags || []).join(' ')}`.trim(),
          platforms: [platform], notes: c.postingNotes || '',
        });
      } catch (e) { warn(`${momentId} ${platform}: render failed — ${e.message.split('\n')[0]}`); }
    }
  }
  return items;
}

// ── the page on your phone ────────────────────────────────────

function page() {
  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
  const repo = process.env.GITHUB_REPOSITORY || '';
  const st = state.status;
  const days = [...state.drops].reverse().slice(0, 7).map((d, di) => `
  <h2>${esc(d.date)}${di === 0 ? ' · today' : ''}</h2>
  ${d.items.map((it) => {
    const url = `https://github.com/${repo}/releases/download/${d.tag}/${it.file}`;
    return `<article data-id="${esc(it.file)}">
    <div class="top"><b>${esc(it.campaign)}</b> <small>${esc(it.platforms.join(', '))} · ${esc(it.seconds)}s</small></div>
    ${di === 0 ? `<video src="${esc(url)}" controls playsinline preload="metadata"></video>` : ''}
    <a class="btn" href="${esc(url)}">Download</a>
    <textarea readonly rows="3">${esc(it.caption)}</textarea>
    <button onclick="cp(this)">Copy caption</button>
    <label class="done"><input type="checkbox" onchange="mark(this)"> Posted &amp; submitted in Vyro</label>
    ${it.notes ? `<p class="note">${esc(it.notes)}</p>` : ''}
  </article>`;
  }).join('')}`).join('');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>ReplayRoom clips</title>
<style>
:root{--bg:#f1f1f4;--card:#fff;--ink:#16161d;--muted:#5d5d6b;--line:#dcdce4;--acc:#5b4bdb;--warn:#9a5b25}
@media (prefers-color-scheme:dark){:root{--bg:#0d0d12;--card:#17171f;--ink:#ececf2;--muted:#9d9daf;--line:#2a2a36;--acc:#8f84ff;--warn:#d7a45e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,system-ui,sans-serif;padding:20px 16px 60px}
main{max-width:560px;margin:auto}h1{margin:.1em 0 .3em;font-size:26px}h2{font-size:15px;color:var(--muted);margin:22px 0 4px;text-transform:uppercase;letter-spacing:.06em}
article,.status,.how{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin:12px 0}
article.posted{opacity:.5}.top{margin-bottom:6px}small,.muted{color:var(--muted);font-size:13px}
video{width:100%;border-radius:10px;background:#000;margin:4px 0 8px}
.btn,button{display:inline-block;background:var(--acc);color:#fff;text-decoration:none;border:0;border-radius:9px;padding:10px 14px;font:inherit;font-weight:700;margin:4px 0}
textarea{width:100%;font:inherit;font-size:14px;padding:10px;border-radius:9px;border:1px solid var(--line);background:var(--bg);color:var(--ink);margin-top:6px}
.done{display:flex;gap:8px;align-items:center;margin-top:8px;font-weight:600}.done input{width:22px;height:22px}
.note{color:var(--muted);font-size:13px;margin:8px 0 0}.status.error{border-color:var(--warn)}
ol{margin:6px 0 0;padding-left:1.2em}
</style><main>
<h1>ReplayRoom clips</h1>
${st ? `<section class="status ${esc(st.level)}"><b>Last run:</b> ${esc(st.text)}<br><span class="muted">${esc(st.at.slice(0, 16).replace('T', ' '))} UTC</span></section>` : ''}
<section class="how"><b>For each clip</b><ol>
<li>Download → post on the platforms shown, with the copied caption</li>
<li>Copy the post's link → Vyro → the campaign → submit</li>
<li>Tick "Posted &amp; submitted"</li></ol></section>
${days || '<p class="muted">No clips yet.</p>'}
</main>
<script>
function cp(b){const t=b.previousElementSibling;t.select();(navigator.clipboard?navigator.clipboard.writeText(t.value):Promise.reject()).catch(()=>document.execCommand('copy'));b.textContent='Copied ✓';setTimeout(()=>b.textContent='Copy caption',1500)}
function key(el){return 'posted:'+el.closest('article').dataset.id}
function mark(cb){try{localStorage.setItem(key(cb),cb.checked?'1':'')}catch{}cb.closest('article').classList.toggle('posted',cb.checked)}
document.querySelectorAll('.done input').forEach(cb=>{try{cb.checked=!!localStorage.getItem(key(cb))}catch{}cb.closest('article').classList.toggle('posted',cb.checked)});
</script>`;
}

function writePage() { mkdirSync(DOCS, { recursive: true }); writeFileSync(path.join(DOCS, 'clips.html'), page()); }

// ── entry ─────────────────────────────────────────────────────

async function main() {
  if (process.argv.includes('--publish')) {
    const m = readJson(path.join(OUT, 'manifest.json'), null);
    if (m) {
      state.drops = state.drops.filter((d) => d.date !== m.date);
      state.drops.push(m);
      for (const it of m.items) {
        if (it.kind === 'creator') {
          const r = (state.ranges ||= {})[it.campaignId] ||= [];
          if (!r.some((x) => x.src === it.range.src && x.s === it.range.s)) r.push(it.range);
        } else (state.used[it.campaignId] ||= []).includes(it.source) || state.used[it.campaignId].push(it.source);
      }
      state.drops = state.drops.slice(-30);
      setStatus('ok', `${m.items.length} clip(s) ready for ${m.date}.`);
    }
    writePage();
    return;
  }
  try { await makeDrop(); }
  catch (e) { setStatus('error', `Clip run failed: ${e.message}`); process.exitCode = 1; }
  finally { writePage(); }
}

main();

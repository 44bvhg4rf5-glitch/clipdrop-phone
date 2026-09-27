// koala-cloud.mjs — make one Pip & Willow episode in the cloud, inside a budget.
//
//   node koala-cloud.mjs             make tonight's episode (GitHub Actions runs this)
//   node koala-cloud.mjs --publish   after the videos are uploaded: record them, rebuild the page
//   node koala-cloud.mjs --status    print budget and queue position, spend nothing
//
// The chain, per shot: reference-matched still (fal: Seedream edit, using your
// approved pictures in koala/refs/) → 6s animation (fal: Hailuo 02) → ffmpeg
// stretches it gently to the shot length. Eight shots make a ~62s episode,
// long enough for TikTok's Creator Rewards (1 minute minimum). A ~23s cut-down
// is made from the same clips for free, to post on the days in between.
//
// Money can't run away. Four locks, from hardest to softest:
//   1. fal.ai is prepaid with auto top-up off: when the credit is gone, calls fail.
//   2. monthlyCapUsd: every paid call is written to koala/ledger.json BEFORE it is
//      made, and refused if it would take the month over the cap. An episode only
//      starts if the whole of it fits, so the money never buys half an episode.
//   3. One episode per run, retries capped per shot, and an episode that fails too
//      many shots is abandoned rather than retried night after night.
//   4. The KOALA_PAUSED repo variable, or disabling the workflow in the GitHub app.

import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, readdirSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { normalise, assemble } from './produce.mjs';

const run = promisify(execFile);
const BIG = { maxBuffer: 64 * 1024 * 1024 };
const ROOT = import.meta.dirname;
const K = (...p) => path.join(ROOT, 'koala', ...p);
const OUT = path.join(ROOT, 'out', 'koala');
const WORK = path.join(ROOT, '.produce', 'cloud');
const DOCS = path.join(ROOT, 'docs');

const log = (...a) => console.log('·', ...a);
const warn = (...a) => console.warn('!', ...a);
const readJson = (f, d) => { try { return JSON.parse(readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { mkdirSync(path.dirname(f), { recursive: true }); writeFileSync(f, JSON.stringify(v, null, 2) + '\n'); };
const slugify = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
const today = () => new Date().toISOString().slice(0, 10);
const month = () => new Date().toISOString().slice(0, 7);
const usd = (n) => `$${n.toFixed(2)}`;

const cfg = readJson(K('config.json'), {});
const bible = readJson(path.join(ROOT, 'characters.json'), {});
const book = readJson(K('episodes.json'), { episodes: [] });
const LEDGER = K('ledger.json');
const STATE = K('state.json');

const CAP = Number(process.env.KOALA_MONTHLY_CAP_USD || cfg.monthlyCapUsd || 48);
const PRICE = { still: cfg.prices?.still ?? 0.04, video: cfg.prices?.video ?? 0.27 };
const MOCK = process.env.FAL_MOCK === '1';

// ── ledger: the running total the cap is checked against ─────

const ledger = readJson(LEDGER, { months: {} });
const thisMonth = () => (ledger.months[month()] ||= { spent: 0, items: [] });
const spent = () => thisMonth().spent;
const remaining = () => Math.max(0, CAP - spent());

/** Record the cost first, then spend. A crash mid-call leaves the ledger
 *  over-stating spend, never under-stating it. */
function charge(amount, what) {
  if (spent() + amount > CAP + 1e-9) throw new BudgetError(`${what} would take this month past ${usd(CAP)} (spent ${usd(spent())})`);
  const m = thisMonth();
  m.spent = +(m.spent + amount).toFixed(4);
  m.items.push({ at: new Date().toISOString(), what, usd: amount });
  writeJson(LEDGER, ledger);
}
class BudgetError extends Error {}

// ── state: where we are in the episode list, and what's been published ──

const state = readJson(STATE, { next: 0, episodes: [], status: null, lastRunDate: null });
function setStatus(level, text) {
  state.status = { level, text, at: new Date().toISOString() };
  writeJson(STATE, state);
  (level === 'error' ? warn : log)(text);
}

// ── fal.ai queue API ──────────────────────────────────────────

async function fal(model, input, what, cost) {
  charge(cost, what);
  if (MOCK) return mockFal(model, what);

  const key = process.env.FAL_KEY;
  const headers = { Authorization: `Key ${key}`, 'content-type': 'application/json' };
  const sub = await fetch(`https://queue.fal.run/${model}`, { method: 'POST', headers, body: JSON.stringify(input) });
  if (!sub.ok) throw new Error(`${model} refused the job: ${sub.status} ${(await sub.text()).slice(0, 300)}`);
  const { status_url: statusUrl, response_url: responseUrl } = await sub.json();

  const deadline = Date.now() + 20 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 6000));
    const st = await fetch(statusUrl, { headers });
    if (!st.ok) continue;
    const { status } = await st.json();
    if (status === 'COMPLETED') break;
    if (!['IN_QUEUE', 'IN_PROGRESS'].includes(status)) throw new Error(`${model} status ${status}`);
  }
  const res = await fetch(responseUrl, { headers });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${model} failed: ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

async function mockFal(model, what) {
  // Offline rehearsal: same flow and ledger, fake media, no network, no cost.
  const dir = path.join(WORK, 'mock'); mkdirSync(dir, { recursive: true });
  const f = path.join(dir, slugify(what) + (model.includes('video') ? '.mp4' : '.png'));
  if (process.env.FAL_MOCK_FAIL && what.includes(process.env.FAL_MOCK_FAIL)) throw new Error('mock failure');
  if (model.includes('video')) {
    await run('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc=s=432x768:r=25', '-t', '6', '-y', f], BIG);
    return { video: { url: 'file://' + f } };
  }
  await run('ffmpeg', ['-loglevel', 'error', '-f', 'lavfi', '-i', 'color=c=0x8aa08a:s=720x1280', '-frames:v', '1', '-y', f], BIG);
  return { images: [{ url: 'file://' + f }] };
}

async function download(url, out) {
  if (url.startsWith('file://')) { writeFileSync(out, readFileSync(url.slice(7))); return out; }
  const r = await fetch(url);
  if (!r.ok) throw new Error(`download ${r.status}`);
  writeFileSync(out, Buffer.from(await r.arrayBuffer()));
  return out;
}

// ── prompts ───────────────────────────────────────────────────

const FRAMING = {
  wide: 'wide establishing shot, full bodies visible, lots of environment',
  medium: 'medium shot, waist up',
  close: 'close-up on the face, shallow depth of field',
  'two-shot': 'two-shot, both characters in frame, chest up',
};

function stillPrompt(shot) {
  const chars = bible.characters || [];
  const who = shot.cast === 'pip' ? chars.filter((c) => c.name === 'Pip')
    : shot.cast === 'willow' ? chars.filter((c) => c.name === 'Willow') : chars;
  const alone = who.length === 1 ? `Only ${who[0].name} is in this frame.` : 'Both characters are in this frame.';
  return [
    bible.style,
    'The reference images show the exact character designs. Keep them identical: fur colour, ear shape, markings, eye colour, nose, Pip\'s mustard scarf, Willow\'s pink bow, blossoms and heart patch. Pip is slightly taller than Willow. Pip wears the scarf; Willow never does.',
    ...who.map((c) => `${c.name.toUpperCase()}: ${c.prompt}`),
    alone,
    `WORLD: ${bible.world}`,
    `SHOT: ${FRAMING[shot.shot] || FRAMING.medium}. ${shot.scene}`,
    'Vertical 9:16 frame. No text, no watermark, no humans, no speech bubbles.',
  ].join('\n');
}

const motionPrompt = (shot) => `${shot.action.replace(/\.$/, '')}. Gentle, cute Pixar-style 3D animation, smooth natural movement, `
  + 'the characters keep exactly the same look as in the image, stable camera with a soft slow push-in.';

function refImages() {
  const dir = K('refs');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /\.(png|jpe?g|webp)$/i.test(f)).sort().slice(0, 4).map((f) => {
    const ext = f.split('.').pop().toLowerCase().replace('jpg', 'jpeg');
    return `data:image/${ext};base64,${readFileSync(path.join(dir, f)).toString('base64')}`;
  });
}

// ── one episode ───────────────────────────────────────────────

async function kenBurnsFrom(still, seconds, out) {
  const fps = 30, frames = Math.round(seconds * fps);
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-loop', '1', '-i', still,
    '-vf', `scale=2160:3840:force_original_aspect_ratio=increase,crop=2160:3840,zoompan=z='min(1.0+on/${frames}*0.1,1.1)':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1080x1920:fps=${fps},setsar=1`,
    '-t', String(seconds), '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p', '-y', out], BIG);
  return out;
}

async function makeEpisode(ep, index) {
  const slug = slugify(ep.title);
  const work = path.join(WORK, slug);
  rmSync(work, { recursive: true, force: true });
  mkdirSync(work, { recursive: true });
  mkdirSync(OUT, { recursive: true });

  const refs = refImages();
  const seconds = cfg.shotSeconds || 7.75;
  const retries = cfg.maxRetries ?? 2;
  const clips = [];
  let failed = 0;

  for (const [i, shot] of ep.shots.entries()) {
    const n = i + 1;
    const clip = path.join(work, `clip${n}.mp4`);
    let stillUrl = null, stillFile = null;

    for (let a = 0; a <= retries && !stillUrl; a++) {
      try {
        const r = await fal(cfg.stillModel || 'fal-ai/bytedance/seedream/v4/edit', {
          prompt: stillPrompt(shot),
          image_urls: refs,
          image_size: 'portrait_16_9',
          num_images: 1,
          seed: (bible.seed || 1) + index * 100 + n + a * 1000,
        }, `${slug} shot ${n} still${a ? ` retry ${a}` : ''}`, PRICE.still);
        stillUrl = r.images?.[0]?.url;
        if (stillUrl) stillFile = await download(stillUrl, path.join(work, `still${n}.png`));
      } catch (e) { if (e instanceof BudgetError) throw e; warn(`shot ${n} still: ${e.message}`); }
    }
    if (!stillUrl) { failed++; warn(`shot ${n}: no picture — left out`); continue; }

    let ok = false;
    for (let a = 0; a <= retries && !ok; a++) {
      try {
        const r = await fal(cfg.videoModel || 'fal-ai/minimax/hailuo-02/standard/image-to-video', {
          prompt: motionPrompt(shot),
          image_url: stillUrl,
          duration: String(cfg.videoDuration || '6'),
          resolution: cfg.videoResolution || '768P',
          prompt_optimizer: false,
        }, `${slug} shot ${n} video${a ? ` retry ${a}` : ''}`, PRICE.video);
        const raw = await download(r.video.url, path.join(work, `raw${n}.mp4`));
        await normalise(raw, seconds, clip);
        ok = true;
      } catch (e) { if (e instanceof BudgetError) throw e; warn(`shot ${n} video: ${e.message}`); }
    }
    if (!ok) {
      // The picture is paid for already; a free push-in beats a hole in the story.
      failed++;
      warn(`shot ${n}: animation failed — using a slow zoom on its picture`);
      await kenBurnsFrom(stillFile, seconds, clip);
    }
    clips.push({ n, file: clip });
    log(`shot ${n}/${ep.shots.length} done · spent this month ${usd(spent())}`);
  }

  const maxFailed = cfg.maxFailedShots ?? 3;
  if (failed > maxFailed || clips.length < 4) {
    throw new Error(`${failed} of ${ep.shots.length} shots failed — episode abandoned so it isn't retried every night`);
  }

  const full = path.join(OUT, `${slug}-full.mp4`);
  await assemble(clips.map((c) => c.file), null, full, work);
  const pick = (cfg.shortShots || [1, 2, 8]).map((n) => clips.find((c) => c.n === n)?.file).filter(Boolean);
  const short = path.join(OUT, `${slug}-short.mp4`);
  await assemble(pick.length >= 2 ? pick : clips.slice(0, 3).map((c) => c.file), null, short, work);

  const tags = (book.hashtags || []).join(' ');
  const pending = {
    title: ep.title, slug, date: today(), tag: `koala-${today()}-${slug}`,
    full: path.basename(full), short: path.basename(short),
    caption: `${ep.caption}\n\n${tags}`,
    shortCaption: `${ep.caption} (full story on our page 💛)\n\n${tags}`,
    failedShots: failed,
  };
  writeJson(path.join(OUT, 'manifest.json'), pending);
  return pending;
}

// ── the page on your phone ────────────────────────────────────

function page() {
  const esc = (t) => String(t ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const repo = process.env.GITHUB_REPOSITORY || '';
  const url = (e, f) => `https://github.com/${repo}/releases/download/${e.tag}/${f}`;
  const perEp = (book.episodes[0]?.shots.length || 8) * (PRICE.still + PRICE.video);
  const left = Math.floor(remaining() / perEp);
  const pct = Math.min(100, (spent() / CAP) * 100);
  const st = state.status;
  const cards = [...state.episodes].reverse().map((e, i) => `
  <article>
    <h2>${esc(e.title)} <small>${esc(e.date)}</small></h2>
    ${i === 0 ? `<video src="${esc(url(e, e.full))}" controls playsinline preload="metadata"></video>` : ''}
    <div class="row">
      <a class="btn" href="${esc(url(e, e.full))}">Full episode (1 min)</a>
      <a class="btn alt" href="${esc(url(e, e.short))}">Short cut</a>
    </div>
    <textarea readonly rows="3">${esc(e.caption)}</textarea>
    <button onclick="cp(this)">Copy caption</button>
    ${e.failedShots ? `<p class="note">${e.failedShots} shot(s) used a slow zoom instead of animation — check before posting.</p>` : ''}
  </article>`).join('');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pip &amp; Willow queue</title>
<style>
:root{--bg:#eef2ec;--card:#fff;--ink:#1c2a22;--muted:#5b6b61;--line:#d6ded4;--acc:#4f7355;--warn:#9a5b25}
@media (prefers-color-scheme:dark){:root{--bg:#0f1512;--card:#18211c;--ink:#e7eee8;--muted:#9fb1a5;--line:#2b3a31;--acc:#8cba91;--warn:#d7a45e}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,system-ui,sans-serif;padding:20px 16px 60px}
main{max-width:560px;margin:auto}h1{margin:.1em 0 .4em;font-size:26px}
.budget,article,.status{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:14px 16px;margin:14px 0}
.bar{height:10px;border-radius:6px;background:var(--line);overflow:hidden;margin:8px 0}.bar i{display:block;height:100%;background:var(--acc)}
.muted,small{color:var(--muted);font-size:13px;font-weight:500}.status.error{border-color:var(--warn)}
video{width:100%;border-radius:10px;background:#000;margin:6px 0}
.row{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0}
.btn,button{display:inline-block;background:var(--acc);color:var(--card);text-decoration:none;border:0;border-radius:9px;padding:10px 14px;font:inherit;font-weight:700}
.btn.alt{background:transparent;color:var(--acc);border:1px solid var(--acc)}
textarea{width:100%;font:inherit;font-size:14px;padding:10px;border-radius:9px;border:1px solid var(--line);background:var(--bg);color:var(--ink)}
h2{margin:0;font-size:18px}.note{color:var(--warn);font-size:13px}
.refs{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin:8px 0}.refs img{width:100%;border-radius:8px}
</style><main>
<h1>Pip &amp; Willow</h1>
<section class="budget">
  <b>${usd(spent())}</b> of ${usd(CAP)} spent this month
  <div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>
  <span class="muted">About ${left} more episode${left === 1 ? '' : 's'} fit in this month's budget. Next up: ${esc(book.episodes[state.next]?.title || 'end of the list')}.</span>
</section>
${st ? `<section class="status ${esc(st.level)}"><b>Last run:</b> ${esc(st.text)}<br><span class="muted">${esc(st.at.slice(0, 16).replace('T', ' '))} UTC</span></section>` : ''}
${existsSync(path.join(DOCS, 'refs-new')) ? `<section class="status"><b>New look — waiting for your OK</b><div class="refs">${readdirSync(path.join(DOCS, 'refs-new')).filter((f) => f.endsWith('.jpg')).map((f) => `<img src="refs-new/${f}" alt="">`).join('')}</div><span class="muted">Tell Claude "approve the new look" or what to change.</span></section>` : ''}
<p class="muted">Posting: download → add a sound in TikTok → tick <b>AI-generated</b> → post. Post the full episode first, the short cut on the next day.</p>
${cards || '<p class="muted">No episodes yet.</p>'}
</main>
<script>function cp(b){const t=b.previousElementSibling;t.select();(navigator.clipboard?navigator.clipboard.writeText(t.value):Promise.reject()).catch(()=>document.execCommand('copy'));b.textContent='Copied ✓';setTimeout(()=>b.textContent='Copy caption',1500)}</script>`;
}

function writePage() { mkdirSync(DOCS, { recursive: true }); writeFileSync(path.join(DOCS, 'koala.html'), page()); }

// ── redraw the reference pictures after a design change ───────

/**
 * Redraws each picture in koala/refs/ with the current character descriptions,
 * one call per picture (so each keeps its own pose and scene). Results go to
 * koala/refs-new/ for approval — they only replace the references once
 * approved, because every future episode copies whatever is in refs/.
 */
async function newRefs() {
  const dir = K('refs-new');
  try {
    if (!MOCK && !process.env.FAL_KEY) return setStatus('error', 'No FAL_KEY secret yet — add it in GitHub first. Nothing was spent.');
    const refs = refImages();
    if (!refs.length) return setStatus('error', 'No reference pictures to redraw.');
    if (remaining() < refs.length * PRICE.still) return setStatus('ok', 'Not enough budget left this month to redraw the references.');
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    const [pip, willow] = ['Pip', 'Willow'].map((n) => bible.characters.find((c) => c.name === n));
    const change = (bible.designChange || '').trim();
    const prompt = [
      'Redraw this exact image: same scene, same composition, same poses, same lighting, same 3D animated Pixar style.',
      'Update the two koala characters to match these descriptions exactly:',
      `PIP (the one with the mustard scarf): ${pip.prompt}`,
      `WILLOW: ${willow.prompt}`,
      change ? `Design change: ${change}` : '',
      'Pip must be visibly a little taller than Willow. Willow must clearly read as a girl and Pip as a boy.',
      'No text, no watermark.',
    ].filter(Boolean).join('\n');
    for (const [i, ref] of refs.entries()) {
      const r = await fal(cfg.stillModel || 'fal-ai/bytedance/seedream/v4/edit', {
        prompt, image_urls: [ref], image_size: 'portrait_16_9', num_images: 1, seed: (bible.seed || 1) + i,
      }, `reference redraw ${i + 1}`, PRICE.still);
      const url = r.images?.[0]?.url;
      if (!url) throw new Error(`no image for reference ${i + 1}`);
      const png = path.join(dir, `ref${i + 1}.png`);
      await download(url, png);
      await run('ffmpeg', ['-loglevel', 'error', '-i', png, '-vf', 'scale=768:-2', '-q:v', '3', '-y', path.join(dir, `ref${i + 1}.jpg`)], BIG);
      rmSync(png, { force: true });
    }
    // A copy on the phone page so they can be judged there.
    const pub = path.join(DOCS, 'refs-new');
    rmSync(pub, { recursive: true, force: true });
    mkdirSync(pub, { recursive: true });
    for (const f of readdirSync(dir)) writeFileSync(path.join(pub, f), readFileSync(path.join(dir, f)));
    setStatus('ok', `New-look reference pictures are ready to approve (${refs.length}). No episode is made until they are approved.`);
  } catch (e) {
    setStatus('error', `Reference redraw failed: ${e.message}`);
    process.exitCode = 1;
  } finally {
    writePage();
  }
}

// ── entry ─────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  if (args.includes('--status')) {
    log(`spent ${usd(spent())} of ${usd(CAP)} in ${month()}; next episode #${state.next + 1}: ${book.episodes[state.next]?.title || '(none left)'}`);
    return;
  }

  if (args.includes('--new-refs')) return newRefs();

  if (args.includes('--publish')) {
    const m = readJson(path.join(OUT, 'manifest.json'), null);
    if (m) {
      state.episodes.push(m);
      setStatus('ok', `${m.title} is ready${m.failedShots ? ` (${m.failedShots} shot(s) fell back to a zoom)` : ''}.`);
    }
    writePage();
    return;
  }

  const force = process.env.KOALA_FORCE === 'true';
  try {
    if (process.env.KOALA_PAUSED === 'true') return setStatus('ok', 'Paused (KOALA_PAUSED is set). Nothing was spent.');
    if (!MOCK && !process.env.FAL_KEY) return setStatus('error', 'No FAL_KEY secret yet — add it in GitHub to start. Nothing was spent.');
    if (state.lastRunDate === today() && !force) return setStatus('ok', 'Already made an episode today. Nothing was spent.');
    if (existsSync(K('refs-new'))) return setStatus('ok', 'New-look pictures are waiting for approval, so no episode was made. Nothing was spent.');
    if (!refImages().length) return setStatus('error', 'No reference pictures in koala/refs/ yet — run ./koala-refs.sh on the Mac. Nothing was spent.');

    const ep = book.episodes[state.next];
    if (!ep) return setStatus('ok', 'Every scripted episode is made. Ask Claude for the next batch. Nothing was spent.');

    // The whole episode must fit, plus room for two retried animations, so the
    // cap is never hit halfway through and the money never buys half an episode.
    const need = ep.shots.length * (PRICE.still + PRICE.video) + 2 * PRICE.video;
    if (remaining() < need) {
      return setStatus('ok', `Monthly budget reached: ${usd(spent())} of ${usd(CAP)} spent, an episode needs about ${usd(need)}. Resumes next month.`);
    }

    log(`episode #${state.next + 1}: ${ep.title} · budget left ${usd(remaining())} · needs ~${usd(need)}`);
    state.lastRunDate = today();
    const index = state.next;
    state.next += 1; // advance now: a failed episode must not be retried (and paid for) every night
    writeJson(STATE, state);

    const made = await makeEpisode(ep, index);
    log(`made ${made.full} and ${made.short} · spent this month ${usd(spent())}`);
  } catch (e) {
    setStatus('error', e instanceof BudgetError ? `Stopped at the budget cap: ${e.message}` : `Episode failed: ${e.message}`);
    process.exitCode = 1;
  } finally {
    writePage();
  }
}

main();

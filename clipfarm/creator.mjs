// creator.mjs — "creator" campaigns: cut the best moments from a creator's
// long videos (podcasts, streams, YouTube uploads the campaign supplies).
//
// For each moment it makes one edit PER PLATFORM — different hook line,
// caption colour and a slightly different cut — so TikTok, Reels and Shorts
// each get their own video. Vyro and Whop forbid posting the same video twice
// on a platform, and Instagram/YouTube favour edits that add something.
//
// Moment finding is free and local: a word-timed transcript (faster-whisper)
// plus loudness, scored for the things that make clips travel — reactions,
// questions, exclamations, numbers, pace.

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const run = promisify(execFile);
const BIG = { maxBuffer: 256 * 1024 * 1024 };
const ffmpeg = (args) => run('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], BIG);
const VIDEO = /\.(mp4|mov|m4v|mkv|webm)$/i;

const PLATFORM_STYLE = {
  tiktok: { colour: 'white', nudge: 0, hookAt: 230 },
  instagram: { colour: '0xFFE14D', nudge: -0.4, hookAt: 300 },
  youtube: { colour: '0x7FE7FF', nudge: 0.4, hookAt: 260 },
};

// ── footage ───────────────────────────────────────────────────

/** Fetches every source link into dir. Frame.io uses the share page's own
 *  Download All (passed in); Drive via gdown; Dropbox via its dl=1 switch;
 *  plain file links via curl. YouTube is refused here: it blocks datacentre
 *  downloads, so such campaigns aren't usable by the cloud runner. */
export async function fetchSources(urls, dir, { fetchFrameIo, log, warn }) {
  mkdirSync(dir, { recursive: true });
  for (const url of urls) {
    try {
      if (/youtube\.com|youtu\.be/i.test(url)) { warn(`skipped ${url}: YouTube blocks cloud downloads`); continue; }
      if (/f\.io|frame\.io/i.test(url)) { await fetchFrameIo(url, dir); continue; }
      if (/drive\.google\.com/i.test(url)) {
        const folder = /\/folders\//.test(url);
        // Newer gdown dropped --remaining-ok: try with it, then without.
        if (folder) await run('gdown', ['--folder', url, '-O', dir, '--remaining-ok'], BIG).catch(() => run('gdown', ['--folder', url, '-O', dir], BIG));
        else await run('gdown', ['--fuzzy', url, '-O', dir + '/'], BIG);
        continue;
      }
      if (/dropbox\.com/i.test(url)) {
        const dl = url.replace(/([?&])dl=0/, '$1dl=1') + (/[?&]dl=1/.test(url) ? '' : (url.includes('?') ? '&dl=1' : '?dl=1'));
        const tmp = path.join(dir, `dropbox-${Date.now()}`);
        await run('curl', ['-sSL', '--max-time', '1800', '-o', tmp, dl], BIG);
        const { stdout } = await run('file', ['-b', tmp]).catch(() => ({ stdout: '' }));
        if (/zip/i.test(stdout)) { await run('unzip', ['-oq', tmp, '-d', dir], BIG); rmSync(tmp); }
        else writeFileSync(tmp + '.mp4', readFileSync(tmp)), rmSync(tmp);
        continue;
      }
      const name = decodeURIComponent(new URL(url).pathname.split('/').pop() || `video-${Date.now()}.mp4`);
      await run('curl', ['-sSL', '--max-time', '1800', '-o', path.join(dir, name), url], BIG);
    } catch (e) { warn(`could not fetch ${url}: ${e.message.split('\n')[0]}`); }
  }
  const all = [];
  const walk = (d) => readdirSync(d).forEach((f) => {
    const p = path.join(d, f);
    if (statSync(p).isDirectory()) walk(p); else if (VIDEO.test(f)) all.push(p);
  });
  walk(dir);
  log(`${all.length} source video(s) on hand`);
  return all;
}

// ── analysis ──────────────────────────────────────────────────

export async function transcript(video, root) {
  const out = video + '.words.json';
  if (!existsSync(out)) await run('python3', [path.join(root, 'clipfarm', 'transcribe.py'), video, out], BIG);
  return JSON.parse(readFileSync(out, 'utf8'));
}

/** Momentary loudness every 100ms (EBU R128), cached beside the video. */
async function loudness(video) {
  const out = video + '.loud.json';
  if (existsSync(out)) return JSON.parse(readFileSync(out, 'utf8'));
  const { stderr } = await run('ffmpeg', ['-hide_banner', '-nostats', '-i', video, '-vn', '-af', 'ebur128', '-f', 'null', '-'], BIG);
  const pts = [];
  for (const m of stderr.matchAll(/t:\s*([\d.]+)\s+TARGET.*?M:\s*(-?[\d.]+|-inf)/g)) {
    pts.push([+m[1], m[2] === '-inf' ? -70 : +m[2]]);
  }
  writeFileSync(out, JSON.stringify(pts));
  return pts;
}

const PUNCH = /\b(no way|what|why|how|never|always|crazy|insane|million|billion|money|secret|truth|actually|literally|wait|honestly|worst|best|biggest|first|last|nobody|everyone|stop|love|hate|fired|quit|broke|rich)\b/gi;
const LAUGH = /\b(ha(ha)+|lol|laugh|\[laughter\])\b/gi;

function punchiness(text) {
  return (text.match(PUNCH) || []).length * 1.2 + (text.match(/[?!]/g) || []).length * 1.5
    + (text.match(/\$?\d[\d,.]*/g) || []).length * 0.8 + (text.match(LAUGH) || []).length * 2;
}

/**
 * Candidate windows start on a sentence and end on one, between min and max
 * seconds. Score = speech punch + how far loudness spikes above the video's
 * median + pace. Picks the best non-overlapping windows not used before.
 */
export async function findMoments(video, root, { min = 20, max = 45, want = 3, used = [] }) {
  const { segments } = await transcript(video, root);
  if (!segments.length) return [];
  const loud = await loudness(video);
  const med = [...loud.map((p) => p[1])].sort((a, b) => a - b)[Math.floor(loud.length / 2)] ?? -30;
  const spike = (s, e) => {
    const v = loud.filter((p) => p[0] >= s && p[0] <= e).map((p) => p[1]).sort((a, b) => b - a);
    if (!v.length) return 0;
    const top = v.slice(0, Math.max(1, Math.floor(v.length * 0.2)));
    return Math.max(0, top.reduce((a, b) => a + b, 0) / top.length - med) / 3;
  };
  const cands = [];
  for (let i = 0; i < segments.length; i++) {
    let j = i;
    while (j < segments.length && segments[j].end - segments[i].start < min) j++;
    for (; j < segments.length && segments[j].end - segments[i].start <= max; j++) {
      const s = segments[i].start, e = segments[j].end;
      const text = segments.slice(i, j + 1).map((x) => x.text).join(' ');
      const words = text.split(/\s+/).length;
      const score = punchiness(text) + spike(s, e) + Math.min(3, words / (e - s)) * 0.6;
      cands.push({ s, e, i, j, text, score });
    }
  }
  const overlaps = (a, b) => a.s < b.e && b.s < a.e;
  const taken = used.map((u) => ({ s: u.s, e: u.e }));
  const picked = [];
  for (const c of cands.sort((a, b) => b.score - a.score)) {
    if (picked.length >= want) break;
    if ([...taken, ...picked].some((t) => overlaps(t, c))) continue;
    picked.push(c);
  }
  return picked.map((p) => ({ ...p, segments: segments.slice(p.i, p.j + 1) }));
}

// ── hooks and captions ────────────────────────────────────────

const noEmoji = (t) => String(t).replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '').replace(/\s+/g, ' ').trim();

/** Three different hook lines for one moment: its punchiest sentences quoted
 *  (shortened), then the campaign's own hook ideas as fallbacks. */
export function hooksFor(moment, campaignHooks = [], seed = 0, allowQuotes = true) {
  const lines = moment.segments.map((s) => s.text.trim())
    .filter((t) => t.split(/\s+/).length >= 3)
    .map((t) => ({ t, p: punchiness(t) - Math.max(0, t.split(/\s+/).length - 12) * 0.3 }))
    .sort((a, b) => b.p - a.p)
    .map(({ t }) => {
      const w = t.replace(/^[,.\s-]+/, '').split(/\s+/);
      const short = w.length > 10 ? w.slice(0, 10).join(' ') + '…' : w.join(' ');
      return `"${short.replace(/[.,]$/, '')}"`;
    });
  // A random question from the transcript ("You know what I'm saying?") stops
  // nobody scrolling. Written hooks lead; a quote only gets a slot when it
  // scores as genuinely punchy.
  const strong = moment.segments.map((s) => s.text.trim())
    .filter((t) => punchiness(t) >= 3 && t.split(/\s+/).length >= 4).length;
  const written = campaignHooks.map(noEmoji);
  const rot = written.length ? written.map((_, i) => written[(i + seed) % written.length]) : [];
  const pool = written.length
    ? [rot[0], strong && allowQuotes ? lines[0] : rot[1 % rot.length], rot[2 % rot.length]]
    : [...new Set(lines)];
  while (pool.length < 3) pool.push(pool[pool.length - 1] || 'Wait for it…');
  return pool.slice(0, 3).map(noEmoji);
}

function wrap(text, max) {
  const out = []; let cur = '';
  for (const w of text.split(' ')) {
    if ((cur + ' ' + w).trim().length > max && cur) { out.push(cur); cur = w; } else cur = (cur + ' ' + w).trim();
  }
  if (cur) out.push(cur);
  return out.slice(0, 3);
}

/** Word groups (≤4 words, ≤1.6s) timed relative to the clip start. */
function captionChunks(moment, start) {
  // Whisper splits "D-O-N", "$100,000" and "1000%" into fragments ("-O",
  // ",000.", "%"): glue each fragment back onto the word before it.
  const words = [];
  for (const w of moment.segments.flatMap((s) => s.words).filter((x) => x.w)) {
    const prev = words[words.length - 1];
    if (prev && /^[-,.%!?']/.test(w.w)) words[words.length - 1] = { ...prev, w: prev.w + w.w, e: w.e };
    else words.push({ ...w });
  }
  const chunks = [];
  let cur = [];
  for (const w of words) {
    const chars = cur.map((x) => x.w).join(' ').length + w.w.length + 1;
    if (cur.length && (cur.length >= 3 || chars > 18 || w.e - cur[0].s > 1.4)) { chunks.push(cur); cur = []; }
    cur.push(w);
  }
  if (cur.length) chunks.push(cur);
  // Each chunk ends no later than the next one starts, so two never show at once.
  return chunks.map((c, k) => {
    const next = chunks[k + 1];
    const end = Math.min(c[c.length - 1].e + 0.05, next ? next[0].s - 0.02 : Infinity);
    return { s: Math.max(0, c[0].s - start), e: Math.max(0, end - start), text: c.map((w) => w.w).join(' ') };
  });
}

// ── render ────────────────────────────────────────────────────

/**
 * One platform's edit. Layout is 'blurfill' (landscape source sits full-width
 * over a blurred, darkened copy of itself — nothing cropped away) or 'crop'
 * (centre-crop to 9:16, for sources that are already close to vertical).
 */
export async function renderMoment({ video, moment, hook, platform, out, work, font, layout = 'blurfill', credit = '', zoom = 1.3, exact = 0, context = '', ask = '' }) {
  const st = PLATFORM_STYLE[platform] || PLATFORM_STYLE.tiktok;
  // Subtitles and the end question normally sit at fixed heights; with the
  // picture letterboxed they go just below it, so text never covers the scene.
  let capY = 1290, askY = 1420, ph = 0;
  if (layout === 'letterbox') {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', video]);
    const [vw, vh] = stdout.trim().split(',').map(Number);
    ph = Math.round((1080 * vh) / vw / 2) * 2;
  }
  // exact: a brief that fixes the length (Disney: "no more than 15 seconds",
  // Vyro: "at least 15") gets exactly that many seconds, the moment centred in it.
  const lead = exact ? Math.max(0.2, (exact - (moment.e - moment.s)) / 2) : 0.25;
  const start = Math.max(0, moment.s - lead + st.nudge);
  const dur = exact || moment.e - moment.s + 0.6;
  mkdirSync(work, { recursive: true });
  const txt = (name, t) => { const f = path.join(work, name); writeFileSync(f, t); return f; };
  const draws = [];
  const hookLines = wrap(hook, 22);
  const ctxLines = wrap(noEmoji(context), 36).slice(0, 2);
  // Hook + context must sit above the footage (which starts ~485px down at
  // the usual zoom), so the block moves up when the context line is there.
  const block = hookLines.length * 78 + (ctxLines.length ? 14 + ctxLines.length * 50 : 0);
  const top = Math.max(170, Math.min(st.hookAt, 470 - block));
  // Letterbox: the picture starts below the hook block, so text never sits on it.
  const padY = ph ? Math.max(Math.round((1920 - ph) / 2), top + block + 24) : 0;
  if (ph) { capY = padY + ph + 24; askY = Math.min(1920 - 200, capY + 110); }
  hookLines.forEach((l, i) => draws.push(
    `drawtext=fontfile=${font}:expansion=none:textfile=${txt(`hook-${platform}-${i}.txt`, l)}:fontsize=64:fontcolor=white:borderw=6:bordercolor=black@0.85:x=(w-text_w)/2:y=${top + i * 78}`));
  // One quieter line under the hook that sets the scene, so someone who has
  // never seen the show knows what they're watching in the first second.
  ctxLines.forEach((l, i) => draws.push(
    `drawtext=fontfile=${font}:expansion=none:textfile=${txt(`ctx-${platform}-${i}.txt`, l)}:fontsize=40:fontcolor=0xFFE27A:borderw=4:bordercolor=black@0.85:x=(w-text_w)/2:y=${top + hookLines.length * 78 + 14 + i * 50}`));
  // expansion=none everywhere: drawtext otherwise treats % as a template code
  // and silently drops lines like "5% stake".
  captionChunks(moment, start).forEach((c, i) => draws.push(
    `drawtext=fontfile=${font}:expansion=none:textfile=${txt(`cap-${platform}-${i}.txt`, c.text.toUpperCase())}:fontsize=${Math.min(76, Math.floor(980 / Math.max(1, c.text.length * 0.66)))}:fontcolor=${st.colour}:borderw=7:bordercolor=black:x=(w-text_w)/2:y=${capY}:enable='between(t,${c.s.toFixed(2)},${c.e.toFixed(2)})'`));
  // The comment question, on screen for the last 3 seconds: people answer a
  // question they can see far more often than one buried in the caption.
  if (ask) {
    const askAt = Math.max(0, dur - 3);
    wrap(noEmoji(ask), 26).slice(0, 2).forEach((l, i) => draws.push(
      `drawtext=fontfile=${font}:expansion=none:textfile=${txt(`ask-${platform}-${i}.txt`, l)}:fontsize=54:fontcolor=0xFFE27A:borderw=6:bordercolor=black:box=1:boxcolor=black@0.45:boxborderw=14:x=(w-text_w)/2:y=${askY + i * 70}:enable='gte(t,${askAt.toFixed(2)})'`));
  }
  if (credit) draws.push(`drawtext=fontfile=${font}:expansion=none:textfile=${txt(`credit-${platform}.txt`, credit)}:fontsize=36:fontcolor=white@0.85:borderw=3:bordercolor=black@0.7:x=(w-text_w)/2:y=1620`);
  // 'track': a tall crop (1080 wide, ~70% of the screen high) that follows the
  // faces shot by shot (clipfarm/faces.py), so people fill the frame the way
  // native vertical video does, instead of a small letterboxed TV picture.
  let tracked = null;
  if (layout === 'track') {
    const H = 1344, W = Math.round((H * 16) / 9 / 2) * 2;
    let shots = [];
    try { shots = JSON.parse((await run('python3', [path.join(import.meta.dirname, 'faces.py'), video, start.toFixed(2), dur.toFixed(2)])).stdout); } catch { shots = []; }
    const xOf = (cx) => Math.round(Math.min(Math.max(cx * W - 540, 0), W - 1080));
    const expr = shots.length ? shots.slice(0, -1).reduceRight((acc, sh) => `if(lt(t\\,${sh.e})\\,${xOf(sh.cx)}\\,${acc})`, String(xOf(shots[shots.length - 1].cx))) : String(xOf(0.5));
    tracked = `[0:v]split[a][b];[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:2,eq=brightness=-0.18[bg];`
      + `[b]scale=-2:${H},crop=1080:${H}:${expr}:0[fg];[bg][fg]overlay=0:${top + block + 24},setsar=1[v0]`;
  }
  // 'letterbox': the picture exactly as supplied (no crop, zoom, blur or colour
  // change), scaled to the full width and centred on plain black; text sits only
  // in the black bars. For briefs that forbid reframing (e.g. CONCESSIONS).
  const letterbox = layout === 'letterbox'
    ? `[0:v]scale=1080:-2:flags=lanczos,pad=1080:1920:0:${Math.min(padY, 1920 - ph)}:black,setsar=1[v0]`
    : null;
  const base = letterbox ? letterbox : tracked ? tracked : layout === 'crop'
    ? `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[v0]`
    : `[0:v]split[a][b];[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:2,eq=brightness=-0.18[bg];`
      // Wide shots are shown zoomed (centre kept, edges trimmed) so people
      // aren't tiny on a phone; zoom 1 shows the full width.
      + `[b]scale=${Math.round(1080 * zoom / 2) * 2}:-2,crop=1080:ih[fg];[bg][fg]overlay=(W-w)/2:max((H-h)/2-80\\,${top + block + 24}),setsar=1[v0]`;
  const filter = `${base};[v0]${draws.join(',')}[v]`;
  await ffmpeg(['-ss', start.toFixed(2), '-t', dur.toFixed(2), '-i', video, '-filter_complex', filter,
    '-map', '[v]', '-map', '0:a?', '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    // TV masters sit at -24 LUFS; phones play short video around -14, so a
    // clip left at TV level sounds silent next to everything else in the feed.
    '-af', 'loudnorm=I=-14:TP=-1.5:LRA=11',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', ...(exact ? ['-t', String(exact)] : []), '-movflags', '+faststart', '-y', out]);
  return out;
}

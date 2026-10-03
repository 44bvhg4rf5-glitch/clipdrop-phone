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
        await run('gdown', folder ? ['--folder', url, '-O', dir, '--remaining-ok'] : ['--fuzzy', url, '-O', dir + '/'], BIG);
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

async function transcript(video, root) {
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
export function hooksFor(moment, campaignHooks = []) {
  const lines = moment.segments.map((s) => s.text.trim())
    .filter((t) => t.split(/\s+/).length >= 3)
    .map((t) => ({ t, p: punchiness(t) - Math.max(0, t.split(/\s+/).length - 12) * 0.3 }))
    .sort((a, b) => b.p - a.p)
    .map(({ t }) => {
      const w = t.replace(/^[,.\s-]+/, '').split(/\s+/);
      const short = w.length > 10 ? w.slice(0, 10).join(' ') + '…' : w.join(' ');
      return `"${short.replace(/[.,]$/, '')}"`;
    });
  const pool = [...new Set([...lines, ...campaignHooks.map(noEmoji)])];
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
  const words = moment.segments.flatMap((s) => s.words).filter((w) => w.w);
  const chunks = [];
  let cur = [];
  for (const w of words) {
    const chars = cur.map((x) => x.w).join(' ').length + w.w.length + 1;
    if (cur.length && (cur.length >= 3 || chars > 18 || w.e - cur[0].s > 1.4)) { chunks.push(cur); cur = []; }
    cur.push(w);
  }
  if (cur.length) chunks.push(cur);
  return chunks.map((c) => ({ s: Math.max(0, c[0].s - start), e: Math.max(0, c[c.length - 1].e - start + 0.05), text: c.map((w) => w.w).join(' ') }));
}

// ── render ────────────────────────────────────────────────────

/**
 * One platform's edit. Layout is 'blurfill' (landscape source sits full-width
 * over a blurred, darkened copy of itself — nothing cropped away) or 'crop'
 * (centre-crop to 9:16, for sources that are already close to vertical).
 */
export async function renderMoment({ video, moment, hook, platform, out, work, font, layout = 'blurfill', credit = '' }) {
  const st = PLATFORM_STYLE[platform] || PLATFORM_STYLE.tiktok;
  const start = Math.max(0, moment.s - 0.25 + st.nudge);
  const dur = moment.e - moment.s + 0.6;
  mkdirSync(work, { recursive: true });
  const txt = (name, t) => { const f = path.join(work, name); writeFileSync(f, t); return f; };
  const draws = [];
  wrap(hook, 22).forEach((l, i) => draws.push(
    `drawtext=fontfile=${font}:expansion=none:textfile=${txt(`hook-${platform}-${i}.txt`, l)}:fontsize=64:fontcolor=white:borderw=6:bordercolor=black@0.85:x=(w-text_w)/2:y=${st.hookAt + i * 78}`));
  // expansion=none everywhere: drawtext otherwise treats % as a template code
  // and silently drops lines like "5% stake".
  captionChunks(moment, start).forEach((c, i) => draws.push(
    `drawtext=fontfile=${font}:expansion=none:textfile=${txt(`cap-${platform}-${i}.txt`, c.text.toUpperCase())}:fontsize=${Math.min(76, Math.floor(980 / Math.max(1, c.text.length * 0.66)))}:fontcolor=${st.colour}:borderw=7:bordercolor=black:x=(w-text_w)/2:y=1290:enable='between(t,${c.s.toFixed(2)},${c.e.toFixed(2)})'`));
  if (credit) draws.push(`drawtext=fontfile=${font}:expansion=none:textfile=${txt(`credit-${platform}.txt`, credit)}:fontsize=36:fontcolor=white@0.85:borderw=3:bordercolor=black@0.7:x=(w-text_w)/2:y=1620`);
  const base = layout === 'crop'
    ? `[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,setsar=1[v0]`
    : `[0:v]split[a][b];[a]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=24:2,eq=brightness=-0.18[bg];`
      + `[b]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2-80,setsar=1[v0]`;
  const filter = `${base};[v0]${draws.join(',')}[v]`;
  await ffmpeg(['-ss', start.toFixed(2), '-t', dur.toFixed(2), '-i', video, '-filter_complex', filter,
    '-map', '[v]', '-map', '0:a?', '-r', '30', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '44100', '-movflags', '+faststart', '-y', out]);
  return out;
}

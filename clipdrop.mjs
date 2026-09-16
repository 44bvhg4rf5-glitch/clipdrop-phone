// clipdrop.mjs — the whole pipeline in one file.
//
// Single-file on purpose: GitHub's web uploader on a phone cannot preserve
// folders, so every file you pick lands at the repo root. One file at the root
// is the only shape that survives that trip.
//
//   node clipdrop.mjs          build today's drop
//   node clipdrop.mjs --dry    pick moments and write copy, render nothing
//
// Sections, in order:
//   1. SOURCES  — find the moments (YouTube heatmap / Twitch top clips)
//   2. RENDER   — download the slice, reframe vertical, burn the hook in
//   3. COPY     — hook, caption, hashtags
//   4. PAGE     — the page you open in the morning
//   5. RUN      — the orchestrator

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs';
import path from 'node:path';

const run = promisify(execFile);
const BIG = { maxBuffer: 64 * 1024 * 1024 };


// ==========================================================
// 1. SOURCES
// ==========================================================
// sources.mjs — find the moments worth clipping, without watching anything.
//
// The whole premise: don't detect good moments, inherit them. Both platforms
// already publish crowd data on which seconds are best, and the crowd has
// better judgement than any heuristic we'd write.
//
//   YouTube — the "most replayed" heatmap. yt-dlp surfaces it as a `heatmap`
//             array of {start_time, end_time, value}, value normalised 0-1.
//             The peaks are literally where viewers rewound.
//   Twitch  — the Helix /clips endpoint, ordered by view count. Real people
//             already cut these by hand.



// yt-dlp emits one JSON object per line for playlists, one total for a video.
const ytJson = async (args) => {
  const { stdout } = await run('yt-dlp', args, { maxBuffer: 64 * 1024 * 1024 });
  return stdout
    .split('\n')
    .filter((l) => l.trim().startsWith('{'))
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
};

/**
 * Most recent uploads from a channel, newest first.
 * --flat-playlist keeps this to one cheap request; per-video detail comes later.
 */
async function recentVideos(channelUrl, limit = 6) {
  const rows = await ytJson([
    '--flat-playlist',
    '--playlist-end', String(limit),
    '--dump-json',
    '--no-warnings',
    channelUrl,
  ]);
  return rows
    .filter((v) => v.id && v.duration)
    .map((v) => ({
      id: v.id,
      title: v.title || 'untitled',
      duration: Math.round(v.duration),
      url: `https://www.youtube.com/watch?v=${v.id}`,
    }));
}

/** Full metadata for one video — this is the call that carries the heatmap. */
async function videoDetail(url) {
  const [v] = await ytJson(['--dump-json', '--no-warnings', url]);
  if (!v) throw new Error(`no metadata for ${url}`);
  return v;
}

/**
 * Turn a heatmap into clip windows.
 *
 * Deliberately NOT taking the single highest peak: every other clipper running
 * this same trick takes peak #1, and a feed full of identical clips earns
 * nobody anything. `skipTop` steps past the obvious ones into the moments that
 * are still strong but less picked over.
 */
function momentsFromHeatmap(detail, opts = {}) {
  const {
    want = 5,
    clipSeconds = 24,
    skipTop = 3,        // step past the most-contested peaks
    minGap = 45,        // don't return two windows from the same stretch
    headGuard = 30,     // intros are replayed a lot and are never the moment
    tailGuard = 20,
  } = opts;

  const heat = Array.isArray(detail.heatmap) ? detail.heatmap : null;
  const duration = Math.round(detail.duration || 0);
  if (!heat || heat.length < 8 || duration < 90) {
    return { ok: false, reason: heat ? 'video_too_short' : 'no_heatmap', moments: [] };
  }

  const usable = heat
    .map((h) => ({
      t: Number(h.start_time ?? 0),
      v: Number(h.value ?? 0),
    }))
    .filter((h) => Number.isFinite(h.t) && Number.isFinite(h.v))
    .filter((h) => h.t > headGuard && h.t < duration - clipSeconds - tailGuard)
    .sort((a, b) => b.v - a.v);

  if (!usable.length) return { ok: false, reason: 'no_usable_peaks', moments: [] };

  // Collapse buckets into distinct moments FIRST. A single spike spans two or
  // three adjacent buckets, so ranking buckets would spend the skip allowance
  // on one peak and call it three.
  const distinct = [];
  for (const b of usable) {
    if (distinct.some((d) => Math.abs(d.t - b.t) < minGap)) continue;
    distinct.push(b);
  }

  // A floor, relative to this video's own baseline. Without it, a video with
  // only two real spikes still returns five "moments" — three of them ordinary
  // seconds that happen to rank next. Fewer good clips beats padding with noise.
  const values = [...usable].map((h) => h.v).sort((a, b) => a - b);
  const median = values[Math.floor(values.length / 2)];
  const peak = values[values.length - 1];

  // Some videos have no moment at all — watched evenly, rewound nowhere. The
  // relative floor below can't catch that on its own: on a flat map, median and
  // peak sit close together, so the floor lands just above median and half the
  // buckets clear it. Check the map has a spike in it before trusting the ranking.
  if (!median || (peak - median) / median < 0.30) {
    return { ok: false, reason: 'heatmap_too_flat', moments: [] };
  }

  const floor = median + 0.45 * (peak - median);

  const strong = distinct.filter((d) => d.v >= floor);
  if (!strong.length) return { ok: false, reason: 'no_peak_above_baseline', moments: [] };

  const picked = strong.slice(skipTop, skipTop + want).map((p) => ({
    peakAt: p.t,
    // Start a few seconds BEFORE the peak: the replayed second is the payoff,
    // and a clip that opens on the payoff has no setup to make it land.
    start: Math.max(headGuard, Math.round(p.t - 6)),
    seconds: clipSeconds,
    timecode: hms(Math.max(headGuard, Math.round(p.t - 6))),
    intensity: Number(p.v.toFixed(3)),
  }));

  picked.sort((a, b) => a.start - b.start);
  return {
    ok: picked.length > 0,
    reason: picked.length ? null : 'all_peaks_were_top_ranked',
    moments: picked,
  };
}

/**
 * Twitch: the community already did the cutting. Needs a free dev app
 * (client credentials only — no user login, nobody signs into anything).
 */
async function twitchTopClips({ clientId, clientSecret, login, sinceDays = 7, want = 5 }) {
  const tokenRes = await fetch('https://id.twitch.tv/oauth2/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'client_credentials',
    }),
  });
  if (!tokenRes.ok) throw new Error(`twitch auth failed: ${tokenRes.status}`);
  const { access_token } = await tokenRes.json();
  const head = { 'Client-Id': clientId, Authorization: `Bearer ${access_token}` };

  const userRes = await fetch(`https://api.twitch.tv/helix/users?login=${encodeURIComponent(login)}`, { headers: head });
  const user = (await userRes.json()).data?.[0];
  if (!user) throw new Error(`no such twitch channel: ${login}`);

  // Widen the window rather than come back empty. A streamer who didn't go live
  // this week still has last month's clips, and an empty drop helps nobody.
  let clips = [];
  for (const days of [sinceDays, sinceDays * 4, sinceDays * 13]) {
    const started = new Date(Date.now() - days * 864e5).toISOString();
    const res = await fetch(
      `https://api.twitch.tv/helix/clips?broadcaster_id=${user.id}&started_at=${started}&first=60`,
      { headers: head },
    );
    if (!res.ok) throw new Error(`twitch clips failed: ${res.status} ${await res.text()}`);
    clips = (await res.json()).data || [];
    if (clips.length >= want + 3) break;
  }
  if (!clips.length) throw new Error(`${login} has no clips in the last ${sinceDays * 13} days`);

  // Ordered by view count already. Skip the most-contested few for the same
  // reason as the YouTube path — but only when skipping still leaves enough.
  // On a smaller channel, blindly dropping the top 3 can empty the list.
  const skip = clips.length >= want + 3 ? 3 : 0;

  return clips.slice(skip, skip + want).map((c) => ({
    id: c.id,
    title: c.title,
    url: c.url,               // yt-dlp downloads a clip URL directly
    seconds: Math.round(c.duration),
    views: c.view_count,
    creator: c.broadcaster_name,
  }));
}

const hms = (s) => {
  const n = Math.max(0, Math.round(s));
  const p = (x) => String(x).padStart(2, '0');
  return `${p(Math.floor(n / 3600))}:${p(Math.floor((n % 3600) / 60))}:${p(n % 60)}`;
};


// ==========================================================
// 2. RENDER
// ==========================================================
// render.mjs — download just the slice we need, reframe it vertical, burn the hook in.
//
// This runs on a GitHub Actions runner, not the iPad, which means we get the
// full GPL ffmpeg: libx264, drawtext, the lot. None of the a-Shell workarounds
// (videotoolbox, gblur instead of boxblur) are needed here.



const FONT = process.env.CLIPDROP_FONT
  || '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

/**
 * drawtext treats : \ ' and % as syntax. Unescaped, a caption containing an
 * apostrophe doesn't render badly — it aborts the whole filtergraph.
 */
const escFilter = (s) => String(s)
  .replace(/\\/g, '\\\\')
  .replace(/:/g, '\\:')
  .replace(/'/g, "’")   // curly quote sidesteps the shell entirely
  .replace(/%/g, '\\%');

/** Break a hook onto ~2 lines so it never runs off a 1080px frame. */
function wrapHook(text, perLine = 22) {
  const words = String(text).trim().split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    if ((line + ' ' + w).trim().length > perLine && line) { lines.push(line); line = w; }
    else line = (line + ' ' + w).trim();
  }
  if (line) lines.push(line);
  return lines.slice(0, 3).join('\n');
}

/**
 * Pull only the seconds we want. On a 3-hour VOD this is the difference
 * between a 12-second job and a 40-minute one.
 */
async function fetchSlice({ url, start, seconds, out }) {
  mkdirSync(path.dirname(out), { recursive: true });
  const end = hhmmss(toSeconds(start) + seconds + 2); // pad: keyframe cuts drift
  await run('yt-dlp', [
    '--download-sections', `*${start}-${end}`,
    '--force-keyframes-at-cuts',
    '-f', 'bv*[height<=1080]+ba/b[height<=1080]/b',
    '--merge-output-format', 'mp4',
    '--no-warnings',
    '-o', out,
    url,
  ], BIG);
  if (!existsSync(out)) throw new Error(`download produced nothing: ${out}`);
  return out;
}

/** Whole-file download, for Twitch clips that are already the right length. */
async function fetchWhole({ url, out }) {
  mkdirSync(path.dirname(out), { recursive: true });
  await run('yt-dlp', [
    '-f', 'bv*[height<=1080]+ba/b[height<=1080]/b',
    '--merge-output-format', 'mp4',
    '--no-warnings',
    '-o', out,
    url,
  ], BIG);
  if (!existsSync(out)) throw new Error(`download produced nothing: ${out}`);
  return out;
}

/**
 * 16:9 → 9:16 with the hook burnt into the opening seconds.
 *
 * mode 'crop'  — fill the frame, lose the sides. Best for gameplay, where the
 *                action sits centre-frame anyway.
 * mode 'blur'  — whole frame kept, blurred copy fills the bars. Best when the
 *                edges carry information (scoreboards, chat, facecam).
 */
async function toVertical({ input, out, hook, mode = 'crop', seconds, hookFor = 3.2 }) {
  mkdirSync(path.dirname(out), { recursive: true });

  const base = mode === 'blur'
    ? '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920,boxblur=28:2[bg];'
      + '[0:v]scale=1080:-2[fg];[bg][fg]overlay=(W-w)/2:(H-h)/2[v0]'
    : '[0:v]scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920[v0]';

  const chain = hook
    ? `${base};[v0]drawtext=fontfile=${FONT}:text='${escFilter(wrapHook(hook))}'`
      + `:fontcolor=white:fontsize=68:line_spacing=12`
      + `:box=1:boxcolor=black@0.58:boxborderw=26`
      + `:x=(w-text_w)/2:y=h*0.13`
      + `:enable='lt(t,${hookFor})'[vout]`
    : `${base};[v0]null[vout]`;

  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-i', input,
    '-filter_complex', chain,
    '-map', '[vout]', '-map', '0:a?',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20',
    '-pix_fmt', 'yuv420p', '-r', '30',
    '-c:a', 'aac', '-b:a', '128k',
    '-movflags', '+faststart',
  ];
  if (seconds) args.push('-t', String(seconds));
  args.push('-y', out);

  await run('ffmpeg', args, BIG);

  // A failed ffmpeg run routinely leaves a 0-byte file behind. Existence is
  // not success; size is.
  const size = existsSync(out) ? statSync(out).size : 0;
  if (size < 20000) throw new Error(`render produced nothing usable (${size} bytes): ${out}`);
  return { out, size };
}

const toSeconds = (tc) => {
  const p = String(tc).split(':').map(Number);
  if (p.length === 3) return p[0] * 3600 + p[1] * 60 + p[2];
  if (p.length === 2) return p[0] * 60 + p[1];
  return Number(tc) || 0;
};

const hhmmss = (s) => {
  const n = Math.max(0, Math.round(s));
  const p = (x) => String(x).padStart(2, '0');
  return `${p(Math.floor(n / 3600))}:${p(Math.floor((n % 3600) / 60))}:${p(n % 60)}`;
};


// ==========================================================
// 3. COPY
// ==========================================================
// copy.mjs — the hook, caption and tags that ship with each clip.
//
// Works with no API key at all: the deterministic path below builds usable copy
// from the video title and the campaign niche. If ANTHROPIC_API_KEY is present
// it writes sharper lines instead. Never blocks the drop either way — a clip
// with a plain hook still posts; a pipeline that halts because a key expired
// costs you the morning.

const TAGS = {
  gaming: ['fyp', 'gaming', 'clips', 'gamingclips', 'viral', 'twitch', 'gamer', 'foryou'],
  clash:  ['fyp', 'clashofclans', 'coc', 'clashclips', 'townhall', 'gaming', 'viral', 'foryou'],
  irl:    ['fyp', 'streamer', 'clips', 'funny', 'viral', 'twitch', 'foryou', 'lol'],
  generic:['fyp', 'viral', 'clips', 'foryou', 'trending', 'fyppppp', 'edit', 'watchtillend'],
};

// Hook frames that work because they open a loop the viewer needs closed —
// not because they're clever. Keep them short: 3 seconds of screen time.
const FRAMES = [
  (s) => `He did NOT expect this`,
  (s) => `Wait for the last 3 seconds`,
  (s) => `This is why ${s} is unreal`,
  (s) => `Nobody saw this coming`,
  (s) => `I had to rewatch this`,
  (s) => `The reaction says it all`,
  (s) => `This shouldn't be possible`,
  (s) => `Chat lost it`,
];

const clean = (t) => String(t || '')
  .replace(/[|\-–—]+\s*(highlights?|stream|vod|full|part \d+).*$/i, '')
  .replace(/[#@]\S+/g, '')
  .replace(/\s+/g, ' ')
  .trim();

/** Deterministic copy. No network, no key, never fails. */
function fallbackCopy({ title, subject, niche = 'generic', index = 0 }) {
  const who = subject || clean(title).split(/\s+/).slice(0, 2).join(' ') || 'this';
  return {
    hook: FRAMES[index % FRAMES.length](who),
    caption: `${clean(title).slice(0, 90) || 'Had to clip this'} 😳`,
    hashtags: (TAGS[niche] || TAGS.generic).map((t) => `#${t}`),
    source: 'fallback',
  };
}

/** Sharper copy when a key is available. Falls back silently on any failure. */
async function writeCopy({ title, subject, niche = 'generic', index = 0 }) {
  const key = process.env.ANTHROPIC_API_KEY;
  const fb = fallbackCopy({ title, subject, niche, index });
  if (!key) return fb;

  const prompt = `A short vertical clip is being posted to TikTok.
Source video title: "${clean(title)}"
Creator/subject: ${subject || 'unknown'}
Niche: ${niche}

Write posting copy. Reply with JSON only, no prose:
{"hook":"...","caption":"...","hashtags":["#...", ...]}

Rules:
- "hook" is burnt on screen for the first 3 seconds. Max 7 words. It must open a
  curiosity gap, not describe the clip. No emoji, no hashtags, no quote marks.
- "caption" is one line, under 100 characters, at most one emoji.
- "hashtags": exactly 8, lowercase, mix of broad and niche.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: process.env.CLIPDROP_MODEL || 'claude-sonnet-5',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) return fb;
    const text = (await res.json()).content?.[0]?.text || '';
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) return fb;
    const j = JSON.parse(m[0]);
    if (!j.hook || !j.caption) return fb;
    return {
      hook: String(j.hook).slice(0, 60),
      caption: String(j.caption).slice(0, 150),
      hashtags: Array.isArray(j.hashtags) && j.hashtags.length
        ? j.hashtags.slice(0, 8).map((t) => (t.startsWith('#') ? t : `#${t}`))
        : fb.hashtags,
      source: 'ai',
    };
  } catch {
    return fb;
  }
}


// ==========================================================
// 4. PAGE
// ==========================================================
// page.mjs — the one page you open in the morning.
//
// Design brief: thumb-reachable, no reading required, and it remembers where you
// got to. Every clip is three taps — preview, download, copy caption — then a
// box for the TikTok link so the claim step has everything in one place.

const escHtml = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function buildPage(drop, cfg = {}) {
  const nice = new Date(drop.date + 'T00:00:00Z')
    .toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });

  const cards = drop.clips.map((c, i) => {
    const tags = (c.hashtags || []).join(' ');
    const full = `${c.caption}\n\n${tags}`;
    return `
    <article class="clip" data-id="${escHtml(c.file)}">
      <div class="vwrap">
        <video src="${escHtml(c.file)}" preload="metadata" playsinline controls></video>
        <span class="rank">${i + 1}</span>
      </div>
      <div class="meta">
        <div class="hook">${escHtml(c.hook)}</div>
        <div class="from">${escHtml(c.sourceName)} · ${escHtml(c.seconds)}s · ${escHtml(c.sizeMb)} MB</div>
      </div>
      <div class="cap" id="cap-${i}">${escHtml(c.caption)}
        <span class="tags">${escHtml(tags)}</span>
      </div>
      <div class="acts">
        <a class="btn primary" href="${escHtml(c.file)}" download>Download</a>
        <button class="btn" type="button" data-copy="${escHtml(full)}">Copy caption</button>
      </div>
      <label class="claim">
        <span>TikTok link, once posted</span>
        <input type="url" id="link-${escHtml(c.file)}" inputmode="url" autocomplete="off"
               placeholder="https://www.tiktok.com/…">
      </label>
      <button class="done" type="button" data-done="${escHtml(c.file)}">Mark posted &amp; claimed</button>
    </article>`;
  }).join('\n');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="apple-mobile-web-app-capable" content="yes">
<title>Today's Drop</title>
<style>
  :root{
    --paper:#eceff2; --panel:#fff; --panel2:#f3f6f8; --ink:#101c26; --muted:#5c6e7c;
    --faint:#8598a6; --line:#d5dee5; --go:#b5306a; --ok:#3f7a12;
  }
  @media (prefers-color-scheme:dark){
    :root:not([data-theme="light"]){
      --paper:#070e14; --panel:#101c26; --panel2:#16242f; --ink:#e8eef4; --muted:#93a5b4;
      --faint:#6d8294; --line:#22323f; --go:#f277ab; --ok:#a3d45f;
    }
  }
  :root[data-theme="dark"]{
    --paper:#070e14; --panel:#101c26; --panel2:#16242f; --ink:#e8eef4; --muted:#93a5b4;
    --faint:#6d8294; --line:#22323f; --go:#f277ab; --ok:#a3d45f;
  }
  *{box-sizing:border-box;}
  body{margin:0;background:var(--paper);color:var(--ink);
    font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
    padding:0 14px env(safe-area-inset-bottom,0px);}
  .wrap{max-width:560px;margin:0 auto;padding-block:26px 48px;}

  header{margin-bottom:20px;}
  .kicker{font-size:11px;letter-spacing:.18em;text-transform:uppercase;font-weight:700;color:var(--go);}
  h1{font-size:30px;line-height:1.06;letter-spacing:-.03em;margin:.22em 0 .3em;font-weight:800;}
  .when{color:var(--muted);font-size:14px;margin:0;}
  .prog{margin-top:14px;display:flex;align-items:center;gap:10px;
    background:var(--panel);border:1px solid var(--line);border-radius:11px;padding:11px 13px;}
  .bar{flex:1;height:7px;border-radius:5px;background:var(--line);overflow:hidden;}
  .bar i{display:block;height:100%;width:0;background:var(--ok);border-radius:5px;
    transition:width .25s ease;}
  .prog b{font-size:13px;font-variant-numeric:tabular-nums;white-space:nowrap;color:var(--muted);font-weight:600;}

  .clip{background:var(--panel);border:1px solid var(--line);border-radius:15px;
    padding:13px;margin-bottom:15px;}
  .clip.posted{opacity:.5;}
  .vwrap{position:relative;border-radius:10px;overflow:hidden;background:#000;}
  video{display:block;width:100%;max-height:44vh;aspect-ratio:9/16;object-fit:contain;background:#000;}
  .rank{position:absolute;top:8px;left:8px;background:#000a;color:#fff;
    font-size:12px;font-weight:700;padding:3px 9px;border-radius:20px;backdrop-filter:blur(4px);}

  .meta{margin:11px 0 9px;}
  .hook{font-size:17px;font-weight:700;letter-spacing:-.015em;line-height:1.25;}
  .from{font-size:12.5px;color:var(--faint);margin-top:3px;
    font-variant-numeric:tabular-nums;}

  .cap{background:var(--panel2);border:1px solid var(--line);border-radius:9px;
    padding:10px 11px;font-size:13.5px;line-height:1.45;color:var(--muted);margin-bottom:11px;}
  .tags{display:block;margin-top:6px;color:var(--faint);font-size:12.5px;word-break:break-word;}

  .acts{display:grid;grid-template-columns:1fr 1fr;gap:9px;}
  .btn{display:flex;align-items:center;justify-content:center;min-height:46px;
    border-radius:10px;border:1px solid var(--line);background:var(--panel2);
    color:var(--ink);font-size:15px;font-weight:600;text-decoration:none;cursor:pointer;
    font-family:inherit;-webkit-tap-highlight-color:transparent;}
  .btn.primary{background:var(--go);border-color:var(--go);color:var(--paper);}
  .btn:active{transform:scale(.98);}
  .btn.copied{border-color:var(--ok);color:var(--ok);}

  .claim{display:block;margin-top:11px;}
  .claim span{display:block;font-size:12px;color:var(--faint);margin-bottom:5px;
    letter-spacing:.03em;}
  .claim input{width:100%;min-height:44px;padding:0 11px;border-radius:9px;
    border:1px solid var(--line);background:var(--panel2);color:var(--ink);
    font-size:15px;font-family:inherit;}
  .claim input:focus-visible,.btn:focus-visible,.done:focus-visible{
    outline:2px solid var(--go);outline-offset:2px;}

  .done{width:100%;min-height:44px;margin-top:10px;border-radius:10px;cursor:pointer;
    border:1px dashed var(--line);background:transparent;color:var(--muted);
    font-size:14px;font-weight:600;font-family:inherit;}
  .clip.posted .done{border-style:solid;border-color:var(--ok);color:var(--ok);}

  footer{margin-top:26px;padding-top:15px;border-top:1px solid var(--line);
    font-size:12.5px;color:var(--faint);line-height:1.55;}
  footer b{color:var(--muted);}
  @media (prefers-reduced-motion:reduce){*{transition:none!important;}}
</style>
</head>
<body>
<div class="wrap">

  <header>
    <div class="kicker">Ready to post</div>
    <h1>Today's drop</h1>
    <p class="when">${escHtml(nice)} · ${drop.clips.length} clips${cfg.campaign ? ' · ' + escHtml(cfg.campaign) : ''}</p>
    <div class="prog">
      <div class="bar"><i id="fill"></i></div>
      <b id="count">0 of ${drop.clips.length} done</b>
    </div>
  </header>

${cards}

  <footer>
    <b>Download → post → paste the link → mark done.</b> Progress is saved on this
    phone only, so the page picks up where you left off. A new drop replaces this
    one every morning — anything you didn't post is gone, so take the best three
    and don't agonise over the rest.
  </footer>

</div>
<script>
(function(){
  var KEY = 'clipdrop:${escHtml(drop.date)}';
  var state = {};
  try { state = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { state = {}; }

  function save(){ try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) {} }

  function paint(){
    var cards = document.querySelectorAll('.clip');
    var n = 0;
    cards.forEach(function(card){
      var id = card.dataset.id;
      var s = state[id] || {};
      if (s.done) { card.classList.add('posted'); n++; }
      else card.classList.remove('posted');
      var btn = card.querySelector('.done');
      btn.textContent = s.done ? 'Posted \\u2713' : 'Mark posted & claimed';
      var input = card.querySelector('input');
      if (s.link && !input.value) input.value = s.link;
    });
    document.getElementById('count').textContent = n + ' of ' + cards.length + ' done';
    document.getElementById('fill').style.width = (cards.length ? (n / cards.length) * 100 : 0) + '%';
  }

  document.addEventListener('click', function(e){
    var copy = e.target.closest('[data-copy]');
    if (copy) {
      var text = copy.getAttribute('data-copy');
      var after = function(){
        copy.classList.add('copied');
        copy.textContent = 'Copied \\u2713';
        setTimeout(function(){ copy.classList.remove('copied'); copy.textContent = 'Copy caption'; }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(after, fallback);
      } else fallback();
      function fallback(){
        var ta = document.createElement('textarea');
        ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
        document.body.appendChild(ta); ta.select();
        try { document.execCommand('copy'); after(); } catch (err) {}
        document.body.removeChild(ta);
      }
      return;
    }
    var done = e.target.closest('[data-done]');
    if (done) {
      var id = done.getAttribute('data-done');
      state[id] = state[id] || {};
      state[id].done = !state[id].done;
      save(); paint();
    }
  });

  document.addEventListener('input', function(e){
    if (e.target.tagName !== 'INPUT') return;
    var card = e.target.closest('.clip');
    if (!card) return;
    state[card.dataset.id] = state[card.dataset.id] || {};
    state[card.dataset.id].link = e.target.value;
    save();
  });

  paint();
})();
</script>
</body>
</html>`;
}


// ==========================================================
// 5. RUN
// ==========================================================
// run.mjs — the nightly job. Everything between "a creator uploaded something"
// and "five clips are waiting on your phone".
//
//   node src/run.mjs            normal run
//   node src/run.mjs --dry      pick moments and write copy, render nothing
//
// Designed to degrade rather than halt: one dead video or one failed render
// must not cost you the whole morning's drop.


const ROOT = import.meta.dirname;
const cfg = JSON.parse(readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
const DRY = process.argv.includes('--dry');

const today = new Date().toISOString().slice(0, 10);
const OUT = path.join(ROOT, 'docs', 'clips');
const WORK = path.join(ROOT, '.work');

const log = (...a) => console.log('·', ...a);
const warn = (...a) => console.log('!', ...a);

// YouTube bot-blocks datacentre IP ranges, and CI runners live in exactly those
// ranges. The failure is per-video and looks like an ordinary skip, so without
// naming it here a blocked run reads as "that channel had no good moments".
const BOT_BLOCKED = /Sign in to confirm|not a bot|confirm your age|cookies/i;
let botBlocks = 0;

async function fromYouTube(source, budget) {
  const picked = [];
  const videos = await recentVideos(source.channel, source.scanVideos ?? 5);
  log(`${source.name}: ${videos.length} recent videos`);

  for (const v of videos) {
    if (picked.length >= budget) break;
    let detail;
    try { detail = await videoDetail(v.url); }
    catch (e) {
      if (BOT_BLOCKED.test(e.message)) { botBlocks++; warn(`skip ${v.id}: blocked by YouTube (bot check)`); }
      else warn(`skip ${v.id}: ${e.message}`);
      continue;
    }

    const { ok, reason, moments } = momentsFromHeatmap(detail, {
      want: budget - picked.length,
      clipSeconds: cfg.clipSeconds ?? 24,
      skipTop: cfg.skipTopPeaks ?? 3,
    });
    if (!ok) { warn(`skip "${v.title.slice(0, 50)}": ${reason}`); continue; }

    log(`  "${v.title.slice(0, 50)}" → ${moments.length} moments`);
    for (const m of moments) {
      picked.push({
        kind: 'youtube',
        sourceName: source.name,
        sourceUrl: v.url,
        title: v.title,
        subject: source.subject || source.name,
        niche: source.niche || cfg.niche || 'generic',
        start: m.timecode,
        seconds: m.seconds,
        intensity: m.intensity,
        mode: source.mode || cfg.mode || 'crop',
      });
    }
  }
  return picked;
}

async function fromTwitch(source, budget) {
  const id = process.env.TWITCH_CLIENT_ID;
  const secret = process.env.TWITCH_CLIENT_SECRET;
  if (!id || !secret) { warn(`${source.name}: twitch keys not set, skipping`); return []; }

  const clips = await twitchTopClips({
    clientId: id, clientSecret: secret,
    login: source.channel, sinceDays: source.sinceDays ?? 7, want: budget,
  });
  log(`${source.name}: ${clips.length} community clips`);
  return clips.map((c) => ({
    kind: 'twitch',
    sourceName: source.name,
    sourceUrl: c.url,
    title: c.title,
    subject: source.subject || c.creator,
    niche: source.niche || cfg.niche || 'generic',
    start: null,
    seconds: Math.min(c.seconds, cfg.clipSeconds ?? 24),
    intensity: c.views,
    mode: source.mode || cfg.mode || 'crop',
  }));
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  mkdirSync(WORK, { recursive: true });

  const want = cfg.clipsPerDrop ?? 5;
  const perSource = Math.max(1, Math.ceil(want / Math.max(1, cfg.sources.length)));

  // ── 1. find moments ────────────────────────────────────────
  let candidates = [];
  for (const source of cfg.sources) {
    if (source.enabled === false) continue;
    try {
      const got = source.platform === 'twitch'
        ? await fromTwitch(source, perSource)
        : await fromYouTube(source, perSource);
      candidates.push(...got);
    } catch (e) {
      warn(`${source.name} failed entirely: ${e.message}`);
    }
  }

  if (!candidates.length) {
    // Exit non-zero. Exiting 0 here made the run go GREEN while producing
    // nothing, which is the worst possible outcome: the page silently keeps
    // yesterday's clips and you only find out when you go to post.
    if (botBlocks) {
      warn(`\nBLOCKED: YouTube refused ${botBlocks} of ${botBlocks} video lookups with its bot check.`);
      warn('This is the datacentre IP, not the channel. CI runners sit in ranges');
      warn('YouTube rejects. A Twitch source uses an official API and is unaffected.');
    } else {
      warn('\nNo moments found from any source — nothing to publish today.');
    }
    process.exit(1);
  }

  // Interleave sources so a drop is never five clips from one creator.
  candidates = interleave(candidates, (c) => c.sourceName).slice(0, want);
  log(`${candidates.length} candidates selected`);

  // ── 2. copy ────────────────────────────────────────────────
  const withCopy = [];
  for (const [i, c] of candidates.entries()) {
    const copy = await writeCopy({ title: c.title, subject: c.subject, niche: c.niche, index: i });
    withCopy.push({ ...c, ...copy });
  }
  log(`copy written (${withCopy[0]?.source === 'ai' ? 'ai' : 'no key — using built-in hooks'})`);

  if (DRY) {
    console.log(JSON.stringify(withCopy, null, 2));
    return;
  }

  // ── 3. render ──────────────────────────────────────────────
  const done = [];
  for (const [i, c] of withCopy.entries()) {
    const slug = `${today}-${String(i + 1).padStart(2, '0')}`;
    const raw = path.join(WORK, `${slug}-raw.mp4`);
    const fin = path.join(OUT, `${slug}.mp4`);
    try {
      log(`[${i + 1}/${withCopy.length}] ${c.sourceName} — ${c.start || 'full clip'}`);
      if (c.kind === 'twitch') await fetchWhole({ url: c.sourceUrl, out: raw });
      else await fetchSlice({ url: c.sourceUrl, start: c.start, seconds: c.seconds, out: raw });

      const { size } = await toVertical({
        input: raw, out: fin, hook: c.hook, mode: c.mode, seconds: c.seconds,
      });
      done.push({ ...c, file: `clips/${slug}.mp4`, sizeMb: +(size / 1048576).toFixed(1) });
      log(`    ok — ${(size / 1048576).toFixed(1)} MB`);
    } catch (e) {
      warn(`    failed: ${e.message}`);
    } finally {
      if (existsSync(raw)) rmSync(raw, { force: true });
    }
  }

  if (!done.length) {
    warn('every render failed — yesterday\'s drop stays up rather than publishing an empty page');
    process.exit(1);
  }

  // ── 4. publish ─────────────────────────────────────────────
  const drop = { date: today, generatedAt: new Date().toISOString(), clips: done };
  writeFileSync(path.join(ROOT, 'docs', 'drop.json'), JSON.stringify(drop, null, 2));
  writeFileSync(path.join(ROOT, 'docs', 'index.html'), buildPage(drop, cfg));
  rmSync(WORK, { recursive: true, force: true });

  log(`\ndrop ready: ${done.length} clips`);
}

/** Round-robin across a key so one noisy source can't dominate the drop. */
function interleave(items, keyOf) {
  const buckets = new Map();
  for (const it of items) {
    const k = keyOf(it);
    if (!buckets.has(k)) buckets.set(k, []);
    buckets.get(k).push(it);
  }
  const lists = [...buckets.values()];
  const out = [];
  for (let i = 0; out.length < items.length; i++) {
    let moved = false;
    for (const l of lists) if (l[i] !== undefined) { out.push(l[i]); moved = true; }
    if (!moved) break;
  }
  return out;
}

main().catch((e) => { console.error('fatal:', e); process.exit(1); });


// produce.mjs — make an episode from a one-line idea, locally, for nothing.
//
//   node produce.mjs "The leaf bouquet"
//   node produce.mjs --list          show the episode backlog
//   node produce.mjs --dry "Rain"    write the shot list, generate nothing
//   node produce.mjs "Rain" --assemble --picks 2,1,3,1,2 [--motion video]
//   node produce.mjs "Rain" --pack --picks 2,1,3,1,2   upload pack for Kling / Kaggle
//   node produce.mjs "Rain" --assemble --motion clips  join the clips that came back
//
// The chain:
//   idea → shot list (LLM) → stills (Draw Things, local) → motion + music
//   (ffmpeg) → inbox-koala → ClipDrop captions and queues it
//
// Nothing here calls a paid video model. Stills are generated locally by
// draw-things-cli and given motion with ffmpeg's zoompan — the slow push-in
// that most of this genre actually uses.
//
// --motion video swaps the push-in for real animation: each chosen still is
// handed to a local image-to-video model as its first frame, so the koalas
// move but stay the koalas you picked. Slow (minutes per shot) but free.
// Any shot the video model fails on falls back to the push-in, so an
// overnight run always finishes with a watchable episode.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, copyFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

const run = promisify(execFile);
const BIG = { maxBuffer: 64 * 1024 * 1024 };
const ROOT = import.meta.dirname;
const OUT = path.join(ROOT, 'inbox-koala');
const WORKROOT = path.join(ROOT, '.produce');
const PACKS = path.join(ROOT, 'packs');
const slugify = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);

const log = (...a) => console.log('·', ...a);
const warn = (...a) => console.log('!', ...a);

const bible = () => JSON.parse(readFileSync(path.join(ROOT, 'characters.json'), 'utf8'));

// ── shot list ─────────────────────────────────────────────────

/**
 * Deterministic fallback: five beats, always the same shape. The structure is
 * the format — an episode is not improved by inventing a new structure for it,
 * and this way a missing API key costs you nothing.
 */
function fallbackShots(idea, b) {
  const [a, w] = b.characters.map((c) => c.name);
  return [
    { shot: 'wide', seconds: 4, scene: `${a} and ${w} in the grove, ${idea.toLowerCase()} just beginning. Establishing wide.`,
      action: 'leaves sway gently, both koalas look around, slow camera push-in' },
    { shot: 'medium', seconds: 5, scene: `${a} sets about it with total seriousness. ${w} watches.`,
      action: `${a} busily works with his paws, ${w} tilts her head and blinks` },
    { shot: 'close', seconds: 5, scene: `It goes slightly wrong. ${a}'s face falls.`,
      action: `${a}'s ears droop and his eyes go wide and sad` },
    { shot: 'two-shot', seconds: 6, scene: `${w} reacts with warmth, not annoyance. She was always going to.`,
      action: `${w} smiles softly and leans in to hug ${a}` },
    { shot: 'close', seconds: 5, scene: `The two of them settled and content. Hold on this.`,
      action: 'both koalas snuggle and close their eyes contentedly, gentle breathing' },
  ];
}

async function writeShots(idea, b) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) { log('no API key — using the standard five beats'); return fallbackShots(idea, b); }

  const [a, w] = b.characters.map((c) => c.name);
  const prompt = `Episode idea: "${idea}"

Characters: ${a} (${b.characters[0].personality}) and ${w} (${b.characters[1].personality}).
Setting: ${b.world}

Write a 5-shot silent episode, 25 seconds total. The beats are fixed:
1. Open mid-situation  2. The small want  3. It goes slightly wrong
4. ${w}'s warm reaction  5. Hold on the last frame

Reply with JSON only:
[{"shot":"wide|medium|close|two-shot","seconds":4,"scene":"what we see, one sentence","action":"the one movement that happens during the shot, a short phrase"}]

Rules: no dialogue, no text on screen, tiny stakes, warmth not slapstick.
Describe only what is VISIBLE. Each action is one simple, gentle movement
(a head tilt, a hug, a blink, ears drooping) — video models fail on complex action. Never restate the characters' appearance — that
is handled separately and repeating it causes drift.`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: process.env.CLIPDROP_MODEL || 'claude-sonnet-5',
        max_tokens: 1200,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: AbortSignal.timeout(90000),
    });
    if (!res.ok) throw new Error(`api_${res.status}`);
    const text = (await res.json()).content?.[0]?.text || '';
    const m = text.match(/\[[\s\S]*\]/);
    const shots = m ? JSON.parse(m[0]) : null;
    if (!Array.isArray(shots) || shots.length < 3) throw new Error('unusable shot list');
    return shots.slice(0, 6).map((s) => ({
      shot: s.shot || 'medium',
      seconds: Math.min(8, Math.max(3, Number(s.seconds) || 5)),
      scene: String(s.scene || '').slice(0, 300),
      action: String(s.action || '').slice(0, 200),
    }));
  } catch (e) {
    warn(`shot list failed (${e.message}) — using the standard five beats`);
    return fallbackShots(idea, b);
  }
}

// ── prompts ───────────────────────────────────────────────────

const FRAMING = {
  wide: 'wide establishing shot, full bodies visible, lots of environment',
  medium: 'medium shot, waist up',
  close: 'close-up on the face, shallow depth of field',
  'two-shot': 'two-shot, both characters in frame, chest up',
};

/**
 * The character block is pasted verbatim every time and never paraphrased.
 * Rewording it between shots is the single biggest cause of characters drifting
 * into different animals over a series.
 */
function promptFor(shot, b) {
  const chars = b.characters.map((c) => `${c.name.toUpperCase()}: ${c.prompt}`).join('\n\n');
  return [
    b.style,
    '',
    chars,
    '',
    `WORLD: ${b.world}`,
    '',
    `SHOT: ${FRAMING[shot.shot] || FRAMING.medium}. ${shot.scene}`,
    '',
    'No text, no watermark, no humans, no speech bubbles.',
  ].join('\n');
}

// ── stills ────────────────────────────────────────────────────

async function haveCli() {
  try { await run('which', ['draw-things-cli']); return true; } catch { return false; }
}

/**
 * Every generation parameter is pinned, not left to whatever the tool defaults
 * to. Steps, guidance, sampler and model version all change the look, and a
 * default that shifts under you in an app update makes episode 40 quietly
 * different from episode 1 with nothing in your own setup having changed.
 */
async function generateStill(prompt, out, b, seed) {
  // Flags match `draw-things-cli generate --help` (v1.20260430). Anything left
  // unset falls back to the model's own recommended settings, which matters:
  // distilled models like FLUX.2 klein want few steps and low CFG, and forcing
  // SDXL-style numbers on them produces mush.
  const args = [
    'generate',
    '--model', b.model || 'flux_2_klein_4b_q6p.ckpt',
    '--prompt', prompt,
    '--negative-prompt', b.negative || 'text, watermark, human, blurry, deformed, extra limbs',
    '--width', String(b.width || 768),
    '--height', String(b.height || 1344),
    '--output', out,
    '--disable-preview',
  ];
  if (b.steps) args.push('--steps', String(b.steps));
  if (b.guidance) args.push('--cfg', String(b.guidance));
  // No --lora flag exists; LoRAs go in as a JSON override. `version` is needed
  // for a LoRA trained locally and not registered with the app.
  if (b.lora) args.push('--config-json', JSON.stringify({
    loras: [{ file: b.lora, weight: b.loraWeight ?? 1, ...(b.loraVersion ? { version: b.loraVersion } : {}) }],
  }));
  if (Number.isFinite(seed)) args.push('--seed', String(seed));
  await run('draw-things-cli', args, BIG);
  if (!existsSync(out)) throw new Error('no image produced');
  return out;
}

/** A contact sheet to judge from. Picking a still takes seconds; discovering a
 *  bad one after it has been animated and assembled does not. */
function contactSheet(shots, variants, dir, idea) {
  const rows = shots.map((sh, i) => `
    <section>
      <h2><span>${i + 1}</span> ${sh.shot} · ${sh.seconds}s</h2>
      <p>${sh.scene.replace(/[<&]/g, '')}</p>
      <div class="grid">
        ${Array.from({ length: variants }, (_, v) => `
          <figure><img src="shot${i + 1}-v${v + 1}.png" alt="option ${v + 1}">
          <figcaption>${v + 1}</figcaption></figure>`).join('')}
      </div>
    </section>`).join('');

  return `<!doctype html><meta charset="utf-8"><title>${idea} — pick</title>
<style>
 body{margin:0;background:#12160f;color:#e8efe4;font:15px/1.5 -apple-system,system-ui,sans-serif;padding:26px}
 h1{font-size:23px;margin:0 0 4px} .lede{color:#9db08f;margin:0 0 26px;font-size:14px}
 section{margin-bottom:30px;border-top:1px solid #2a3524;padding-top:16px}
 h2{font-size:14px;margin:0 0 3px;color:#b9cfa8;text-transform:uppercase;letter-spacing:.06em}
 h2 span{display:inline-block;background:#3d5230;color:#dff0d0;border-radius:6px;padding:1px 8px;margin-right:7px}
 section p{color:#9db08f;font-size:13.5px;margin:0 0 12px}
 .grid{display:flex;gap:12px;flex-wrap:wrap}
 figure{margin:0;position:relative}
 img{height:330px;border-radius:9px;display:block;background:#000}
 figcaption{position:absolute;top:8px;left:8px;background:#000c;color:#fff;
   font:600 13px ui-monospace,monospace;padding:3px 9px;border-radius:14px}
 footer{color:#9db08f;font-size:13.5px;border-top:1px solid #2a3524;padding-top:16px;line-height:1.7}
 code{background:#222c1c;padding:2px 7px;border-radius:5px;font-size:13px;color:#dff0d0}
</style>
<h1>${idea}</h1>
<p class="lede">Pick the best option for each shot, then assemble only those.</p>
${rows}
<footer>Note one number per shot, top to bottom, then run:<br><br>
<code>node produce.mjs "${idea}" --assemble --picks ${shots.map(() => '1').join(',')}</code><br><br>
Nothing is animated until you do — a bad still costs seconds to reject here and
minutes to discover after assembly.</footer>`;
}

// ── motion ────────────────────────────────────────────────────

/**
 * A slow push-in on a still. Not as good as a real video model, but it is what
 * a lot of this genre actually is, it renders in seconds rather than minutes,
 * and it costs nothing. `d` must equal the output frame count or zoompan loops.
 */
function kenBurns(seconds, fps, direction) {
  const frames = Math.round(seconds * fps);
  const zoom = direction === 'out'
    ? `max(1.12-on/${frames}*0.12,1.0)`
    : `min(1.0+on/${frames}*0.12,1.12)`;
  return [
    `scale=2160:3840:force_original_aspect_ratio=increase`,
    `crop=2160:3840`,
    `zoompan=z='${zoom}':d=${frames}:x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)':s=1080x1920:fps=${fps}`,
    `setsar=1`,
  ].join(',');
}

/** Frame counts video models accept are 8n+1 (LTX) / 4n+1 (Wan); 8n+1 fits both.
 *  Capped because frames are what eat memory — on a 16 GB Mac ~81 is the limit. */
const videoFrames = (seconds, fps, max = 81) => Math.min(max, Math.max(25, Math.round(seconds * fps / 8) * 8 + 1));

/**
 * Real motion: the chosen still becomes the first frame of a short generated
 * clip, then ffmpeg brings it to 1080x1920 at 30fps and exactly `seconds` long
 * (holding the last frame if the model returned less). Audio is dropped —
 * some video models invent a soundtrack, and music is added at assembly.
 */
async function videoClip(still, shot, out, b, i) {
  const raw = out.replace(/\.mp4$/, '-raw.mp4');
  const fps = b.videoFps || 24;
  const action = shot.action || shot.scene;
  const frames = videoFrames(shot.seconds, fps, b.videoMaxFrames || 81);
  // If the model's clip is shorter than the shot, ease it into gentle slow
  // motion (up to 1.5x) before holding the last frame — cute content suits it,
  // and a long freeze reads as a glitch.
  const stretch = Math.min(1.5, Math.max(1, shot.seconds / (frames / fps)));
  const prompt = `${b.style} ${action}. Smooth, gentle, expressive character animation, stable camera, consistent characters.`;
  const args = [
    'generate',
    '--model', b.videoModel,
    '--image', still,
    '--prompt', prompt,
    '--negative-prompt', b.negative || '',
    '--width', String(b.videoWidth || 512),
    '--height', String(b.videoHeight || 896),
    '--frames', String(frames),
    '--output', raw,
    '--disable-preview',
  ];
  if (b.videoStrength) args.push('--strength', String(b.videoStrength));
  if (Number.isFinite(b.seed)) args.push('--seed', String(b.seed + i));
  await run('draw-things-cli', args, { ...BIG, timeout: 60 * 60 * 1000 });
  if (!existsSync(raw)) throw new Error('video model produced nothing');

  await normalise(raw, shot.seconds, out, stretch);
  rmSync(raw, { force: true });
  return out;
}

async function durationOf(file) {
  try {
    const { stdout } = await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1', file]);
    return Number(stdout.trim()) || 0;
  } catch { return 0; }
}

/**
 * Any generated clip → 1080x1920, 30fps, exactly `seconds` long, silent, and
 * encoded identically to the push-in clips so the concat step can stream-copy.
 * A clip shorter than the shot eases into slow motion (≤1.5x) and then holds
 * its last frame; a longer one is trimmed.
 */
async function normalise(raw, seconds, out, stretch) {
  if (!stretch) {
    const dur = await durationOf(raw);
    stretch = dur ? Math.min(1.5, Math.max(1, seconds / dur)) : 1;
  }
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-i', raw,
    '-vf', `scale=1080:1920:force_original_aspect_ratio=increase:flags=lanczos,crop=1080:1920,setpts=${stretch.toFixed(3)}*PTS,fps=30,tpad=stop_mode=clone:stop_duration=${seconds},setsar=1`,
    '-t', String(seconds), '-an',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '18', '-pix_fmt', 'yuv420p',
    '-y', out,
  ], BIG);
  if (!existsSync(out)) throw new Error('could not normalise video clip');
  return out;
}

// ── packs: hand-off to an outside video model ─────────────────
//
// A pack is a plain folder, packs/<episode>/, holding the chosen stills and one
// motion prompt per shot. Two things fill it with clips: you (upload to Kling's
// site, drop the downloads back in) or kaggle-run.sh (free cloud GPU). Either
// way `--assemble --motion clips` picks them up, so the routes are swappable.

const VIDEO_EXT = /\.(mp4|mov|m4v|webm)$/i;

/** Only the movement: an image-to-video model already sees the koalas, and
 *  re-describing them invites it to redraw them. */
function motionPrompt(shot) {
  const action = (shot.action || shot.scene).replace(/\.$/, '');
  return `${action}. Gentle, cute Pixar-style 3D animation, smooth natural movement, `
    + 'the characters keep exactly the same look as in the image, soft slow camera push-in.';
}
const MOTION_NEGATIVE = 'morphing, changing face, distorted face, extra limbs, extra ears, realistic, photographic, '
  + 'scary, horror, creepy teeth, flicker, text, watermark';

function packHtml(idea, entries) {
  const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const cards = entries.map((e) => `
  <section>
    <h2>Shot ${e.n} <small>${e.seconds}s · 5s in Kling</small></h2>
    <img src="${e.image}" alt="shot ${e.n}">
    <label>Prompt</label>
    <textarea readonly rows="4">${esc(e.prompt)}</textarea>
    <button onclick="cp(this)">Copy prompt</button>
    <p class="save">Save the download as <b>shot${e.n}.mp4</b> in this folder (or just download them in order).</p>
  </section>`).join('');
  return `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Upload pack · ${esc(idea)}</title>
<style>
:root{--bg:#f3f5f1;--card:#fff;--ink:#1c2a22;--muted:#5b6b61;--line:#d6ded4;--acc:#4f7355}
@media (prefers-color-scheme:dark){:root{--bg:#0f1512;--card:#18211c;--ink:#e7eee8;--muted:#9fb1a5;--line:#2b3a31;--acc:#8cba91}}
body{margin:0;background:var(--bg);color:var(--ink);font:16px/1.5 -apple-system,system-ui,sans-serif;padding:20px 16px 60px}
main{max-width:620px;margin:auto}h1{margin:.2em 0}ol{padding-left:1.2em;color:var(--muted)}
section{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px;margin:16px 0}
h2{margin:0 0 10px;font-size:18px}small{color:var(--muted);font-weight:500}
img{width:100%;max-width:260px;border-radius:10px;display:block;margin-bottom:10px}
label{font-size:12px;text-transform:uppercase;letter-spacing:.08em;color:var(--muted);font-weight:700}
textarea{width:100%;box-sizing:border-box;font:inherit;font-size:14px;padding:10px;border-radius:9px;border:1px solid var(--line);background:var(--bg);color:var(--ink)}
button{margin-top:8px;background:var(--acc);color:var(--card);border:0;border-radius:9px;padding:10px 16px;font:inherit;font-weight:700;cursor:pointer}
.save{font-size:13px;color:var(--muted);margin:10px 0 0}
.neg{font-size:14px}
</style><main>
<h1>${esc(idea)}</h1>
<ol>
  <li>Open <b>klingai.com</b> → Video → <b>Image to Video</b>.</li>
  <li>For each shot: upload the picture, paste its prompt, length <b>5s</b>, the free/standard mode.</li>
  <li>Paste the negative prompt below into "Negative prompt" (under advanced settings) every time.</li>
  <li>Download each result into this folder: <code>packs/${esc(path.basename(entries.dir || ''))}</code>.</li>
  <li>Then in Terminal: <code>node produce.mjs "${esc(idea)}" --assemble --motion clips</code></li>
</ol>
<section class="neg"><h2>Negative prompt <small>same for every shot</small></h2>
<textarea readonly rows="3">${esc(MOTION_NEGATIVE)}</textarea><button onclick="cp(this)">Copy</button></section>
${cards}
</main>
<script>
function cp(btn){const t=btn.previousElementSibling;t.select();
  const done=()=>{btn.textContent='Copied ✓';setTimeout(()=>btn.textContent='Copy prompt',1500)};
  if(navigator.clipboard&&window.isSecureContext){navigator.clipboard.writeText(t.value).then(done,()=>{document.execCommand('copy');done()})}
  else{document.execCommand('copy');done()}}
</script>`;
}

function makePack(idea, slug, shots, picks, work) {
  const dir = path.join(PACKS, slug);
  mkdirSync(dir, { recursive: true });
  const entries = [];
  for (const [i, shot] of shots.entries()) {
    const still = path.join(work, `shot${i + 1}-v${picks[i]}.png`);
    if (!existsSync(still)) { warn(`missing ${path.basename(still)} — shot ${i + 1} left out of the pack`); continue; }
    const image = `shot${i + 1}.png`;
    copyFileSync(still, path.join(dir, image));
    entries.push({ n: i + 1, image, seconds: shot.seconds, prompt: motionPrompt(shot), negative: MOTION_NEGATIVE });
  }
  entries.dir = dir;
  writeFileSync(path.join(dir, 'prompts.json'), JSON.stringify({ idea, slug, shots: entries }, null, 2));
  writeFileSync(path.join(dir, 'pack.html'), packHtml(idea, entries));
  return { dir, entries };
}

/** Match clips to shots: a file named like shot3 / shot_3 goes to shot 3; any
 *  other videos (Kling's own names) fill the remaining shots in download order. */
function clipsInPack(dir, count) {
  if (!existsSync(dir)) return [];
  const vids = readdirSync(dir).filter((f) => VIDEO_EXT.test(f)).map((f) => path.join(dir, f));
  const byShot = new Array(count).fill(null);
  const loose = [];
  for (const f of vids) {
    const m = path.basename(f).match(/shot[ _-]?(\d+)/i);
    const n = m ? Number(m[1]) : 0;
    if (n >= 1 && n <= count && !byShot[n - 1]) byShot[n - 1] = f; else loose.push(f);
  }
  loose.sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs);
  for (let i = 0; i < count && loose.length; i++) if (!byShot[i]) byShot[i] = loose.shift();
  if (loose.length) warn(`${loose.length} extra video(s) in the pack were not used`);
  return byShot;
}

async function shotToClip(still, seconds, out, i) {
  const fps = 30;
  await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error',
    '-loop', '1', '-i', still,
    '-vf', kenBurns(seconds, fps, i % 2 ? 'out' : 'in'),
    '-t', String(seconds),
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-pix_fmt', 'yuv420p',
    '-y', out,
  ], BIG);
  if (!existsSync(out)) throw new Error(`could not animate shot ${i + 1}`);
  return out;
}

async function assemble(clips, music, out, work) {
  const list = path.join(work, 'list.txt');
  writeFileSync(list, clips.map((c) => `file '${c}'`).join('\n'));

  const joined = path.join(work, 'joined.mp4');
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error',
    '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-y', joined], BIG);

  if (!music || !existsSync(music)) {
    await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', joined,
      '-c', 'copy', '-movflags', '+faststart', '-y', out], BIG);
    return { out, music: false };
  }

  // -shortest so a long track doesn't stretch the video past its last frame.
  await run('ffmpeg', ['-hide_banner', '-loglevel', 'error',
    '-i', joined, '-i', music,
    '-map', '0:v', '-map', '1:a',
    '-c:v', 'copy', '-c:a', 'aac', '-b:a', '160k',
    '-af', 'afade=t=in:st=0:d=1,afade=t=out:st=20:d=3',
    '-shortest', '-movflags', '+faststart', '-y', out], BIG);
  return { out, music: true };
}

// ── run ───────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const flag = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : null; };
  const b = bible();

  if (args.includes('--list')) {
    b.episodes.forEach((e, i) => console.log(`${String(i + 1).padStart(2)}. ${e}`));
    return;
  }

  const idea = args.filter((a, i) => !a.startsWith('--') && !String(args[i - 1] || '').startsWith('--'))[0]
    || b.episodes[Math.floor(Math.random() * b.episodes.length)];

  const slug = slugify(idea);
  const WORK = path.join(WORKROOT, slug);
  const shotFile = path.join(WORK, 'shots.json');
  const assemble_ = args.includes('--assemble');
  const pack_ = args.includes('--pack');
  const dry = args.includes('--dry');
  const variants = Math.min(4, Math.max(1, Number(flag('--variants')) || 1));

  log(`episode: ${idea}`);
  mkdirSync(WORK, { recursive: true });
  mkdirSync(OUT, { recursive: true });

  // Reuse the shot list on the assemble pass. Re-asking the model would give a
  // different episode from the one whose stills are sitting on disk.
  let shots;
  if ((assemble_ || pack_) && existsSync(shotFile)) {
    shots = JSON.parse(readFileSync(shotFile, 'utf8'));
    log(`${shots.length} shots (from the earlier run)`);
  } else {
    shots = await writeShots(idea, b);
    writeFileSync(shotFile, JSON.stringify(shots, null, 2));
    log(`${shots.length} shots, ${shots.reduce((a, s) => a + s.seconds, 0)}s total`);
    shots.forEach((s, i) => log(`  ${i + 1}. [${s.shot}] ${s.scene}`));
  }

  if (dry) {
    console.log('\n--- prompt for shot 1 ---\n');
    console.log(promptFor(shots[0], b));
    return;
  }

  const motion = flag('--motion') || b.motion || 'kenburns';
  const packDir = path.join(PACKS, slug);
  const readPicks = () => {
    const picks = String(flag('--picks') || '').split(',').map((n) => Number(n.trim()));
    if (picks.length !== shots.length || picks.some((n) => !Number.isFinite(n) || n < 1)) {
      warn(`--picks needs ${shots.length} numbers, one per shot. e.g. --picks ${shots.map(() => 1).join(',')}`);
      process.exit(1);
    }
    return picks;
  };

  // ── pack pass: stills + motion prompts for Kling or Kaggle ──
  if (pack_) {
    const { dir, entries } = makePack(idea, slug, shots, readPicks(), WORK);
    log(`\npack ready: packs/${slug}/  (${entries.length} shots)`);
    log('Kling by hand: follow pack.html.   Free cloud GPU: ./kaggle-run.sh ' + slug);
    log(`Then: node produce.mjs "${idea}" --assemble --motion clips`);
    if (process.platform === 'darwin') run('open', [path.join(dir, 'pack.html')]).catch(() => {});
    return;
  }

  // ── assemble pass: animate the chosen stills ────────────────
  if (assemble_) {
    // With --motion clips the stills come from the pack, so picks are already made.
    const picks = motion === 'clips' ? null : readPicks();
    const stillFor = (i) => (picks ? path.join(WORK, `shot${i + 1}-v${picks[i]}.png`) : path.join(packDir, `shot${i + 1}.png`));
    const packed = motion === 'clips' ? clipsInPack(packDir, shots.length) : [];
    if (motion === 'clips') {
      const have = packed.filter(Boolean).length;
      if (!have) { warn(`no video clips in packs/${slug}/ yet — download them there first`); process.exit(1); }
      log(`${have}/${shots.length} clips found in packs/${slug}/${have < shots.length ? ' — the rest get the push-in' : ''}`);
    }

    if (motion === 'video') {
      if (!b.videoModel) { warn('--motion video needs "videoModel" set in characters.json'); process.exit(1); }
      log(`real motion with ${b.videoModel} — minutes per shot; leave it plugged in`);
    }

    const clips = [];
    for (const [i, shot] of shots.entries()) {
      const still = stillFor(i);
      const clip = path.join(WORK, `clip${i + 1}.mp4`);
      if (packed[i]) {
        try {
          log(`[${i + 1}/${shots.length}] ${path.basename(packed[i])} · ${shot.seconds}s`);
          clips.push(await normalise(packed[i], shot.seconds, clip));
          continue;
        } catch (e) { warn(`  clip for shot ${i + 1} unreadable (${e.message}) — using the push-in`); }
      }
      if (!existsSync(still)) { warn(`missing ${path.basename(still)} — skipping shot ${i + 1}`); continue; }
      try {
        log(`[${i + 1}/${shots.length}] ${picks ? `animating option ${picks[i]}` : 'push-in'} · ${shot.seconds}s`);
        if (motion === 'video') {
          try { await videoClip(still, shot, clip, b, i); }
          catch (e) {
            warn(`  video failed (${String(e.message).split('\n')[0].slice(0, 160)}) — using the push-in for this shot`);
            await shotToClip(still, shot.seconds, clip, i);
          }
        } else {
          await shotToClip(still, shot.seconds, clip, i);
        }
        clips.push(clip);
      } catch (e) { warn(`  shot ${i + 1} failed: ${e.message}`); }
    }
    if (clips.length < 2) { warn('\nToo few shots to assemble.'); process.exit(1); }

    const final = path.join(OUT, `${slug}.mp4`);
    const music = b.music && existsSync(path.join(ROOT, b.music)) ? path.join(ROOT, b.music) : null;
    const r = await assemble(clips, music, final, WORK);
    // Keep the stills and shot list so the episode can be re-cut or re-animated
    // (e.g. with --motion video) without regenerating; drop only the clips.
    for (const f of [...clips, path.join(WORK, 'joined.mp4'), path.join(WORK, 'list.txt')]) rmSync(f, { force: true });
    log(`\ndone: inbox-koala/${path.basename(final)}${r.music ? '' : '  (no music — see music/README.txt)'}`);
    log('Open ClipDrop and it will caption and queue it.');
    return;
  }

  // ── generate pass: stills only ──────────────────────────────
  if (!(await haveCli())) {
    warn('\ndraw-things-cli not found. Install it with:');
    warn('  brew install drawthingsai/draw-things/draw-things-cli');
    process.exit(1);
  }

  let made = 0;
  for (const [i, shot] of shots.entries()) {
    const prompt = promptFor(shot, b);
    for (let v = 0; v < variants; v++) {
      const out = path.join(WORK, `shot${i + 1}-v${v + 1}.png`);
      try {
        log(`[${i + 1}/${shots.length}] still ${v + 1}/${variants}…`);
        // A seed derived from the episode and shot, so a re-run reproduces the
        // same images rather than a fresh roll of the dice.
        const seed = b.seed ? b.seed + i * 100 + v : undefined;
        await generateStill(prompt, out, b, seed);
        made++;
      } catch (e) { warn(`  failed: ${e.message}`); }
    }
  }

  if (!made) { warn('\nNothing generated.'); process.exit(1); }

  const sheet = path.join(WORK, 'pick.html');
  writeFileSync(sheet, contactSheet(shots, variants, WORK, idea));
  log(`\n${made} still(s) generated.`);
  log(`Review them:  open ${path.relative(ROOT, sheet)}`);
  log(`Then assemble: node produce.mjs "${idea}" --assemble --picks ${shots.map(() => 1).join(',')}`);
}

main().catch((e) => { console.error('fatal:', e.message); process.exit(1); });

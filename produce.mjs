// produce.mjs — make an episode from a one-line idea, locally, for nothing.
//
//   node produce.mjs "The leaf bouquet"
//   node produce.mjs --list          show the episode backlog
//   node produce.mjs --dry "Rain"    write the shot list, generate nothing
//
// The chain:
//   idea → shot list (LLM) → stills (Draw Things, local) → motion + music
//   (ffmpeg) → inbox-koala → ClipDrop captions and queues it
//
// Nothing here calls a paid video model. Stills are generated locally by
// draw-things-cli and given motion with ffmpeg's zoompan — the slow push-in
// that most of this genre actually uses. A true image-to-video model looks
// better and costs either money or ~7 minutes per 4 seconds locally; this
// costs neither, and you can upgrade one shot at a time later.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';

const run = promisify(execFile);
const BIG = { maxBuffer: 64 * 1024 * 1024 };
const ROOT = import.meta.dirname;
const OUT = path.join(ROOT, 'inbox-koala');
const WORK = path.join(ROOT, '.produce');

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
    { shot: 'wide', seconds: 4, scene: `${a} and ${w} in the grove, ${idea.toLowerCase()} just beginning. Establishing wide.` },
    { shot: 'medium', seconds: 5, scene: `${a} sets about it with total seriousness. ${w} watches.` },
    { shot: 'close', seconds: 5, scene: `It goes slightly wrong. ${a}'s face falls.` },
    { shot: 'two-shot', seconds: 6, scene: `${w} reacts with warmth, not annoyance. She was always going to.` },
    { shot: 'close', seconds: 5, scene: `The two of them settled and content. Hold on this.` },
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
[{"shot":"wide|medium|close|two-shot","seconds":4,"scene":"what we see, one sentence"}]

Rules: no dialogue, no text on screen, tiny stakes, warmth not slapstick.
Describe only what is VISIBLE. Never restate the characters' appearance — that
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

async function generateStill(prompt, out, b) {
  const args = [
    '--prompt', prompt,
    '--negative-prompt', b.negative || 'text, watermark, human, blurry, deformed, extra limbs',
    '--width', '768', '--height', '1344',       // 9:16, a size SDXL-class models handle well
    '--steps', String(b.steps || 28),
    '--output', out,
  ];
  if (b.model) args.push('--model', b.model);
  if (b.lora) args.push('--lora', b.lora);       // the trained character LoRA, once you have one
  await run('draw-things-cli', args, BIG);
  if (!existsSync(out)) throw new Error('no image produced');
  return out;
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

async function assemble(clips, music, out) {
  const list = path.join(WORK, 'list.txt');
  writeFileSync(list, clips.map((c) => `file '${c}'`).join('\n'));

  const joined = path.join(WORK, 'joined.mp4');
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
  const dry = args.includes('--dry');
  const b = bible();

  if (args.includes('--list')) {
    b.episodes.forEach((e, i) => console.log(`${String(i + 1).padStart(2)}. ${e}`));
    return;
  }

  const idea = args.filter((a) => !a.startsWith('--'))[0]
    || b.episodes[Math.floor(Math.random() * b.episodes.length)];

  log(`episode: ${idea}`);
  mkdirSync(WORK, { recursive: true });
  mkdirSync(OUT, { recursive: true });

  const shots = await writeShots(idea, b);
  log(`${shots.length} shots, ${shots.reduce((a, s) => a + s.seconds, 0)}s total`);
  shots.forEach((s, i) => log(`  ${i + 1}. [${s.shot}] ${s.scene}`));

  if (dry) {
    console.log('\n--- prompt for shot 1 ---\n');
    console.log(promptFor(shots[0], b));
    return;
  }

  if (!(await haveCli())) {
    warn('\ndraw-things-cli not found. Install it with:');
    warn('  brew install drawthingsai/draw-things/draw-things-cli');
    warn('Then run this again. Everything else is ready.');
    process.exit(1);
  }

  const clips = [];
  for (const [i, shot] of shots.entries()) {
    const still = path.join(WORK, `shot${i + 1}.png`);
    const clip = path.join(WORK, `shot${i + 1}.mp4`);
    try {
      log(`[${i + 1}/${shots.length}] generating still…`);
      await generateStill(promptFor(shot, b), still, b);
      log(`             animating ${shot.seconds}s…`);
      await shotToClip(still, shot.seconds, clip, i);
      clips.push(clip);
    } catch (e) {
      warn(`  shot ${i + 1} failed: ${e.message}`);
    }
  }

  if (clips.length < 2) {
    warn('\nToo few shots rendered to make an episode.');
    process.exit(1);
  }

  const slug = idea.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const final = path.join(OUT, `${slug}.mp4`);
  const music = b.music && existsSync(path.join(ROOT, b.music)) ? path.join(ROOT, b.music) : null;

  const r = await assemble(clips, music, final);
  rmSync(WORK, { recursive: true, force: true });

  log(`\ndone: inbox-koala/${path.basename(final)}${r.music ? '' : '  (no music — see characters.json)'}`);
  log('Open ClipDrop and it will caption and queue it.');
}

main().catch((e) => { console.error('fatal:', e.message); process.exit(1); });

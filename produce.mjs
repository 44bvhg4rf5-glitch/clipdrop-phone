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
const WORKROOT = path.join(ROOT, '.produce');
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

/**
 * Every generation parameter is pinned, not left to whatever the tool defaults
 * to. Steps, guidance, sampler and model version all change the look, and a
 * default that shifts under you in an app update makes episode 40 quietly
 * different from episode 1 with nothing in your own setup having changed.
 */
async function generateStill(prompt, out, b, seed) {
  const args = [
    '--prompt', prompt,
    '--negative-prompt', b.negative || 'text, watermark, human, blurry, deformed, extra limbs',
    '--width', String(b.width || 768),
    '--height', String(b.height || 1344),
    '--steps', String(b.steps || 28),
    '--output', out,
  ];
  if (b.guidance) args.push('--guidance-scale', String(b.guidance));
  if (b.sampler) args.push('--sampler', b.sampler);
  if (b.model) args.push('--model', b.model);
  if (b.lora) args.push('--lora', b.lora);       // the trained character LoRA, once you have one
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
  const dry = args.includes('--dry');
  const variants = Math.min(4, Math.max(1, Number(flag('--variants')) || 1));

  log(`episode: ${idea}`);
  mkdirSync(WORK, { recursive: true });
  mkdirSync(OUT, { recursive: true });

  // Reuse the shot list on the assemble pass. Re-asking the model would give a
  // different episode from the one whose stills are sitting on disk.
  let shots;
  if (assemble_ && existsSync(shotFile)) {
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

  // ── assemble pass: animate the chosen stills ────────────────
  if (assemble_) {
    const picks = String(flag('--picks') || '').split(',').map((n) => Number(n.trim()));
    if (picks.length !== shots.length || picks.some((n) => !Number.isFinite(n) || n < 1)) {
      warn(`--picks needs ${shots.length} numbers, one per shot. e.g. --picks ${shots.map(() => 1).join(',')}`);
      process.exit(1);
    }

    const clips = [];
    for (const [i, shot] of shots.entries()) {
      const still = path.join(WORK, `shot${i + 1}-v${picks[i]}.png`);
      if (!existsSync(still)) { warn(`missing ${path.basename(still)} — skipping shot ${i + 1}`); continue; }
      const clip = path.join(WORK, `clip${i + 1}.mp4`);
      try {
        log(`[${i + 1}/${shots.length}] animating option ${picks[i]} · ${shot.seconds}s`);
        await shotToClip(still, shot.seconds, clip, i);
        clips.push(clip);
      } catch (e) { warn(`  shot ${i + 1} failed: ${e.message}`); }
    }
    if (clips.length < 2) { warn('\nToo few shots to assemble.'); process.exit(1); }

    const final = path.join(OUT, `${slug}.mp4`);
    const music = b.music && existsSync(path.join(ROOT, b.music)) ? path.join(ROOT, b.music) : null;
    const r = await assemble(clips, music, final, WORK);
    rmSync(WORK, { recursive: true, force: true });
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

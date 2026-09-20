// dashboard.mjs — the command centre. Runs on your Mac, in your browser.
//
//   node dashboard.mjs          then open http://localhost:4100
//
// Wraps the pipeline that already exists rather than reimplementing it: the
// Studio panel shells out to clipdrop.mjs, and everything else hangs off the
// clips it produces.
//
// Zero dependencies on purpose — this has to survive a year of not being
// touched, and npm installs are the first thing to rot.

import http from 'node:http';
import { spawn } from 'node:child_process';
import {
  readFileSync, writeFileSync, existsSync, mkdirSync,
  readdirSync, statSync, createReadStream, unlinkSync,
} from 'node:fs';
import path from 'node:path';

const ROOT = import.meta.dirname;
const PORT = process.env.CLIPDROP_PORT || 4100;
const DATA = path.join(ROOT, 'data');
const STORE = path.join(DATA, 'dashboard.json');
const INBOX = path.join(ROOT, 'inbox');
const DOCS = path.join(ROOT, 'docs');

mkdirSync(DATA, { recursive: true });
mkdirSync(INBOX, { recursive: true });

const cfg = () => {
  try { return JSON.parse(readFileSync(path.join(ROOT, 'config.json'), 'utf8')); }
  catch { return {}; }
};

// ── store ─────────────────────────────────────────────────────
// One JSON file. The clip lifecycle (posted / claimed / views / earnings) is
// hand-entered and irreplaceable, so it is never derived from anything the
// pipeline regenerates — merges only ever ADD pipeline clips, never overwrite
// what you typed.
const blank = { clips: {}, research: [], settings: { vault: '', tiktok: '' } };

function load() {
  if (!existsSync(STORE)) return structuredClone(blank);
  try { return { ...structuredClone(blank), ...JSON.parse(readFileSync(STORE, 'utf8')) }; }
  catch { return structuredClone(blank); }
}
function save(s) { writeFileSync(STORE, JSON.stringify(s, null, 2)); }

/** Pull anything new out of the pipeline's drop.json without clobbering edits. */
function syncDrop(state) {
  const f = path.join(DOCS, 'drop.json');
  if (!existsSync(f)) return state;
  let drop;
  try { drop = JSON.parse(readFileSync(f, 'utf8')); } catch { return state; }

  for (const c of drop.clips || []) {
    const id = c.file;
    const existing = state.clips[id] || {};
    state.clips[id] = {
      // pipeline-owned fields refresh
      id,
      file: c.file,
      hook: c.hook,
      caption: c.caption,
      hashtags: c.hashtags || [],
      sourceName: c.sourceName,
      seconds: c.seconds,
      sizeMb: c.sizeMb,
      basis: c.basis || null,
      captioned: !!c.captioned,
      builtBy: c.builtBy || 'local',
      date: drop.date,
      // yours, always preserved
      status: existing.status || 'ready',
      link: existing.link || '',
      postedAt: existing.postedAt || null,
      views: existing.views ?? null,
      earnings: existing.earnings ?? null,
      claimed: existing.claimed || false,
      note: existing.note || '',
    };
  }
  return state;
}

// ── render runs ───────────────────────────────────────────────
let job = null;   // { running, lines[], startedAt, code }

function startRender() {
  if (job?.running) return { ok: false, error: 'already running' };
  job = { running: true, lines: [], startedAt: Date.now(), code: null };

  const child = spawn(process.execPath, ['clipdrop.mjs'], {
    cwd: ROOT,
    env: { ...process.env, CLIPDROP_RUNNER: 'local' },
  });
  const push = (buf) => {
    for (const l of buf.toString().split('\n')) {
      if (l.trim()) job.lines.push(l.replace(/\u001b\[[0-9;]*m/g, ''));
    }
    if (job.lines.length > 400) job.lines = job.lines.slice(-400);
  };
  child.stdout.on('data', push);
  child.stderr.on('data', push);
  child.on('close', (code) => {
    job.running = false;
    job.code = code;
    const s = syncDrop(load());
    save(s);
  });
  child.on('error', (e) => {
    job.lines.push(`could not start: ${e.message}`);
    job.running = false;
    job.code = 1;
  });
  return { ok: true };
}

// ── AI (optional) ─────────────────────────────────────────────
async function ask(system, user, maxTokens = 1800) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return { error: 'no_key' };
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: process.env.CLIPDROP_MODEL || 'claude-sonnet-5',
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: user }],
      }),
      signal: AbortSignal.timeout(120000),
    });
    if (!res.ok) return { error: `api_${res.status}` };
    return { text: (await res.json()).content?.[0]?.text || '' };
  } catch (e) { return { error: e.message }; }
}


// ── analysis ──────────────────────────────────────────────────
// Clip view counts are violently skewed: most clips do a few hundred views and
// occasionally one does fifty thousand. The mean of that is a number that
// describes none of your clips. Everything below reports medians, and refuses
// to call anything a pattern until there is enough of it to be one.

const MIN_PER_GROUP = 3;    // below this a group is an anecdote
const MIN_TOTAL = 8;        // below this the whole dataset is

const median = (xs) => {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  const m = a.length >> 1;
  return a.length % 2 ? a[m] : Math.round((a[m - 1] + a[m]) / 2);
};
const pct = (xs, p) => {
  if (!xs.length) return 0;
  const a = [...xs].sort((x, y) => x - y);
  return a[Math.min(a.length - 1, Math.floor((p / 100) * a.length))];
};

/** Group posted clips by some key and rank by median views. */
function breakdown(clips, keyOf, label) {
  const groups = new Map();
  for (const c of clips) {
    const k = keyOf(c);
    if (k == null) continue;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(c.views);
  }
  const rows = [...groups.entries()]
    .map(([k, v]) => ({ key: String(k), n: v.length, median: median(v), best: Math.max(...v) }))
    .sort((a, b) => b.median - a.median);

  const solid = rows.filter((r) => r.n >= MIN_PER_GROUP);
  return {
    label,
    rows,
    // A verdict is only offered when two groups each have enough clips behind
    // them AND the gap between them is big enough to survive this much noise.
    verdict: solid.length >= 2 && solid[0].median >= solid[solid.length - 1].median * 1.5
      ? `${solid[0].key} is doing best — ${solid[0].median.toLocaleString()} median views vs ${solid[solid.length - 1].median.toLocaleString()}`
      : null,
    thin: solid.length < 2,
  };
}

const lengthBucket = (c) => {
  if (!c.seconds) return null;
  if (c.seconds <= 15) return 'under 15s';
  if (c.seconds <= 22) return '15-22s';
  if (c.seconds <= 30) return '23-30s';
  return 'over 30s';
};
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dayOf = (c) => (c.postedAt ? DAYS[new Date(c.postedAt).getDay()] : null);
const hourBand = (c) => {
  if (!c.postedAt) return null;
  const h = new Date(c.postedAt).getHours();
  if (h < 6) return 'night (00-06)';
  if (h < 12) return 'morning (06-12)';
  if (h < 18) return 'afternoon (12-18)';
  return 'evening (18-24)';
};

function analyse(state) {
  const clips = Object.values(state.clips);
  const posted = clips.filter((c) => c.postedAt);
  const scored = posted.filter((c) => Number.isFinite(c.views));
  const views = scored.map((c) => c.views);
  const totalViews = views.reduce((a, b) => a + b, 0);
  const totalEarned = posted.reduce((a, c) => a + (Number(c.earnings) || 0), 0);

  // Per-clip history, oldest first, for the trend chart.
  const timeline = scored
    .slice()
    .sort((a, b) => a.postedAt.localeCompare(b.postedAt))
    .map((c) => ({ at: c.postedAt.slice(0, 10), views: c.views, hook: c.hook }));

  const med = median(views);
  const p90 = pct(views, 90);

  // What a week is actually worth, from the median rather than the average --
  // the average is inflated by the one clip that spiked and would have you
  // planning around an outcome most weeks will not repeat.
  const cpm = totalViews ? (totalEarned / totalViews) * 1000 : 0;
  const perWeek = (clipsPerWeek) => +((med * clipsPerWeek * cpm) / 1000).toFixed(2);

  return {
    total: clips.length,
    ready: clips.filter((c) => !c.postedAt).length,
    posted: posted.length,
    claimed: posted.filter((c) => c.claimed).length,
    scored: scored.length,
    totalViews,
    totalEarned: +totalEarned.toFixed(2),
    medianViews: med,
    bestViews: views.length ? Math.max(...views) : 0,
    p90Views: p90,
    effectiveCpm: +cpm.toFixed(2),
    unclaimed: posted.filter((c) => !c.claimed).length,
    // Unclaimed clips are money already earned and not collected -- the one
    // number here that is directly actionable today.
    unclaimedViews: posted.filter((c) => !c.claimed && Number.isFinite(c.views))
      .reduce((a, c) => a + c.views, 0),
    timeline,
    enough: scored.length >= MIN_TOTAL,
    minTotal: MIN_TOTAL,
    minPerGroup: MIN_PER_GROUP,
    projection: { at3: perWeek(3), at7: perWeek(7), at14: perWeek(14) },
    breakdowns: [
      breakdown(scored, (c) => (c.hook || '').slice(0, 44) || null, 'Hook'),
      breakdown(scored, lengthBucket, 'Clip length'),
      breakdown(scored, dayOf, 'Day posted'),
      breakdown(scored, hourBand, 'Time posted'),
      breakdown(scored, (c) => c.sourceName || null, 'Source'),
    ],
    hookRank: breakdown(scored, (c) => (c.hook || '').slice(0, 44) || null, 'Hook').rows,
  };
}

/** What the numbers actually say — computed, not guessed at by the model. */
const summarise = analyse;

// ── Obsidian ──────────────────────────────────────────────────
// A vault is a folder of markdown. Nothing to integrate with, nothing to break.
function writeVault(state, body) {
  const dir = state.settings.vault;
  if (!dir) return { error: 'no_vault_set' };
  if (!existsSync(dir)) return { error: 'vault_not_found' };
  const sub = path.join(dir, 'ClipDrop');
  mkdirSync(sub, { recursive: true });
  const name = `${body.name || 'note'}`.replace(/[^\w \-.]/g, '').slice(0, 80) || 'note';
  const file = path.join(sub, `${name}.md`);
  writeFileSync(file, body.markdown || '');
  return { ok: true, file };
}

// ── http ──────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.mp4': 'video/mp4', '.mov': 'video/quicktime',
  '.png': 'image/png', '.svg': 'image/svg+xml',
};

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
};

const readBody = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => resolve(Buffer.concat(chunks)));
});

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const p = url.pathname;

  try {
    // ── API ──
    if (p === '/api/state') {
      const s = syncDrop(load());
      save(s);
      return json(res, 200, {
        clips: Object.values(s.clips).sort((a, b) => (b.date || '').localeCompare(a.date || '') || a.file.localeCompare(b.file)),
        research: s.research.slice(-20).reverse(),
        settings: s.settings,
        summary: summarise(s),
        campaign: cfg().campaign || '',
        inbox: existsSync(INBOX)
          ? readdirSync(INBOX).filter((f) => /\.(mp4|mov|m4v|mkv|webm)$/i.test(f))
              .map((f) => ({ name: f, mb: +(statSync(path.join(INBOX, f)).size / 1048576).toFixed(1) }))
          : [],
        job: job ? { running: job.running, lines: job.lines, code: job.code } : null,
        hasKey: !!process.env.ANTHROPIC_API_KEY,
      });
    }

    if (p.startsWith('/api/upload/') && req.method === 'PUT') {
      // Raw-body upload keyed by filename. Multipart would mean writing a
      // parser, and a parser is a dependency with extra steps.
      const name = decodeURIComponent(p.slice('/api/upload/'.length)).replace(/[/\\]/g, '_');
      if (!/\.(mp4|mov|m4v|mkv|webm)$/i.test(name)) return json(res, 400, { error: 'not_a_video' });
      const buf = await readBody(req);
      if (!buf.length) return json(res, 400, { error: 'empty' });
      writeFileSync(path.join(INBOX, name), buf);
      return json(res, 200, { ok: true, name, mb: +(buf.length / 1048576).toFixed(1) });
    }

    if (p === '/api/inbox/remove' && req.method === 'POST') {
      const { name } = JSON.parse((await readBody(req)).toString() || '{}');
      const f = path.join(INBOX, path.basename(String(name || '')));
      if (existsSync(f)) unlinkSync(f);
      return json(res, 200, { ok: true });
    }

    if (p === '/api/render' && req.method === 'POST') return json(res, 200, startRender());

    if (p === '/api/clip' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const s = load();
      const c = s.clips[body.id];
      if (!c) return json(res, 404, { error: 'unknown_clip' });
      for (const k of ['status', 'link', 'views', 'earnings', 'claimed', 'note']) {
        if (k in body) c[k] = body[k];
      }
      if (body.status === 'posted' && !c.postedAt) c.postedAt = new Date().toISOString();
      if (body.status === 'ready') c.postedAt = null;
      save(s);
      return json(res, 200, { ok: true, clip: c, summary: summarise(s) });
    }

    if (p === '/api/settings' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const s = load();
      s.settings = { ...s.settings, ...body };
      save(s);
      return json(res, 200, { ok: true, settings: s.settings });
    }

    if (p === '/api/research' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      const s = load();
      const sum = summarise(s);
      const recent = Object.values(s.clips).filter((c) => c.postedAt).slice(0, 25)
        .map((c) => `- "${c.hook}" | ${c.seconds}s | ${c.views ?? '?'} views | £${c.earnings ?? '?'}`).join('\n');

      const r = await ask(
        'You advise a solo TikTok clipper. Be concrete and specific. Never invent numbers — if the data is too thin to support a conclusion, say so plainly and say what to collect instead. Short sections, plain English, no filler.',
        `Campaign: ${cfg().campaign || 'unspecified'}\n`
        + `Clips: ${sum.total} total, ${sum.posted} posted, ${sum.totalViews} views, £${sum.totalEarned} earned.\n`
        + `Median views per clip: ${sum.medianViews}. Effective CPM: £${sum.effectiveCpm}.\n\n`
        + `Posted clips:\n${recent || '(none yet)'}\n\n`
        + `Question: ${body.question || 'What should I change to get more views per clip?'}\n\n`
        + 'Answer in markdown. Lead with the single highest-leverage change.',
      );
      if (r.error) return json(res, 200, { error: r.error });
      const entry = { at: new Date().toISOString(), question: body.question || 'General review', answer: r.text };
      s.research.push(entry);
      save(s);
      return json(res, 200, { ok: true, entry });
    }

    if (p === '/api/vault' && req.method === 'POST') {
      const body = JSON.parse((await readBody(req)).toString() || '{}');
      return json(res, 200, writeVault(load(), body));
    }

    // ── static ──
    let file = p === '/' ? '/dashboard.html' : p;
    let base = ROOT;
    if (file.startsWith('/clips/')) base = DOCS;          // rendered clips live under docs/
    const full = path.join(base, path.normalize(file).replace(/^(\.\.[/\\])+/, ''));
    if (!full.startsWith(ROOT)) { res.writeHead(403); return res.end('no'); }
    if (!existsSync(full) || statSync(full).isDirectory()) { res.writeHead(404); return res.end('not found'); }

    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    return createReadStream(full).pipe(res);
  } catch (e) {
    return json(res, 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`\n  ClipDrop dashboard  →  http://localhost:${PORT}\n`);
  console.log(`  AI research: ${process.env.ANTHROPIC_API_KEY ? 'on' : 'off (set ANTHROPIC_API_KEY to enable)'}\n`);
});

// remind.mjs — book today's posting alerts on ntfy for the exact UK times.
// ntfy holds each message and delivers it at the "At" time, so this only has
// to run once, any time before the first slot. Past slots are skipped.
import { readFileSync } from 'node:fs';

const topic = process.env.NTFY_TOPIC;
if (!topic) { console.log('no NTFY_TOPIC — nothing to do'); process.exit(0); }
const state = JSON.parse(readFileSync('campaigns/state.json', 'utf8'));
const ukDate = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());

// UK wall-clock time today -> unix seconds (handles GMT/BST).
function ukToUnix(date, hhmm) {
  const guess = Date.parse(`${date}T${hhmm}:00Z`);
  const offset = new Date(guess).toLocaleString('en-GB', { timeZone: 'Europe/London', timeZoneName: 'shortOffset' }).match(/GMT([+-]\d+)?/);
  const h = offset && offset[1] ? parseInt(offset[1], 10) : 0;
  return Math.round((guess - h * 3600e3) / 1000);
}

const slots = new Map();
for (const d of state.drops || []) {
  for (const it of d.items || []) {
    if (it.postDate ? it.postDate !== ukDate : d.date !== ukDate) continue;
    const t = it.postTime || null;
    if (!t) continue;
    const list = slots.get(t) || new Set(); list.add(it.hook); slots.set(t, list);
  }
  if (d.date === ukDate && !(d.items || []).some((it) => it.postTime)) {
    ['12:00', '17:00', '22:00'].forEach((t, i) => { const hooks = [...new Set(d.items.map((x) => x.hook))]; if (hooks[i]) slots.set(t, new Set([hooks[i]])); });
  }
}
const now = Date.now() / 1000;
for (const [t, hooks] of [...slots].sort()) {
  // Two minutes after the slot: the scheduled posts are live by then.
  const at = ukToUnix(ukDate, t) + 120;
  if (at < now + 60) { console.log(`${t}: already past`); continue; }
  const app = 'https://44bvhg4rf5-glitch.github.io/clipdrop-phone/app/';
  const scheduled = [...state.drops].some((d) => (d.items || []).some((it) => it.postDate === ukDate && it.postTime === t));
  const r = await fetch(`https://ntfy.sh/${topic}`, {
    method: 'POST',
    headers: {
      Title: scheduled ? `Posted (${t}): submit on Vyro` : `Time to post (${t})`, At: String(at), Tags: 'clapper',
      Click: scheduled ? `${app}#submit=${ukDate}T${t}` : app,
    },
    body: scheduled
      ? `"${[...hooks][0]}" is live. Tap for your TikTok, Instagram and YouTube links, then submit each on Vyro.`
      : `Post "${[...hooks][0]}" now, then submit the link on Vyro and paste it in the app.`,
  });
  console.log(`${t}: booked (${r.status})`);
}

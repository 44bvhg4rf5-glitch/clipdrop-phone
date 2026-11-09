// remind.mjs — book tomorrow's alerts on ntfy (it holds each one and delivers
// it at the "At" time), so a GitHub job that starts hours late can't make an
// alert late. Each daily run books the NEXT day only, so nothing is booked
// twice. DAY=today books today's instead (manual catch-up).
//   05:00          Good morning: today's clips to schedule  -> app #plan=<day>
//   slot + 2 min   Posted: submit on Vyro                   -> app #submit=<day>T<time>
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const topic = process.env.NTFY_TOPIC;
if (!topic) { console.log('no NTFY_TOPIC — nothing to do'); process.exit(0); }
const state = JSON.parse(readFileSync('campaigns/state.json', 'utf8'));
const ukToday = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date());
const addDay = (d, n) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const day = process.env.DAY === 'today' ? ukToday : addDay(ukToday, 1);
const app = 'https://44bvhg4rf5-glitch.github.io/clipdrop-phone/app/';

// UK wall-clock time on a date -> unix seconds (handles GMT/BST).
function ukToUnix(date, hhmm) {
  const guess = Date.parse(`${date}T${hhmm}:00Z`);
  const m = new Date(guess).toLocaleString('en-GB', { timeZone: 'Europe/London', timeZoneName: 'shortOffset' }).match(/GMT([+-]\d+)?/);
  return Math.round((guess - (m && m[1] ? parseInt(m[1], 10) : 0) * 3600e3) / 1000);
}
// What's already booked (committed back by the workflow), so a run that GitHub
// starts late, twice, or by hand never books the same alert twice.
const LEDGER = 'reminders/booked.json';
const booked = existsSync(LEDGER) ? JSON.parse(readFileSync(LEDGER, 'utf8')) : {};
async function book(at, title, body, click, tags) {
  const key = `${at}|${title}`;
  if (booked[key]) return console.log(`${title}: already booked`);
  if (at < Date.now() / 1000 + 60) return console.log(`${title}: already past`);
  const r = await fetch(`https://ntfy.sh/${topic}`, { method: 'POST', headers: { Title: title, At: String(at), Tags: tags, Click: click }, body });
  console.log(`${new Date(at * 1000).toISOString()} ${title}: ${r.status}`);
  if (r.ok) booked[key] = new Date().toISOString();
}

const order = (it) => (it.nextDay ? '9' : '0') + it.postTime;
const its = (state.drops || []).flatMap((d) => d.items || [])
  .filter((it) => it.postDate === day && (it.platforms || [])[0] === 'tiktok')
  .sort((a, b) => order(a).localeCompare(order(b)));
if (!its.length) { console.log(`no scheduled clips for ${day}`); process.exit(0); }
const plural = (n) => `${n} clip${n === 1 ? '' : 's'}`;

await book(ukToUnix(day, '05:00'), `Good morning: ${plural(its.length)} to schedule`,
  `Tap for today's clips, captions and files. ${its.map((it) => `${it.postTime}${it.nextDay ? ' (overnight)' : ''} ${it.hook}`).join(' · ')}`,
  `${app}#plan=${day}`, 'sunrise');
for (const it of its) {
  // An overnight post's alert waits for the morning (07:00) instead of waking you.
  const at = it.nextDay ? ukToUnix(it.liveDate, '07:00') : ukToUnix(day, it.postTime) + 120;
  await book(at, it.nextDay ? `Last night's ${it.postTime} post is live: submit on Vyro` : `Posted (${it.postTime}): submit on Vyro`,
    `"${it.hook}" is live. Tap for your TikTok, Instagram and YouTube links, then submit each on Vyro.`,
    `${app}#submit=${day}T${it.postTime}`, 'clapper');
}
// Forget bookings older than a week.
for (const k of Object.keys(booked)) if (+k.split('|')[0] < Date.now() / 1000 - 7 * 86400) delete booked[k];
writeFileSync(LEDGER, JSON.stringify(booked, null, 1) + '\n');

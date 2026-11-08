// remind.mjs — book tomorrow's alerts on ntfy (it holds each one and delivers
// it at the "At" time), so a GitHub job that starts hours late can't make an
// alert late. Each daily run books the NEXT day only, so nothing is booked
// twice. DAY=today books today's instead (manual catch-up).
//   05:00          Good morning: today's clips to schedule  -> app #plan=<day>
//   slot + 2 min   Posted: submit on Vyro                   -> app #submit=<day>T<time>
import { readFileSync } from 'node:fs';

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
async function book(at, title, body, click, tags) {
  if (at < Date.now() / 1000 + 60) return console.log(`${title}: already past`);
  const r = await fetch(`https://ntfy.sh/${topic}`, { method: 'POST', headers: { Title: title, At: String(at), Tags: tags, Click: click }, body });
  console.log(`${new Date(at * 1000).toISOString()} ${title}: ${r.status}`);
}

const its = (state.drops || []).flatMap((d) => d.items || [])
  .filter((it) => it.postDate === day && (it.platforms || [])[0] === 'tiktok')
  .sort((a, b) => a.postTime.localeCompare(b.postTime));
if (!its.length) { console.log(`no scheduled clips for ${day}`); process.exit(0); }

await book(ukToUnix(day, '05:00'), `Good morning: ${its.length} clips to schedule`,
  `Tap for today's clips, captions and files. ${its.map((it) => `${it.postTime} ${it.hook}`).join(' · ')}`,
  `${app}#plan=${day}`, 'sunrise');
for (const it of its) {
  await book(ukToUnix(day, it.postTime) + 120, `Posted (${it.postTime}): submit on Vyro`,
    `"${it.hook}" is live. Tap for your TikTok, Instagram and YouTube links, then submit each on Vyro.`,
    `${app}#submit=${day}T${it.postTime}`, 'clapper');
}

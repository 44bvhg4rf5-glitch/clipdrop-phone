// postcheck.mjs — check posts logged from the app before they are submitted.
//
//   node postcheck.mjs
//
// The app writes one file per post to posts/<date>/<id>.json with the link
// and the campaign's required hashtags. This reads every unchecked one and
// looks the post up through the platforms' official public oEmbed endpoints
// (no login, no scraping): TikTok returns the caption, YouTube the title.
// Instagram's oEmbed needs a developer token, so Reels get a link-format
// check only. Writes the verdict back into the file and prints a one-line
// summary for the notification.

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import path from 'node:path';

const ROOT = import.meta.dirname;
const DIR = path.join(ROOT, 'posts');

function files(d) {
  if (!existsSync(d)) return [];
  return readdirSync(d).flatMap((f) => {
    const p = path.join(d, f);
    return statSync(p).isDirectory() ? files(p) : f.endsWith('.json') ? [p] : [];
  });
}

const platformOf = (u) => /tiktok\.com/i.test(u) ? 'tiktok' : /instagram\.com/i.test(u) ? 'instagram' : /youtube\.com|youtu\.be/i.test(u) ? 'youtube' : 'unknown';

async function oembed(url, platform) {
  const api = platform === 'tiktok' ? `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`
    : platform === 'youtube' ? `https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}` : null;
  if (!api) return null;
  const r = await fetch(api, { signal: AbortSignal.timeout(20000) });
  if (r.status === 404 || r.status === 400 || r.status === 401 || r.status === 403) return { missing: true, status: r.status };
  if (!r.ok) throw new Error(`oEmbed ${r.status}`);
  return r.json();
}

async function check(post) {
  const url = String(post.url || '').trim();
  const platform = platformOf(url);
  const problems = [], notes = [];
  if (platform === 'unknown') return { status: 'problem', problems: ['That does not look like a TikTok, Instagram or YouTube link.'] };
  if (post.platform && post.platform !== platform) problems.push(`This clip was made for ${post.platform}, but the link is ${platform}.`);
  if (platform === 'instagram') {
    if (!/instagram\.com\/(reel|reels|p)\//i.test(url)) problems.push('Use the link to the Reel itself (Share → Copy link).');
    notes.push('Instagram captions cannot be checked without logging in, so check the hashtags yourself.');
    return { status: problems.length ? 'problem' : 'ok', platform, problems, notes };
  }
  if (platform === 'tiktok') {
    // TikTok's oEmbed answers 200 even for posts that don't exist, so it can't
    // confirm anything. Check the link's shape and account instead.
    const m = url.match(/tiktok\.com\/@([\w.]+)\/video\/(\d{8,})/i);
    if (!m && !/(vm|vt)\.tiktok\.com\//i.test(url)) problems.push('Use the video link itself (Share → Copy link).');
    if (m && post.expectHandle && m[1].toLowerCase() !== post.expectHandle.toLowerCase().replace(/^@/, '')) problems.push(`This is @${m[1]}'s video, not ${post.expectHandle}.`);
    notes.push('TikTok does not let us confirm posts or captions publicly: check it is public and has ' + ((post.requiredTags || []).join(' ') || 'the right hashtags') + '.');
    return { status: problems.length ? 'problem' : 'ok', platform, problems, notes };
  }
  if (platform === 'youtube' && !/\/shorts\//i.test(url)) notes.push('Make sure this is the Short (the link usually contains /shorts/).');
  const o = await oembed(url, platform);
  if (!o || o.missing) {
    problems.push('The post could not be found publicly. It may still be processing, private, or under review. Try again in a few minutes.');
    return { status: 'problem', platform, problems, notes };
  }
  const caption = String(o.title || '');
  const author = o.author_name || o.author_unique_id || '';
  if (post.expectHandle && author && !author.toLowerCase().includes(post.expectHandle.toLowerCase())) {
    problems.push(`Posted by ${author}, not ${post.expectHandle}.`);
  }
  const need = (post.requiredTags || []).map((t) => t.toLowerCase());
  const missing = caption ? need.filter((t) => !caption.toLowerCase().includes(t)) : [];
  if (!caption && need.length) notes.push(`Post is live. ${platform === 'tiktok' ? 'TikTok' : 'The platform'} doesn't share captions publicly, so check ${need.join(' ')} yourself.`);
  if (missing.length) {
    if (platform === 'tiktok') problems.push(`Caption is missing ${missing.join(' ')}. Edit the post and add them before submitting.`);
    else notes.push(`The title does not show ${missing.join(' ')}. Check they are in the description.`);
  }
  return { status: problems.length ? 'problem' : 'ok', platform, author, caption: caption.slice(0, 300), problems, notes };
}

const summary = [];
for (const f of files(DIR)) {
  const post = JSON.parse(readFileSync(f, 'utf8'));
  if (post.check && post.check.status === 'ok') continue;
  if (post.check && (post.check.tries || 0) >= 6) continue;
  let res;
  try { res = await check(post); } catch (e) { res = { status: 'error', problems: [`Could not check right now: ${e.message}`] }; }
  post.check = { ...res, at: new Date().toISOString(), tries: (post.check?.tries || 0) + 1 };
  writeFileSync(f, JSON.stringify(post, null, 2) + '\n');
  summary.push(`${res.status === 'ok' ? '✅' : '⚠️'} ${post.campaign || 'post'} (${res.platform || '?'})${res.problems?.length ? ': ' + res.problems[0] : ''}`);
}
console.log(summary.join('\n') || 'nothing to check');
writeFileSync(path.join(ROOT, '.postcheck-summary.txt'), summary.join('\n'));

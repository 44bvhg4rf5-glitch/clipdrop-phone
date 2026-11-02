// upload-config.mjs — turn an upload from the app into a one-off campaign
// config for clipfarm-cloud.mjs (run with CLIP_ONLY=<the config>).
//
//   node upload-config.mjs <video path> <account> [campaign id] > config.json
//
// With a campaign id, the clips follow that campaign's rules (hashtags,
// hooks, platforms, submit link). Without one, they get the account's
// house hooks and no campaign hashtags.
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

const [video, account = 'ReplayRoom', campaignId = ''] = process.argv.slice(2);
const HOUSE = {
  ReplayRoom: ['Wait for it...', 'Nobody saw this coming', 'The reaction says it all', 'He really said that', 'This is why I keep watching'],
  'Off Mic': ['This answer changed everything', 'He said what we were all thinking', 'The most honest answer yet', 'Nobody talks about this'],
  'The Deal Room': ['This is how the deal really works', 'The pitch that changed everything', 'Nobody explains money like this', 'He made it look easy'],
};
const file = campaignId ? path.join(import.meta.dirname, 'campaigns', `${campaignId}.json`) : '';
const base = file && existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
const cfg = {
  ...base,
  name: base.name ? `${base.name} · your upload` : `Your upload · ${path.basename(video)}`,
  type: 'creator',
  enabled: true,
  account: base.account || account,
  sources: [`file://${path.resolve(video)}`],
  platforms: base.platforms || ['tiktok', 'instagram', 'youtube'],
  perDay: Number(process.env.UPLOAD_MOMENTS || 3),
  minSeconds: Math.max(base.minSeconds || 0, 20),
  maxSeconds: base.maxSeconds || 45,
  hooks: base.hooks?.length ? base.hooks : HOUSE[base.account || account] || HOUSE.ReplayRoom,
  quoteHooks: base.quoteHooks ?? false,
  endsOn: null,
};
process.stdout.write(JSON.stringify(cfg, null, 2));

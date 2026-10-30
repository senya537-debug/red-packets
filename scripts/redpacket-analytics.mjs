#!/usr/bin/env node
import fs from 'node:fs';

const FEED_PATH = '.redpacket/public_feed.json';
const HISTORY_PATH = '.redpacket/analytics_history.json';
const REPORT_PATH = '.redpacket/analytics.json';
const MAX_RECORDS = 20000;
const RETENTION_DAYS = 365;

const readJson = (path, fallback) => {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
};
const clean = value => value === undefined || value === null || value === '' ? null : value;
const num = value => {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(String(value).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
};
const isoDay = value => {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
};
const hourOf = value => {
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : String(d.getUTCHours()).padStart(2, '0');
};
const add = (map, key, amount = 1) => {
  if (!key) key = 'unknown';
  map[key] = (map[key] || 0) + amount;
};
const sorted = map => Object.fromEntries(Object.entries(map).sort((a,b) => b[1] - a[1]));

function normalizeEntry(entry, now) {
  const candidate = entry?.candidate || {};
  const post = candidate.post || {};
  const postId = String(post.post_id || post.live_id || '').trim();
  const packetId = clean(post.packet_id);
  const packetCode = clean(post.packet_code);
  const key = String(candidate.key || (postId ? (post.kind === 'live' ? 'live:' : 'post:') + postId : '')).trim();
  if (!key) return null;
  const identity = packetId ? 'packet:' + packetId : packetCode ? 'code:' + String(packetCode).toUpperCase() : key;
  const publishedAt = clean(post.published_at);
  return {
    key, identity, post_id: postId || null, packet_id: packetId,
    packet_code: packetCode ? String(packetCode).toUpperCase() : null,
    kind: clean(post.kind) || 'unknown',
    author: clean(post.author) || 'unknown',
    author_id: clean(post.author_id),
    currency: clean(post.currency) ? String(post.currency).toUpperCase() : null,
    amount: clean(post.amount),
    available_amount: clean(post.available_amount),
    available_receivers: num(post.available_receivers),
    eligibility: clean(post.eligibility) || 'not_checked',
    status: clean(post.status) || 'unknown',
    answer_verified: post.answer_verified === true,
    reward_verified: post.reward_verified === true,
    comments: num(post.comments),
    published_at: publishedAt,
    published_day: isoDay(publishedAt),
    published_hour_utc: hourOf(publishedAt),
    expires_at: clean(post.expires_at),
    sources: Array.isArray(post.sources) ? post.sources : [],
    worker: clean(entry.worker) || 'unknown',
    url: clean(post.url),
    excerpt: clean(post.excerpt),
    first_seen_at: now,
    last_seen_at: now,
    observations: 1
  };
}
function mergeRecord(old, incoming) {
  if (!old) return incoming;
  const out = { ...old };
  for (const [k,v] of Object.entries(incoming)) {
    if (v !== null && v !== undefined && v !== '' && (!Array.isArray(v) || v.length)) out[k] = v;
  }
  out.first_seen_at = old.first_seen_at || incoming.first_seen_at;
  out.last_seen_at = incoming.last_seen_at;
  out.observations = (old.observations || 0) + 1;
  out.answer_verified = old.answer_verified === true || incoming.answer_verified === true;
  out.reward_verified = old.reward_verified === true || incoming.reward_verified === true;
  out.sources = [...new Set([...(old.sources || []), ...(incoming.sources || [])])];
  return out;
}
function aggregate(records, feedGeneratedAt, snapshots) {
  const byKind = {}, byCurrency = {}, byWorker = {}, byEligibility = {}, byStatus = {};
  const byDay = {}, byHour = {}, authorMap = {};
  const identities = new Map();
  let withCode = 0, withPacketId = 0, withAmount = 0, withAvailableAmount = 0;
  let withReceivers = 0, answerVerified = 0, rewardVerified = 0, expiredAtSnapshot = 0;
  const now = Date.parse(feedGeneratedAt) || Date.now();
  for (const r of records) {
    add(byKind, r.kind); add(byCurrency, r.currency); add(byWorker, r.worker);
    add(byEligibility, r.eligibility); add(byStatus, r.status);
    add(byDay, r.published_day); add(byHour, r.published_hour_utc);
    if (r.packet_code) withCode++;
    if (r.packet_id) withPacketId++;
    if (num(r.amount) !== null) withAmount++;
    if (num(r.available_amount) !== null) withAvailableAmount++;
    if (r.available_receivers !== null) withReceivers++;
    if (r.answer_verified) answerVerified++;
    if (r.reward_verified) rewardVerified++;
    if (r.expires_at && Date.parse(r.expires_at) < now) expiredAtSnapshot++;
    const identity = r.packet_id ? 'packet:' + r.packet_id : r.packet_code ? 'code:' + r.packet_code : r.key;
    if (!identities.has(identity)) identities.set(identity, r);
    const authorKey = r.author_id || r.author || 'unknown';
    const a = authorMap[authorKey] ||= { author: r.author, author_id: r.author_id, posts: 0, quiz: 0, packets: 0, live: 0, codes: 0, packet_ids: 0, amounts_known: 0, answer_verified: 0, reward_verified: 0 };
    a.posts++;
    if (r.kind === 'quiz') a.quiz++;
    if (r.kind === 'packet') a.packets++;
    if (r.kind === 'live') a.live++;
    if (r.packet_code) a.codes++;
    if (r.packet_id) a.packet_ids++;
    if (num(r.amount) !== null) a.amounts_known++;
    if (r.answer_verified) a.answer_verified++;
    if (r.reward_verified) a.reward_verified++;
  }
  const authorRows = Object.values(authorMap);
  const authors = [...authorRows].sort((a,b) => b.posts - a.posts).slice(0, 30);
  const authorsByData = authorRows.filter(a => a.codes || a.packet_ids || a.amounts_known)
    .sort((a,b) => (b.packet_ids-a.packet_ids) || (b.codes-a.codes) || (b.amounts_known-a.amounts_known) || (b.posts-a.posts)).slice(0, 30);
  const daily = Object.entries(byDay).filter(([k]) => k !== 'unknown').sort((a,b) => a[0].localeCompare(b[0])).map(([date,count]) => ({date,count}));
  const hourly = Array.from({length:24},(_,h)=>({hour_utc:String(h).padStart(2,'0'),count:byHour[String(h).padStart(2,'0')]||0}));
  return {
    version: 1, generated_at: feedGeneratedAt, snapshots_processed: snapshots,
    coverage: { retained_unique_posts: records.length, unique_packet_ids: new Set(records.filter(r=>r.packet_id).map(r=>r.packet_id)).size,
      unique_codes: new Set(records.filter(r=>r.packet_code).map(r=>r.packet_code)).size,
      unique_packet_or_code_groups: identities.size, records_seen_in_latest_feed: null },
    kinds: sorted(byKind), currencies: sorted(byCurrency), workers: sorted(byWorker),
    eligibility: sorted(byEligibility), statuses: sorted(byStatus),
    data_quality: { code_present: withCode, packet_id_present: withPacketId, amount_known: withAmount,
      available_amount_known: withAvailableAmount, receivers_known: withReceivers,
      answer_verified: answerVerified, reward_verified: rewardVerified,
      expired_by_feed_timestamp: expiredAtSnapshot },
    daily, hourly_utc: hourly, top_authors: authors, top_authors_by_data_completeness: authorsByData,
    notes: [
      'Counts are unique Square posts retained by analytics history, not confirmed successful claims.',
      'packet_id/code groups are deduplicated separately from post counts; posts without either identifier fall back to post identity.',
      'reported_open is a source label, not proof Binance still accepts the packet.',
      'Verification flags count only when the source explicitly sets them to true.',
      'Amounts are metadata values, not confirmed received rewards.'
    ]
  };
}

const feed = readJson(FEED_PATH, null);
if (!feed || !feed.public_feed || typeof feed.public_feed !== 'object') throw new Error('Missing or invalid ' + FEED_PATH);
const history = readJson(HISTORY_PATH, { version: 1, last_feed_generated_at: null, snapshots_processed: 0, records: {} });
const feedStamp = String(feed.generated_at || '');
if (!feedStamp) throw new Error('public_feed.generated_at is missing');
const now = new Date().toISOString();
const records = history.records || {};
const changed = feedStamp !== history.last_feed_generated_at;
let seenLatest = 0;
if (changed) {
  for (const entry of Object.values(feed.public_feed)) {
    const normalized = normalizeEntry(entry, now);
    if (!normalized) continue;
    seenLatest++;
    records[normalized.key] = mergeRecord(records[normalized.key], normalized);
  }
  const cutoff = Date.now() - RETENTION_DAYS * 86400000;
  for (const [key, record] of Object.entries(records)) {
    const stamp = Date.parse(record.last_seen_at || record.published_at || 0);
    if (Number.isFinite(stamp) && stamp < cutoff) delete records[key];
  }
  const keys = Object.keys(records);
  if (keys.length > MAX_RECORDS) {
    keys.sort((a,b) => Date.parse(records[a].last_seen_at || 0) - Date.parse(records[b].last_seen_at || 0));
    for (const key of keys.slice(0, keys.length - MAX_RECORDS)) delete records[key];
  }
  history.last_feed_generated_at = feedStamp;
  history.snapshots_processed = (history.snapshots_processed || 0) + 1;
}
const allRecords = Object.values(records);
const report = aggregate(allRecords, feedStamp, history.snapshots_processed || 0);
report.coverage.records_seen_in_latest_feed = Object.keys(feed.public_feed).length;
report.coverage.history_retention_days = RETENTION_DAYS;
report.coverage.history_cap = MAX_RECORDS;
report.coverage.last_feed_changed = changed;
history.records = records;
history.updated_at = now;
fs.mkdirSync('.redpacket', { recursive: true });
fs.writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2) + '\n');
fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ changed, feed_generated_at: feedStamp, snapshots_processed: history.snapshots_processed,
  latest_feed_records: seenLatest, retained_unique_posts: allRecords.length,
  unique_packet_ids: report.coverage.unique_packet_ids, unique_codes: report.coverage.unique_codes }, null, 2));

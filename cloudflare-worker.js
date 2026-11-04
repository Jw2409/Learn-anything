/* Learn Anything reminder server (a Cloudflare Worker)
 *
 * What it does, in plain words:
 *   - Your phone can only show a reminder if something sends it. This small
 *     program is that "something". It runs for free on Cloudflare.
 *   - The app tells it your schedule and how you are doing (no lessons, no
 *     API key, no answers, just "a lesson is due", your streak and score).
 *   - Every minute it checks the clock. When a reminder time arrives and you
 *     have not done your lesson, it sends a push to your phone. The longer
 *     you ignore it, the harder the message gets.
 *   - It also answers the home-screen widget with which character to show.
 *
 * Setup needs two things in the Cloudflare dashboard (see SETUP-REMINDERS.md):
 *   1. A KV namespace bound to this Worker with the variable name  KV
 *   2. A Cron Trigger with the schedule  * * * * *   (every minute)
 *
 * Free-plan numbers (Cloudflare docs): 100,000 Worker requests/day, KV 100,000
 * reads and 1,000 writes per day. One person uses a tiny fraction of that.
 */

const MAX_DEVICES = 25;      // stops strangers from filling your free storage
const MAX_PER_DAY = 8;       // never more than this many reminders in a day
const SLOT_WINDOW_MIN = 20;  // a reminder time is "missed" after this many minutes

/* ================= 1. The messages (edit these to change the tone) =================
 * Each tier is one step on the ladder. The more reminders you have ignored,
 * the higher the tier. In a message:
 *   a leading !  marks one with swearing (hidden if "allow swearing" is off)
 *   a leading #  marks one that only works if you have a streak
 *   {lesson} {streak} {days} are filled in for you
 */
const TITLES = ['Lesson ready', 'Still waiting', 'Hey', 'Dude', 'Seriously', 'Not mad. Disappointed.', 'Come on', 'You know', 'Where did you go'];

const TIERS = [
  /* 0: first nudge */ [
    `It's about time to learn.`,
    `{lesson} is ready whenever you are.`,
    `Lesson's up. Get it out of the way early.`,
    `You said you'd do this. It's ready.`,
    `Quick one today: {lesson}. Open it.`,
    `Your lesson's here. The rest of the day is easier once it's done.`
  ],
  /* 1 */ [
    `Hey man, how long are you gonna take?`,
    `Still haven't opened it, huh.`,
    `The lesson isn't going to do itself.`,
    `You've had time to scroll. You've got time for this.`,
    `I'm checking if you did {lesson} yet. You didn't.`,
    `!You've been on your phone this whole time. Open the damn lesson.`
  ],
  /* 2 */ [
    `Any day now.`,
    `Cool, so we're just not doing it today?`,
    `No rush. Except for the part where you said you would.`,
    `I can wait. I just don't think you realize I'm waiting.`,
    `!What the hell is more important than this right now?`,
    `Take your time. I'll just be here, watching you not do it.`
  ],
  /* 3 */ [
    `Dude, don't you want to win in life?`,
    `I'm starting to wonder if you actually want this.`,
    `Everyone you want to be like did the boring part first. This is the boring part.`,
    `You keep saying you want more. This is what it costs.`,
    `I believed you when you said you were serious.`,
    `!Dude. Come on. Do the fucking lesson.`
  ],
  /* 4 */ [
    `You need to win. Open the app.`,
    `Skipping again? That's what you did last time too.`,
    `I'm tired of being the one who has to remind you.`,
    `Nobody is coming to do this for you.`,
    `!Get off your ass. {lesson}. Now.`,
    `!Stop being lazy as shit and do it.`
  ],
  /* 5 */ [
    `#{streak} days. You're really gonna throw that away?`,
    `I'm not mad. I'm disappointed, and you know that's worse.`,
    `Past you set this up so future you wouldn't have to think. Don't make past you look stupid.`,
    `You're letting down the version of you that actually makes it.`,
    `!Fuck's sake. It's one lesson.`,
    `#Your {streak}-day streak is on life support. Pull it back.`
  ],
  /* 6 */ [
    `You need to win.`,
    `I'm out of nice ways to say this. Do the lesson.`,
    `Funny how you've got energy for everything except this.`,
    `Whatever you're waiting for isn't coming. Start.`,
    `!You're not tired. You're avoiding it. Do the shit.`,
    `!What the fuck are we doing here?`
  ],
  /* 7 */ [
    `You know exactly what you should be doing.`,
    `I'll keep sending these. You'll keep ignoring them. Guess who loses.`,
    `This is the moment where you decide who you are.`,
    `Still here. Still waiting. Still disappointed.`,
    `!Do the damn lesson or admit you quit.`,
    `!I swear to God, it's one lesson.`
  ],
  /* 8: three or more days overdue, quieter and colder */ [
    `It's been {days} days. I'm not gonna pretend that's fine.`,
    `I stopped being angry a while ago. Now I just wonder if you're coming back.`,
    `{days} days. One lesson and you're back in it.`,
    `!You've ghosted your own goals for {days} days. Fix it.`,
    `Just open it. That's the whole ask.`,
    `{days} days is long enough. Stop negotiating with yourself.`
  ]
];

function parseMessage(s, tier, i) {
  let raw = false, needsStreak = false;
  while (s[0] === '!' || s[0] === '#') {
    if (s[0] === '!') raw = true; else needsStreak = true;
    s = s.slice(1);
  }
  return { id: tier + '.' + i, text: s, raw: raw, needsStreak: needsStreak };
}

// Which tier a reminder belongs to: how many have already gone unanswered for
// this lesson, and how many days late it is.
function tierFor(count, overdueDays) {
  if (overdueDays >= 3) return count % 2 ? 7 : 8;
  if (count <= 3) return count;
  if (count <= 5) return 4;
  if (count <= 8) return 5;
  if (count <= 12) return 6;
  return 7;
}

function fill(text, v) {
  return text.replace(/\{lesson\}/g, v.lesson || 'your lesson').replace(/\{streak\}/g, String(v.streak || 0)).replace(/\{days\}/g, String(v.days || 0));
}

// Pick a message for a tier, avoiding the last dozen used.
function pickMessage(tier, v, rawOk, recent, rnd) {
  rnd = rnd || Math.random;
  const all = TIERS[tier].map((s, i) => parseMessage(s, tier, i));
  let pool = all.filter(m => (rawOk || !m.raw) && (!m.needsStreak || v.streak >= 2));
  if (!pool.length) pool = all.filter(m => !m.raw && !m.needsStreak);
  const fresh = pool.filter(m => (recent || []).indexOf(m.id) < 0);
  const use = fresh.length ? fresh : pool;
  const m = use[Math.floor(rnd() * use.length)];
  return { id: m.id, title: TITLES[tier], body: fill(m.text, v), tier: tier };
}

/* ================= 2. Characters for the widget ================= */

const CAPTIONS = {
  cub:     [`Day one doesn't care about your excuses.`, `Small now. Not for long.`, `Nobody's watching you start. Start anyway.`],
  wolf:    [`Streak's alive. Feed it today.`, `Consistency beats motivation. Show up.`, `You're building something. Don't stop mid-rep.`],
  pegasus: [`Close to untouchable. Don't coast.`, `Almost perfect isn't perfect. Finish it.`, `Top of the range. Hold the line.`],
  god:     [`Perfect streak. Keep earning it.`, `Discipline like this looks like power.`, `This is what showing up for months does.`],
  robot:   [`Zero misses. Keep running the program.`, `No days off in the code. Execute.`, `Streak intact. Do not slow down.`],
  knight:  [`You fell. Kneeling doesn't count. Get up.`, `The streak's gone. Start it again today.`, `Everyone drops the sword. Pick it up.`]
};
const NAMES = { cub: 'LION CUB', wolf: 'WOLF', pegasus: 'PEGASUS', god: 'GREEK GOD', robot: 'MACHINE', knight: 'FALLEN KNIGHT' };

function dayNumber(dateStr) {
  const p = dateStr.split('-').map(Number);
  return Math.floor(Date.UTC(p[0], p[1] - 1, p[2]) / 86400000);
}
function daysBetween(a, b) { return dayNumber(b) - dayNumber(a); }

// Which character fits how you are doing:
//   knight   you had a streak (3+ days) and lost it
//   cub      brand new (2 or fewer days of learning so far)
//   god/robot  streak of 14+ days and average score 95%+ (swaps every day)
//   pegasus  streak of 7+ days and average score 80%+
//   wolf     everything else: you are building the habit
function characterFor(st, today, images) {
  st = st || {};
  const gap = st.lastActive ? daysBetween(st.lastActive, today) : 9999;
  const streak = (st.lastActive && gap <= 1) ? (st.streak || 0) : 0;
  const best = Math.max(st.best || 0, st.streak || 0);
  const avg = typeof st.avgScore === 'number' ? st.avgScore : null;
  const day = dayNumber(today);
  let key;
  if (streak === 0 && best >= 3) key = 'knight';
  else if (!st.activeDays || st.activeDays <= 2) key = 'cub';
  else if (streak >= 14 && avg !== null && avg >= 95) key = (day % 2 === 0) ? 'god' : 'robot';
  else if (streak >= 7 && avg !== null && avg >= 80) key = 'pegasus';
  else key = 'wolf';
  const list = (images && images[key]) || [];
  const variant = (key === 'god' || key === 'robot') ? Math.floor(day / 2) : day;
  const image = list.length ? list[((variant % list.length) + list.length) % list.length] : '';
  const caps = CAPTIONS[key];
  return {
    key: key, name: NAMES[key], image: image, caption: caps[((day % caps.length) + caps.length) % caps.length],
    streak: streak, best: best, avgScore: avg, lessonsDone: st.lessonsDone || 0, appUrl: st.appUrl || ''
  };
}

/* ================= 3. Time helpers ================= */

function validTz(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch (e) { return false; }
}
// Local date ("2026-11-02") and minutes since midnight in a time zone.
function localParts(ms, tz) {
  const f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const o = {};
  f.formatToParts(new Date(ms)).forEach(p => { o[p.type] = p.value; });
  return { date: o.year + '-' + o.month + '-' + o.day, min: (parseInt(o.hour, 10) % 24) * 60 + parseInt(o.minute, 10) };
}
function parseHM(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const h = +m[1], mi = +m[2];
  return (h > 23 || mi > 59) ? null : h * 60 + mi;
}
function fmtHM(min) { return String(Math.floor(min / 60)).padStart(2, '0') + ':' + String(min % 60).padStart(2, '0'); }
function median(a) {
  const s = a.slice().sort((x, y) => x - y), n = s.length;
  return n % 2 ? s[(n - 1) / 2] : Math.round((s[n / 2 - 1] + s[n / 2]) / 2);
}

/* ================= 4. Schedule ================= */

// The minutes-of-day when reminders go out.
//  custom:  exactly the times you picked.
//  optimal: one consistent daily cue (habit research: a steady time and place
//           makes a habit stick fastest), then follow-ups with growing gaps
//           (+40 min, +2 h, +4 h, +7 h) so it never turns into noise. If you
//           allow it, the cue moves to 15 minutes before the time you usually
//           finish lessons.
function slotsFor(dev) {
  const p = dev.prefs;
  if (p.mode === 'custom') {
    return Array.from(new Set((p.times || []).map(parseHM).filter(x => x !== null))).sort((a, b) => a - b).slice(0, 12);
  }
  let anchor = parseHM(p.optimalTime);
  if (anchor === null) anchor = 18 * 60;
  const comps = (dev.status && dev.status.completionMins) || [];
  if (p.adapt && comps.length >= 3) anchor = median(comps) - 15;
  anchor = Math.max(8 * 60, Math.min(21 * 60, anchor));
  return [0, 40, 120, 240, 420].map(o => anchor + o).filter(m => m <= 22 * 60 + 15);
}

// Is a reminder due right now? Returns the minute-of-day of the slot, or null.
function dueSlot(dev, now) {
  const st = dev.status;
  if (!st || !st.pending) return null;
  const L = localParts(now, dev.tz);
  if (st.pending.since > L.date) return null;
  const sentToday = (dev.sent && dev.sent.date === L.date) ? dev.sent.slots : [];
  if (sentToday.length >= MAX_PER_DAY) return null;
  const slots = slotsFor(dev);
  for (let i = 0; i < slots.length; i++) {
    const m = slots[i];
    if (L.min >= m && L.min - m <= SLOT_WINDOW_MIN && sentToday.indexOf(m) < 0) return m;
  }
  return null;
}

/* ================= 5. Web Push (no libraries needed) ================= */
// A "push" is a tiny signed knock on Apple's or Google's door that says "wake
// this phone". The knock carries no text. The phone's service worker then asks
// this server what to show (see /n/<id>).

function b64u(buf) {
  const b = new Uint8Array(buf);
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function b64uStr(str) { return b64u(new TextEncoder().encode(str)); }

// The server makes its own signing key once and keeps it in KV. It never
// leaves the server; only the public half is given to the app.
async function getVapid(env) {
  const raw = await env.KV.get('vapid');
  if (raw) return JSON.parse(raw);
  const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
  const v = {
    publicKey: b64u(await crypto.subtle.exportKey('raw', kp.publicKey)),
    privateJwk: await crypto.subtle.exportKey('jwk', kp.privateKey),
    subject: ''
  };
  await env.KV.put('vapid', JSON.stringify(v));
  return v;
}

async function signJwt(v, audience, nowMs) {
  const key = await crypto.subtle.importKey('jwk', v.privateJwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = b64uStr(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const body = b64uStr(JSON.stringify({ aud: audience, exp: Math.floor(nowMs / 1000) + 12 * 3600, sub: v.subject || 'https://learn-anything.invalid' }));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(head + '.' + body));
  return head + '.' + body + '.' + b64u(sig);
}

// Only real push services are allowed, so nobody can aim this server elsewhere.
function pushHostOk(endpoint) {
  let u;
  try { u = new URL(endpoint); } catch (e) { return false; }
  if (u.protocol !== 'https:') return false;
  const h = u.hostname;
  return h === 'web.push.apple.com' || h.endsWith('.push.apple.com') ||
    h === 'fcm.googleapis.com' || h.endsWith('.push.services.mozilla.com') || h.endsWith('.notify.windows.com');
}

async function sendPush(env, endpoint, nowMs) {
  try {
    const v = await getVapid(env);
    const jwt = await signJwt(v, new URL(endpoint).origin, nowMs);
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: 'vapid t=' + jwt + ', k=' + v.publicKey, TTL: '3600', Urgency: 'high' },
      body: ''
    });
    return { ok: res.status >= 200 && res.status < 300, status: res.status, gone: res.status === 404 || res.status === 410 };
  } catch (e) {
    return { ok: false, status: 0, gone: false, error: String(e) };
  }
}

/* ================= 6. Saved data (KV) ================= */

async function getDev(env, id) {
  const s = await env.KV.get('d:' + id);
  return s ? JSON.parse(s) : null;
}
async function putDev(env, dev) { await env.KV.put('d:' + dev.id, JSON.stringify(dev)); }
async function getIndex(env) {
  const s = await env.KV.get('index');
  return s ? JSON.parse(s) : [];
}

function newDevice(id, now) {
  return {
    id: id, createdAt: now, sub: null, tz: 'UTC',
    prefs: cleanPrefs({}), status: null,
    sent: { date: '', slots: [] }, pendingKey: '', pendingSent: 0, recent: [], outbox: null
  };
}

function cleanImages(o) {
  const out = {};
  Object.keys(NAMES).forEach(k => {
    const arr = (o && Array.isArray(o[k])) ? o[k] : [];
    out[k] = arr.map(x => String(x).trim()).filter(x => /^https:\/\/\S{4,400}$/.test(x)).slice(0, 4);
  });
  return out;
}
function cleanPrefs(p) {
  p = p || {};
  return {
    enabled: !!p.enabled,
    mode: p.mode === 'custom' ? 'custom' : 'optimal',
    times: (Array.isArray(p.times) ? p.times : []).filter(t => parseHM(t) !== null).slice(0, 12),
    optimalTime: parseHM(p.optimalTime) !== null ? p.optimalTime : '18:00',
    adapt: p.adapt !== false,
    raw: p.raw !== false,
    images: cleanImages(p.images)
  };
}
const num = (x, lo, hi) => { x = Number(x); return isFinite(x) ? Math.max(lo, Math.min(hi, Math.round(x))) : 0; };
const dateOk = s => typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s);
function cleanStatus(s) {
  s = s || {};
  let pending = null;
  if (s.pending && dateOk(s.pending.since)) {
    pending = { key: String(s.pending.key || '').slice(0, 80), since: s.pending.since, lesson: String(s.pending.lesson || '').slice(0, 80), course: String(s.pending.course || '').slice(0, 80) };
  }
  return {
    pending: pending,
    lastActive: dateOk(s.lastActive) ? s.lastActive : '',
    streak: num(s.streak, 0, 5000), best: num(s.best, 0, 5000), activeDays: num(s.activeDays, 0, 20000),
    avgScore: (s.avgScore === null || s.avgScore === undefined) ? null : num(s.avgScore, 0, 100),
    lessonsDone: num(s.lessonsDone, 0, 5000),
    completionMins: (Array.isArray(s.completionMins) ? s.completionMins : []).map(x => num(x, 0, 1439)).slice(-10),
    appUrl: /^https?:\/\/\S{4,300}$/.test(String(s.appUrl || '')) ? String(s.appUrl) : ''
  };
}

/* ================= 7. The every-minute check ================= */

async function deliver(env, dev, slot, now) {
  const L = localParts(now, dev.tz);
  const st = dev.status;
  const overdue = daysBetween(st.pending.since, L.date);
  const gap = st.lastActive ? daysBetween(st.lastActive, L.date) : 9999;
  const streak = gap <= 1 ? st.streak : 0;
  const count = dev.pendingSent || 0;
  const msg = pickMessage(tierFor(count, overdue), { lesson: st.pending.lesson, streak: streak, days: overdue }, dev.prefs.raw, dev.recent);
  dev.outbox = { title: msg.title, body: msg.body, at: now };
  dev.recent = (dev.recent || []).concat([msg.id]).slice(-12);
  const same = dev.sent && dev.sent.date === L.date;
  dev.sent = { date: L.date, slots: (same ? dev.sent.slots : []).concat([slot]) };
  dev.pendingSent = count + 1;
  await putDev(env, dev);   // saved BEFORE the push so the phone can read the text
  const r = await sendPush(env, dev.sub.endpoint, now);
  if (r.gone) { dev.sub = null; await putDev(env, dev); }
  return r;
}

async function runCron(env, now) {
  const ids = await getIndex(env);
  for (const id of ids) {
    const dev = await getDev(env, id);
    if (!dev || !dev.sub || !dev.prefs || !dev.prefs.enabled) continue;
    const slot = dueSlot(dev, now);
    if (slot === null) continue;
    await deliver(env, dev, slot, now);
  }
}

/* ================= 8. Web addresses (what the app and widget call) ================= */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Max-Age': '86400'
};
const json = (o, status) => new Response(JSON.stringify(o), { status: status || 200, headers: Object.assign({ 'Content-Type': 'application/json' }, CORS) });
const plain = (t, status) => new Response(t, { status: status || 200, headers: Object.assign({ 'Content-Type': 'text/plain; charset=utf-8' }, CORS) });
const ID_RE = /^[a-f0-9]{32}$/;

async function readBody(request) {
  const t = await request.text();
  if (t.length > 20000) throw new Error('too big');
  return t ? JSON.parse(t) : {};
}

async function handleSync(env, request, now) {
  let b;
  try { b = await readBody(request); } catch (e) { return json({ error: 'Bad request' }, 400); }
  if (!ID_RE.test(String(b.id || ''))) return json({ error: 'Bad id' }, 400);
  let dev = await getDev(env, b.id);
  if (!dev) {
    const index = await getIndex(env);
    if (index.length >= MAX_DEVICES) return json({ error: 'This server is full.' }, 429);
    dev = newDevice(b.id, now);
    index.push(b.id);
    await env.KV.put('index', JSON.stringify(index));
  }
  const before = JSON.stringify(dev);
  if ('sub' in b) dev.sub = (b.sub && pushHostOk(b.sub.endpoint)) ? { endpoint: String(b.sub.endpoint) } : null;
  if (typeof b.tz === 'string' && validTz(b.tz)) dev.tz = b.tz;
  if (b.prefs) dev.prefs = cleanPrefs(b.prefs);
  if (b.status) {
    dev.status = cleanStatus(b.status);
    const key = dev.status.pending ? dev.status.pending.key : '';
    if (key !== dev.pendingKey) { dev.pendingKey = key; dev.pendingSent = 0; }
  }
  if (JSON.stringify(dev) !== before) await putDev(env, dev);   // saves KV writes when nothing changed
  return json({ ok: true, tz: dev.tz, schedule: dev.prefs.enabled ? slotsFor(dev).map(fmtHM) : [], hasDevice: !!dev.sub });
}

async function handleRequest(env, request, now) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, '') || '/';
  let m;

  if (path === '/') {
    const dev = (await getIndex(env)).length;
    return plain('Learn Anything reminder server is running. Devices: ' + dev + '.');
  }
  if (path === '/config') {
    const v = await getVapid(env);
    if (!v.subject) { v.subject = url.origin; await env.KV.put('vapid', JSON.stringify(v)); }
    return json({ publicKey: v.publicKey });
  }
  if (path === '/sync' && request.method === 'POST') return handleSync(env, request, now);

  if ((m = /^\/n\/([a-f0-9]{32})$/.exec(path))) {
    const dev = await getDev(env, m[1]);
    return json(dev && dev.outbox ? { title: dev.outbox.title, body: dev.outbox.body } : { title: 'Learn Anything', body: 'Your lesson is waiting.' });
  }
  if ((m = /^\/w\/([a-f0-9]{32})$/.exec(path))) {
    const dev = await getDev(env, m[1]);
    if (!dev) return json({ error: 'Unknown device. Open the app once so it can sync.' }, 404);
    return json(characterFor(dev.status, localParts(now, dev.tz).date, dev.prefs.images));
  }
  if (path === '/test' && request.method === 'POST') {
    let b;
    try { b = await readBody(request); } catch (e) { return json({ error: 'Bad request' }, 400); }
    const dev = ID_RE.test(String(b.id || '')) ? await getDev(env, b.id) : null;
    if (!dev || !dev.sub) return json({ ok: false, error: 'No phone is subscribed yet. Turn on reminders in the app first.' }, 400);
    dev.outbox = { title: 'Reminders work', body: 'This is a test. The real ones are less polite.', at: now };
    await putDev(env, dev);
    const r = await sendPush(env, dev.sub.endpoint, now);
    if (r.gone) { dev.sub = null; await putDev(env, dev); }
    return json({ ok: r.ok, status: r.status, error: r.ok ? '' : (r.gone ? 'The phone subscription expired. Turn reminders off and on again.' : 'The push service answered ' + r.status + '.') });
  }
  if (path === '/tiers') {
    const rawOk = url.searchParams.get('raw') !== '0';
    // For each tier: one clean sample, plus one with swearing when that is allowed.
    const vars = { lesson: 'Spanish Basics', streak: 5, days: 3 };
    const out = TIERS.map((list, t) => {
      const all = list.map((s, i) => parseMessage(s, t, i));
      const clean = all.find(x => !x.raw) || all[0];
      const samples = [fill(clean.text, vars)];
      const rough = rawOk ? all.find(x => x.raw) : null;
      if (rough) samples.push(fill(rough.text, vars));
      return { tier: t, title: TITLES[t], sample: samples[0], samples: samples };
    });
    return json({ tiers: out });
  }
  return json({ error: 'Not found' }, 404);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    if (!env.KV) return plain('Setup problem: add a KV namespace binding named KV to this Worker (Settings > Bindings).', 500);
    try { return await handleRequest(env, request, Date.now()); }
    catch (e) { return json({ error: 'Server error' }, 500); }
  },
  async scheduled(event, env, ctx) {
    if (!env.KV) return;
    ctx.waitUntil(runCron(env, event.scheduledTime || Date.now()));
  }
};

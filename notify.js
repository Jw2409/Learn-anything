/* Learn Anything: reminders and widget settings
 *
 * This file talks to YOUR reminder server (the Cloudflare Worker). It:
 *   - shows the "Reminders" and "Widget" sections in Settings
 *   - asks iPhone for permission and subscribes to push
 *   - tells the server your schedule and how you are doing (never your API
 *     key, lessons or answers): just "a lesson is due", streak and score
 *
 * It uses things defined in app.js (state, ui, render, saveState...).
 */
'use strict';

const NOTIFY_DEFAULTS = {
  server: '', id: '', enabled: false, mode: 'optimal',
  times: ['09:00', '13:00', '18:00', '21:00'],
  optimalTime: '18:00', adapt: true, raw: true,
  images: {}, schedule: []
};

// Characters for the widget (what each one means is explained in Settings).
const WIDGET_CHARS = [
  { key: 'cub',     name: 'Lion cub',      when: 'just starting out',                    hint: 'lion cub realistic' },
  { key: 'wolf',    name: 'Wolf',          when: 'building a streak',                    hint: 'wolf portrait' },
  { key: 'pegasus', name: 'Pegasus',       when: 'streak of 7+ days and 80%+ average',   hint: 'pegasus statue' },
  { key: 'god',     name: 'Greek god',     when: 'streak of 14+ days and 95%+ average (swaps daily with the robot)', hint: 'greek god statue' },
  { key: 'robot',   name: 'Robot',         when: 'same level as the god, on alternate days', hint: 'humanoid robot' },
  { key: 'knight',  name: 'Fallen knight', when: 'you lost a streak of 3+ days',         hint: 'kneeling knight armor' }
];

function randomId() {
  const a = new Uint8Array(16);
  crypto.getRandomValues(a);
  return Array.from(a).map(b => b.toString(16).padStart(2, '0')).join('');
}

// Always returns the same saved object (filling in anything missing), so a
// change made through one reference is never lost.
function getNotify() {
  const s = state.settings;
  if (!s.notify || typeof s.notify !== 'object') s.notify = {};
  const n = s.notify;
  Object.keys(NOTIFY_DEFAULTS).forEach(k => { if (!(k in n)) n[k] = JSON.parse(JSON.stringify(NOTIFY_DEFAULTS[k])); });
  if (!Array.isArray(n.times)) n.times = NOTIFY_DEFAULTS.times.slice();
  if (!Array.isArray(n.schedule)) n.schedule = [];
  if (!n.images || typeof n.images !== 'object') n.images = {};
  if (!n.id) n.id = randomId();
  return n;
}

/* ---------- what we tell the server ---------- */

function longestStreak(activity) {
  let best = 0, run = 0, prev = null;
  activity.slice().sort().forEach(d => {
    run = (prev && addDays(prev, 1) === d) ? run + 1 : 1;
    if (run > best) best = run;
    prev = d;
  });
  return best;
}

// The lesson that is waiting longest (first unfinished lesson of each course).
function pendingLesson() {
  let best = null;
  state.courses.forEach(c => {
    const i = c.lessons.findIndex(l => !l.completed);
    if (i < 0) return;
    const since = lessonDate(c, i);
    if (!best || since < best.since) best = { key: c.id + ':' + i, since: since, lesson: c.lessons[i].title, course: c.title };
  });
  return best;
}

function buildStatus() {
  const done = [];
  state.courses.forEach(c => c.lessons.forEach(l => { if (l.completed) done.push(l); }));
  const scored = done.filter(l => typeof l.score === 'number');
  const act = state.activity || [];
  const last = act.length ? act[act.length - 1] : '';
  return {
    pending: pendingLesson(),
    lastActive: last,
    streak: last ? currentStreak(act, last) : 0,   // the streak as it stood on your last active day
    best: longestStreak(act),
    activeDays: act.length,
    avgScore: scored.length ? Math.round(scored.reduce((s, l) => s + l.score, 0) / scored.length) : null,
    lessonsDone: done.length,
    completionMins: (state.completions || []).slice(-10),
    appUrl: location.href.split('#')[0].split('?')[0]
  };
}

async function currentSubscription() {
  try {
    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && await reg.pushManager.getSubscription();
    return sub ? { endpoint: sub.endpoint } : null;
  } catch (e) { return null; }
}

async function buildPayload() {
  const n = getNotify();
  return {
    id: n.id,
    sub: n.enabled ? await currentSubscription() : null,
    tz: (Intl.DateTimeFormat().resolvedOptions().timeZone) || 'UTC',
    prefs: { enabled: n.enabled, mode: n.mode, times: n.times, optimalTime: n.optimalTime, adapt: n.adapt, raw: n.raw, images: n.images },
    status: buildStatus()
  };
}

/* ---------- talking to the server ---------- */

let syncTimer = null;
let lastSentBody = '';

// Called after every save; only actually sends when something changed.
function scheduleSync() {
  const n = state && state.settings && state.settings.notify;
  if (!n || !n.server) return;
  clearTimeout(syncTimer);
  syncTimer = setTimeout(() => { syncServer(false).catch(() => {}); }, 1200);
}

async function syncServer(force) {
  const n = getNotify();
  if (!n.server) return null;
  const body = JSON.stringify(await buildPayload());
  if (!force && body === lastSentBody) return null;
  const res = await fetch(n.server + '/sync', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: body });
  if (!res.ok) throw new Error('The reminder server answered ' + res.status + '.');
  const out = await res.json();
  lastSentBody = body;
  const sched = JSON.stringify(out.schedule || []);
  if (sched !== JSON.stringify(n.schedule || [])) { n.schedule = out.schedule || []; saveState(); }
  return out;
}

function cleanServerUrl(s) {
  s = String(s || '').trim().replace(/\/+$/, '');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) s = 'https://' + s;   // forgive a missing https://
  if (!/^https:\/\/[^\s/]+\.[^\s/]+/.test(s)) throw new Error('The server address should start with https:// and look like https://something.workers.dev');
  return s;
}

async function serverJson(url, opts) {
  let res;
  try { res = await fetch(url, opts); } catch (e) { throw new Error('Could not reach the reminder server. Check the address and your connection.'); }
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch (e) { /* plain text */ }
  if (!res.ok) throw new Error((data && data.error) || text.slice(0, 200) || ('The server answered ' + res.status + '.'));
  return data || { text: text };
}

function urlB64ToBytes(s) {
  const pad = '='.repeat((4 - s.length % 4) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
function sameBytes(a, b) {
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function connectServer(address) {
  const n = getNotify();
  const server = cleanServerUrl(address);
  const out = await serverJson(server + '/');
  if (!/reminder server is running/i.test(out.text || '')) throw new Error('That address did not answer like a Learn Anything reminder server.');
  n.server = server;
  saveState();
  await syncServer(true);
}

async function registerWorker(n) {
  return navigator.serviceWorker.register('sw.js?w=' + encodeURIComponent(n.server) + '&id=' + encodeURIComponent(n.id));
}

async function enableReminders() {
  const n = getNotify();
  if (!n.server) throw new Error('Connect to your reminder server first.');
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    throw new Error('This browser cannot receive reminders. On iPhone: update to iOS 16.4 or newer, add the app to your Home Screen, and open it from there.');
  }
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('Notifications were not allowed. You can allow them in the iPhone Settings app under Notifications, then try again.');
  const cfg = await serverJson(n.server + '/config');
  await registerWorker(n);
  const reg = await navigator.serviceWorker.ready;
  const key = urlB64ToBytes(cfg.publicKey);
  let sub = await reg.pushManager.getSubscription();
  if (sub) {
    const cur = sub.options && sub.options.applicationServerKey ? new Uint8Array(sub.options.applicationServerKey) : null;
    if (!sameBytes(cur, key)) { await sub.unsubscribe(); sub = null; }   // the server's key changed
  }
  if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
  n.enabled = true;
  saveState();
  await syncServer(true);
}

async function disableReminders() {
  const n = getNotify();
  try {
    const reg = await navigator.serviceWorker.getRegistration();
    const sub = reg && await reg.pushManager.getSubscription();
    if (sub) await sub.unsubscribe();
  } catch (e) { /* ignore */ }
  n.enabled = false;
  saveState();
  await syncServer(true).catch(() => {});
}

/* ---------- Settings screen section ---------- */

function notifySettingsHtml() {
  const n = getNotify();
  let h = '<h2>Reminders</h2>';
  if (!n.server) {
    h += '<p class="muted">Reminders come from a small free server you set up once (steps are in SETUP-REMINDERS.md). Paste its address here.</p>' +
      '<label class="field" for="n-server">Reminder server address</label>' +
      '<input type="text" id="n-server" placeholder="https://learn-reminders.yourname.workers.dev" autocapitalize="off" spellcheck="false" autocomplete="off">' +
      '<div class="row"><button class="btn primary" data-naction="connect"' + (ui.busy ? ' disabled' : '') + '>Connect</button></div>';
    return h;
  }
  h += '<p class="muted">Connected to <strong>' + esc(n.server.replace(/^https:\/\//, '')) + '</strong>. <button class="linklike" data-naction="disconnect">Change server</button></p>';
  if (!n.enabled) {
    h += '<p>Reminders are off. On iPhone this only works from the Home Screen app (iOS 16.4 or newer).</p>' +
      '<div class="row"><button class="btn primary" data-naction="enable"' + (ui.busy ? ' disabled' : '') + '>Turn on reminders</button></div>';
  } else {
    h += '<div class="row"><button class="btn" data-naction="test"' + (ui.busy ? ' disabled' : '') + '>Send a test reminder</button>' +
      '<button class="btn" data-naction="disable"' + (ui.busy ? ' disabled' : '') + '>Turn off reminders</button></div>';
    h += '<fieldset class="q"><legend>When should reminders arrive?</legend>' +
      '<label class="opt"><input type="radio" name="n-mode" data-nfield="mode" value="optimal"' + (n.mode === 'optimal' ? ' checked' : '') + '><span><strong>Best spacing (recommended)</strong><br><span class="muted">One steady daily time, then follow-ups that spread further apart. A consistent cue is what builds a habit, and growing gaps keep it from turning into noise.</span></span></label>' +
      '<label class="opt"><input type="radio" name="n-mode" data-nfield="mode" value="custom"' + (n.mode === 'custom' ? ' checked' : '') + '><span><strong>My own times</strong><br><span class="muted">You choose exactly when.</span></span></label></fieldset>';
    if (n.mode === 'optimal') {
      h += '<label class="field" for="n-opt">My usual learning time</label><input type="time" id="n-opt" data-nfield="optimalTime" value="' + esc(n.optimalTime) + '">' +
        '<label class="check"><input type="checkbox" data-nfield="adapt"' + (n.adapt ? ' checked' : '') + '><span>Learn my habits<span class="help">After a few lessons, move the first reminder to shortly before the time you usually finish.</span></span></label>';
    } else {
      h += '<p class="field">Reminder times</p>';
      n.times.forEach((t, i) => {
        h += '<div class="row"><label class="sr-only" for="n-t' + i + '">Time ' + (i + 1) + '</label><input type="time" id="n-t' + i + '" data-nfield="time" data-i="' + i + '" value="' + esc(t) + '" style="max-width:10rem">' +
          '<button class="btn danger" data-naction="removeTime" data-i="' + i + '" aria-label="Remove ' + esc(t) + '">Remove</button></div>';
      });
      if (n.times.length < 12) h += '<div class="row"><button class="btn" data-naction="addTime">+ Add a time</button></div>';
    }
    h += '<label class="check"><input type="checkbox" data-nfield="raw"' + (n.raw ? ' checked' : '') + '><span>Allow swearing<span class="help">Unfiltered tough-love messages. Turn off if others can see your lock screen.</span></span></label>';
    h += '<p class="muted">The longer a lesson sits there, the harder the messages get. Never more than 8 a day.</p>';
    if (n.schedule && n.schedule.length) h += '<p>Today\'s reminder times: <strong>' + n.schedule.map(esc).join(', ') + '</strong></p>';
    h += '<div class="row"><button class="btn" data-naction="preview"' + (ui.busy ? ' disabled' : '') + '>Preview the messages</button></div>';
    if (ui.notifyPreview) {
      h += '<ol class="steps">' + ui.notifyPreview.map(t => '<li><strong>' + esc(t.title) + '</strong><br>' + t.samples.map(s => esc(s)).join('<br>') + '</li>').join('') + '</ol>';
    }
  }

  h += '<h2>Home-screen widget</h2>' +
    '<p class="muted">A picture that changes with how you are doing. Uses the free Scriptable app. Pick your own pictures below: use free-to-use photos (unsplash.com, pexels.com or commons.wikimedia.org with a free license). On a computer, right-click a photo and choose Copy image address.</p>' +
    '<div class="row"><button class="btn primary" data-naction="widgetScript">Copy widget script</button></div>';
  if (ui.widgetScript) {
    h += '<label class="field" for="n-script">Widget script (paste this into a new Scriptable script)</label><textarea id="n-script" readonly>' + esc(ui.widgetScript) + '</textarea>';
  }
  h += '<details class="course-stat" style="padding-top:.4rem" data-key="widget-pics"' + (ui.statOpen['widget-pics'] ? ' open' : '') + '><summary><strong>Widget pictures</strong> <span class="muted">(one web address per line, up to 4 per character)</span></summary>';
  WIDGET_CHARS.forEach(c => {
    h += '<label class="field" for="n-img-' + c.key + '">' + esc(c.name) + '</label><p class="muted" style="margin:.1rem 0">Shown when: ' + esc(c.when) + '. Try searching: ' + esc(c.hint) + '.</p>' +
      '<textarea id="n-img-' + c.key + '" data-nfield="images" data-key="' + c.key + '" style="min-height:4.5rem" placeholder="https://...jpg" autocapitalize="off" spellcheck="false">' + esc((n.images[c.key] || []).join('\n')) + '</textarea>';
  });
  h += '</details>';
  return h;
}

/* ---------- buttons on that screen ---------- */

async function notifyAction(a, el) {
  const n = getNotify();
  try {
    switch (a) {
      case 'connect': {
        const v = document.getElementById('n-server').value;
        await withBusy('Connecting...', () => connectServer(v));
        ui.message = { type: 'ok', text: 'Connected. Now turn on reminders.' };
        break;
      }
      case 'disconnect':
        if (!window.confirm('Disconnect from this reminder server? Reminders will stop until you connect again.')) return;
        if (n.enabled) await disableReminders();
        n.server = ''; n.schedule = []; saveState();
        break;
      case 'enable':
        await withBusy('Turning on reminders...', enableReminders);
        ui.message = { type: 'ok', text: 'Reminders are on. Tap "Send a test reminder" to check that they arrive.' };
        break;
      case 'disable':
        await withBusy('Turning off reminders...', disableReminders);
        ui.message = { type: 'ok', text: 'Reminders are off.' };
        break;
      case 'test': {
        const out = await withBusy('Sending a test...', async () => { await syncServer(true); return serverJson(n.server + '/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: n.id }) }); });
        ui.message = out.ok ? { type: 'ok', text: 'Sent. It should arrive in a few seconds. If nothing shows up, make sure notifications are allowed for this app in iPhone Settings.' } : { type: 'error', text: out.error || 'The test did not go through.' };
        break;
      }
      case 'addTime': n.times.push('12:00'); saveState(); break;
      case 'removeTime': n.times.splice(parseInt(el.dataset.i, 10), 1); saveState(); break;
      case 'preview': {
        const out = await withBusy('Loading...', () => serverJson(n.server + '/tiers?raw=' + (n.raw ? '1' : '0')));
        ui.notifyPreview = out.tiers;
        break;
      }
      case 'widgetScript': {
        if (!n.server) throw new Error('Connect to your reminder server first (see Reminders above).');
        await syncServer(true);
        const res = await fetch('widget.js', { cache: 'no-store' });
        if (!res.ok) throw new Error('Could not load the widget script.');
        const script = (await res.text()).split('__SERVER__').join(n.server).split('__ID__').join(n.id);
        ui.widgetScript = script;
        let copied = false;
        try { await navigator.clipboard.writeText(script); copied = true; } catch (e) { /* user can copy by hand */ }
        ui.message = { type: 'ok', text: copied ? 'Copied. Open Scriptable, tap +, paste, and name it Learn Widget.' : 'Select the text in the box below, copy it, then paste it into a new Scriptable script.' };
        break;
      }
    }
  } catch (e) { setError(e); }
  render();
}

function notifyField(el) {
  const n = getNotify();
  const f = el.dataset.nfield;
  if (f === 'mode') n.mode = el.value === 'custom' ? 'custom' : 'optimal';
  else if (f === 'optimalTime') { if (/^\d{2}:\d{2}$/.test(el.value)) n.optimalTime = el.value; }
  else if (f === 'adapt') n.adapt = el.checked;
  else if (f === 'raw') n.raw = el.checked;
  else if (f === 'time') { if (/^\d{2}:\d{2}$/.test(el.value)) n.times[parseInt(el.dataset.i, 10)] = el.value; }
  else if (f === 'images') {
    n.images[el.dataset.key] = el.value.split(/\s+/).map(x => x.trim()).filter(x => /^https:\/\/\S{4,400}$/.test(x)).slice(0, 4);
  }
  saveState();
  if (f === 'mode') render();
}

function initNotify() {
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-naction]');
    if (!b || b.disabled) return;
    notifyAction(b.dataset.naction, b);
  });
  document.addEventListener('change', e => {
    if (e.target.dataset && e.target.dataset.nfield) notifyField(e.target);
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') scheduleSync(); });
  // Keep the service worker registered and the server up to date when the app opens.
  const n = state.settings.notify;
  if (n && n.server && n.enabled && 'serviceWorker' in navigator) registerWorker(n).catch(() => {});
  scheduleSync();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initNotify); else initNotify();
}

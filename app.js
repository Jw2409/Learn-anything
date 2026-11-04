/* Learn Anything
 * A single-page app with no build step. Everything is saved in your own
 * browser (localStorage). The only outside service it talks to is the AI
 * provider you configure in Settings (Gemini by default).
 *
 * Layout of this file:
 *   1. Settings, teaching-method list, saved data
 *   2. Small helpers (dates, text safety, streaks)
 *   3. Teaching logic: schedule + spaced repetition (plain code, no AI)
 *   4. AI: the ONE place that talks to the AI provider (callAI) + prompts
 *   5. Screens (what you see)
 *   6. Buttons and events
 */
'use strict';

/* ================= 1. Settings and saved data ================= */

const STORE_KEY = 'learnanything.v1';
const MAX_LESSONS = 40;

// Every teaching method is a switch. Some change what the AI is asked to
// write; others change what the app itself does.
const METHOD_INFO = {
  preTest:        { label: 'Pre-test',            help: 'A few ungraded questions BEFORE the lesson to prime your brain.' },
  recall:         { label: 'Quiz after the lesson (active recall)', help: 'Testing yourself beats rereading.' },
  spaced:         { label: 'Spaced repetition',   help: 'Old questions return on a schedule, just before you would forget them.' },
  interleave:     { label: 'Interleaving',        help: 'Each quiz also mixes in questions from earlier lessons.' },
  explainBack:    { label: 'Explain it back',     help: 'Write a short summary in your own words and get AI feedback.' },
  workedExamples: { label: 'Worked examples',     help: 'A full step-by-step example in each lesson.' },
  analogies:      { label: 'Analogies',           help: 'Ideas explained through everyday comparisons.' },
  chunking:       { label: 'Chunking',            help: 'Short pages instead of long blocks of text.' },
  visuals:        { label: 'Visuals',             help: 'Simple diagrams in the lesson: step-by-step flows, side-by-side comparisons and timelines.' }
};

function defaultState() {
  return {
    settings: {
      apiKey: '',
      backupKeys: '',   // more API keys, one per line (used if the main one runs out)
      keyStatus: {},    // which keys are resting, and until when
      model: 'gemini-2.5-flash',
      theme: 'auto',
      fontScale: 1,
      spacing: 'normal',
      easyFont: false,
      reduceMotion: false,
      allowAhead: false,
      methods: {
        preTest: false, recall: true, spaced: true, interleave: true,
        explainBack: false, workedExamples: true, analogies: true, chunking: true, visuals: true
      }
    },
    courses: [],
    cards: [],
    bookmarks: [],
    activity: [],     // days (YYYY-MM-DD) when you learned something; drives your streak
    completions: []   // time of day (minutes after midnight) when you finished lessons; used by "best spacing" reminders
  };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return defaultState();
    const p = JSON.parse(raw);
    const d = defaultState();
    return {
      settings: Object.assign({}, d.settings, p.settings, {
        methods: Object.assign({}, d.settings.methods, (p.settings && p.settings.methods) || {})
      }),
      courses: Array.isArray(p.courses) ? p.courses : [],
      cards: Array.isArray(p.cards) ? p.cards : [],
      bookmarks: Array.isArray(p.bookmarks) ? p.bookmarks : [],
      activity: Array.isArray(p.activity) ? p.activity : [],
      completions: Array.isArray(p.completions) ? p.completions : []
    };
  } catch (e) {
    return defaultState();
  }
}

let state = (typeof localStorage !== 'undefined') ? loadState() : defaultState();

// What is on screen right now (not saved).
const ui = {
  view: 'home',      // home | new | course | lesson | review | stats | settings
  courseId: null,
  session: null,     // the lesson in progress
  review: null,      // the review in progress
  message: null,     // {type:'error'|'ok', text}
  busy: null,        // text while waiting for the AI
  log: [],           // live "what the AI is doing" lines
  draft: {},         // keeps the "new course" form filled in after an error
  statOpen: {},      // which dropdowns on the Stats tab are open
  focus: null        // CSS selector to focus after drawing
};

function saveState() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch (e) {
    ui.message = { type: 'error', text: 'Could not save to this browser. Storage may be full or blocked (private browsing?).' };
  }
  if (typeof scheduleSync === 'function') scheduleSync();   // tell the reminder server, if you set one up (notify.js)
}

/* ================= 2. Helpers ================= */

// Everything the AI writes goes through esc() before it is shown, so odd
// characters can never break the page.
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function paras(s) {
  return String(s || '').split(/\n+/).filter(x => x.trim()).map(p => '<p>' + esc(p) + '</p>').join('');
}
function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
function shuffle(a) {
  a = a.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

// Dates are kept as plain 'YYYY-MM-DD' text in your local time.
function todayStr(d) {
  d = d || new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function parseDay(s) { const p = s.split('-').map(Number); return new Date(p[0], p[1] - 1, p[2], 12, 0, 0); }
function addDays(s, n) { const d = parseDay(s); d.setDate(d.getDate() + n); return todayStr(d); }
function niceDate(s) {
  return parseDay(s).toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
}

// Streak = how many days in a row you learned something. It stays alive
// through today if you have not studied yet but did yesterday.
function markActive(day) {
  day = day || todayStr();
  if (state.activity.indexOf(day) < 0) {
    state.activity.push(day);
    state.activity.sort();
    if (state.activity.length > 1500) state.activity = state.activity.slice(-1500);
  }
}
function currentStreak(activity, today) {
  today = today || todayStr();
  const set = new Set(activity);
  let d = set.has(today) ? today : addDays(today, -1);
  let n = 0;
  while (set.has(d)) { n++; d = addDays(d, -1); }
  return n;
}

// Score -> stars (0-5), color tone and a word (so color is never the only clue).
function rating(pct) {
  return {
    stars: Math.round(pct / 20),
    tone: pct >= 80 ? 'good' : pct >= 60 ? 'warn' : 'bad',
    word: pct >= 80 ? 'Strong' : pct >= 60 ? 'Getting there' : 'Needs work'
  };
}
function starsHtml(n, tone) {
  let s = '';
  for (let i = 0; i < 5; i++) s += i < n ? '★' : '☆';
  return '<span class="stars ' + tone + '" role="img" aria-label="' + n + ' out of 5 stars">' + s + '</span>';
}

/* ================= 3. Teaching logic (no AI needed) ================= */

const PERIOD_DAYS = { daily: 1, weekly: 7, monthly: 30 };
const PERIOD_MINUTES = { daily: 10, weekly: 20, monthly: 30 };
const PERIOD_NAME = { daily: 'day', weekly: 'week', monthly: 'month' };

// When lesson number i (0-based) becomes available.
function lessonDate(course, i) { return addDays(course.start, i * PERIOD_DAYS[course.period]); }

// 'done' | 'locked-order' | 'locked-date' | 'ready'
function lessonStatus(course, i, settings, today) {
  today = today || todayStr();
  if (course.lessons[i].completed) return 'done';
  if (i > 0 && !course.lessons[i - 1].completed) return 'locked-order';
  if (lessonDate(course, i) > today && !settings.allowAhead) return 'locked-date';
  return 'ready';
}

// Spaced repetition (Leitner boxes): right answer = move up a box and wait
// longer; wrong answer = back to box 0 and see it again tomorrow.
const INTERVALS = [1, 2, 4, 8, 16, 32];
function nextBox(box, correct) { return correct ? Math.min(box + 1, INTERVALS.length - 1) : 0; }
function gradeCard(card, correct, today) {
  card.box = nextBox(card.box, correct);
  card.due = addDays(today || todayStr(), INTERVALS[card.box]);
}
function dueCards(cards, today) {
  today = today || todayStr();
  return cards.filter(c => c.due <= today).sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0));
}
// Interleaving: pick older questions, weakest boxes first.
function pickInterleaved(cards, courseId, lessonIndex, n) {
  const pool = shuffle(cards.filter(c => c.courseId === courseId && c.lessonIndex < lessonIndex));
  pool.sort((a, b) => a.box - b.box);
  return pool.slice(0, n);
}

// A lesson is shown like a book: one "page" per section, plus pages for the
// analogy, the worked example and the key takeaways.
function buildPages(content) {
  const pages = [];
  content.sections.forEach(s => pages.push({ kind: 'text', heading: s.heading || 'Lesson', text: s.text, visual: s.visual || null }));
  if (content.analogy) pages.push({ kind: 'analogy', heading: 'Think of it this way', text: content.analogy });
  if (content.workedExample) pages.push({ kind: 'example', heading: 'Worked example', problem: content.workedExample.problem, steps: content.workedExample.steps });
  if (content.keyTakeaways && content.keyTakeaways.length) pages.push({ kind: 'takeaways', heading: 'Key takeaways', points: content.keyTakeaways });
  return pages;
}
function pageText(p) {
  if (p.kind === 'example') return p.heading + '. ' + p.problem + ' ' + p.steps.join('. ');
  if (p.kind === 'takeaways') return p.heading + '. ' + p.points.join('. ');
  return p.heading + '. ' + p.text;
}

function hasBookmark(courseId, lessonIndex, page) {
  return state.bookmarks.some(b => b.courseId === courseId && b.lessonIndex === lessonIndex && b.page === page);
}

/* ================= 4. The AI (swap providers here) ================= */

function parseJSON(text) {
  let t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch (e) {
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e2) { /* fall through */ } }
    throw new Error('The AI answer was not in the expected format. Please try again.');
  }
}

// While the AI writes, its JSON answer starts with a "log" list of what it is
// working on. This pulls out the finished lines from the half-written text so
// they can be shown live.
function extractLog(text) {
  const m = /"log"\s*:\s*\[/.exec(text);
  if (!m) return [];
  const rest = text.slice(m.index + m[0].length);
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"\s*(,|\])?/g;
  let x;
  while ((x = re.exec(rest))) {
    try { out.push(String(JSON.parse('"' + x[1] + '"')).slice(0, 140)); } catch (e) { /* skip */ }
    if (x[2] === ']') break;
  }
  return out.slice(0, 8);
}

// ----- API keys: a main key plus optional backups -----
// A "key" is like a ticket to use Google's AI. Each ticket has a daily/minute
// allowance. If one is used up it "rests" until its allowance comes back, and
// the app moves on to the next ticket.

function keyId(k) {
  let h = 5381;
  for (let i = 0; i < k.length; i++) h = ((h * 33) ^ k.charCodeAt(i)) >>> 0;
  return h.toString(36);
}
function apiKeys() {
  const s = state.settings;
  const all = [s.apiKey].concat(String(s.backupKeys || '').split(/\s+/)).map(k => String(k || '').trim()).filter(Boolean);
  return all.filter((k, i) => all.indexOf(k) === i);
}
function keyLabel(k, i) { return 'Key ' + (i + 1) + ' (...' + k.slice(-4) + ')'; }
function keyRest(k) {
  const st = (state.settings.keyStatus || {})[keyId(k)];
  return st && st.until > Date.now() ? st : null;
}
function restKey(k, until, why) {
  if (!state.settings.keyStatus) state.settings.keyStatus = {};
  state.settings.keyStatus[keyId(k)] = { until: until, why: why };
  saveState();
}
function clockTime(ms) { return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }

// Google's daily free limits reset at midnight Pacific time.
function msUntilPacificMidnight(now) {
  const o = {};
  new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hourCycle: 'h23', hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(now)).forEach(p => { o[p.type] = parseInt(p.value, 10); });
  return 24 * 3600 * 1000 - (((o.hour % 24) * 3600 + o.minute * 60 + o.second) * 1000);
}
// How long a key that hit its limit should rest, judging from Google's message.
function quotaRest(detail, now) {
  now = now || Date.now();
  const d = String(detail || '');
  if (/PerDay|per day|daily/i.test(d)) return { until: now + msUntilPacificMidnight(now) + 60000, why: 'daily limit reached' };
  const m = /"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(d) || /retry in (\d+(?:\.\d+)?)s/i.exec(d);
  const sec = m ? Math.ceil(parseFloat(m[1])) + 2 : 65;
  return { until: now + Math.min(sec, 3600) * 1000, why: 'minute limit reached' };
}

function aiError(kind, message, extra) {
  const e = new Error(message);
  e.kind = kind;   // quota | badkey | busy | network | drop | other
  return Object.assign(e, extra || {});
}

// One line of the streaming answer ("data: {...}") -> the text inside it.
function sseText(line) {
  if (line.indexOf('data:') !== 0) return '';
  const payload = line.slice(5).trim();
  if (!payload || payload === '[DONE]') return '';
  let o;
  try { o = JSON.parse(payload); } catch (e) { return ''; }
  if (o.error) {
    throw aiError(o.error.code === 429 || o.error.status === 'RESOURCE_EXHAUSTED' ? 'quota' : 'other', 'AI error: ' + (o.error.message || 'unknown'), { detail: payload });
  }
  const parts = o.candidates && o.candidates[0] && o.candidates[0].content && o.candidates[0].content.parts;
  return parts ? parts.filter(p => !p.thought).map(p => p.text || '').join('') : '';
}

// Ask the AI once, with one key. Returns the text it wrote. If it breaks off
// part-way, the error carries what was written so far (e.partial).
async function streamOnce(key, prompt, onText, jsonMode) {
  const s = state.settings;
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(s.model) + ':streamGenerateContent?alt=sse';
  const gen = { temperature: 0.7 };
  if (jsonMode) gen.responseMimeType = 'application/json';
  let res;
  // Google's free models sometimes answer 503 ("busy"). That is shared
  // capacity, not your key, so wait a moment and try again (up to 3 retries).
  const waits = [2000, 5000, 10000];
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: gen })
      });
    } catch (e) {
      throw aiError('network', 'Could not reach the AI. Check your internet connection.');
    }
    if (res.status === 503 && attempt < waits.length) {
      await new Promise(r => setTimeout(r, waits[attempt]));
      continue;
    }
    break;
  }
  if (res.status === 503) {
    throw aiError('busy', 'Google\'s AI is busy right now. This is shared capacity, not a problem with your key. Wait a minute and try again, or change the model name in Settings to a lighter one such as gemini-2.5-flash-lite.');
  }
  if (!res.ok) {
    let raw = '', detail = '';
    try { raw = await res.text(); detail = (JSON.parse(raw).error || {}).message || ''; } catch (e) { /* ignore */ }
    if (res.status === 429) throw aiError('quota', 'The free AI limit was reached. Wait a minute and try again.', { detail: raw });
    if (res.status === 403 || (res.status === 400 && /API key not valid|API_KEY_INVALID|API key expired/i.test(raw))) {
      throw aiError('badkey', 'The AI rejected the request. Check your API key and model name in Settings. ' + detail, { detail: raw });
    }
    if (res.status === 400) throw aiError('other', 'The AI rejected the request. Check your API key and model name in Settings. ' + detail);
    if (res.status === 404) throw aiError('other', 'That model name was not found. Change the model in Settings. ' + detail);
    throw aiError('other', 'AI error ' + res.status + '. ' + detail);
  }
  let text = '', buf = '';
  try {
    if (res.body && res.body.getReader) {
      const reader = res.body.getReader(), dec = new TextDecoder();
      for (;;) {
        let chunk;
        try { chunk = await reader.read(); } catch (e) { throw aiError('drop', 'The connection dropped while the AI was writing. Please try again.'); }
        if (chunk.done) break;
        buf += dec.decode(chunk.value, { stream: true });
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) { text += sseText(buf.slice(0, nl).trim()); buf = buf.slice(nl + 1); }
        if (onText) onText(text);
      }
      text += sseText(buf.trim());
    } else {
      (await res.text()).split('\n').forEach(l => { text += sseText(l.trim()); });
    }
  } catch (e) {
    e.partial = text;
    throw e;
  }
  if (onText) onText(text);
  if (!text) throw aiError('other', 'The AI returned an empty answer. Please try again.');
  return text;
}

// When a key gives out in the middle of an answer, the next key is shown
// exactly what was written so far and asked to carry on from that character.
function continuationPrompt(prompt, partial) {
  return prompt + '\n\nIMPORTANT: an earlier attempt at this answer was cut off. Everything written so far is between the markers below.\n<<<START\n' + partial + '\nEND>>>\n' +
    'Continue from exactly the next character after the last character shown. Output ONLY the remaining text, with no repetition of anything above, no code fences and no commentary, so that the old text followed by your text forms one complete, valid JSON answer.';
}
// Glue the new text onto the old, removing anything the AI repeated.
function joinContinuation(partial, more) {
  more = String(more).replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const max = Math.min(partial.length, more.length, 300);
  for (let n = max; n >= 12; n--) {
    if (partial.slice(-n) === more.slice(0, n)) { more = more.slice(n); break; }
  }
  return partial + more;
}

function restingMessage(keys, lastErr) {
  if (keys.length === 1 && lastErr && lastErr.kind !== 'quota') return lastErr.message;
  const waits = keys.map(k => keyRest(k)).filter(Boolean);
  if (!waits.length && lastErr) return lastErr.message;
  const soonest = waits.length ? Math.min.apply(null, waits.map(w => w.until)) : 0;
  if (keys.length === 1) return 'The free AI limit was reached. Wait a minute and try again' + (soonest ? ' (ready again about ' + clockTime(soonest) + ')' : '') + '.';
  return 'All ' + keys.length + ' API keys are used up or were rejected right now' + (soonest ? '. The first one is ready again about ' + clockTime(soonest) : '') + '. You can check each key in Settings.';
}

// To use a different AI later, change streamOnce (and the key handling above).
// callAI takes a prompt, calls onText(textSoFar) while the answer streams in,
// and returns a JavaScript object parsed from the AI's JSON answer. It walks
// through your keys in order, skipping any that are resting.
async function callAI(prompt, onText, onNote) {
  onNote = onNote || (typeof setBusyNote === 'function' ? setBusyNote : null);
  const keys = apiKeys();
  if (!keys.length) throw new Error('Add your Gemini API key in Settings first.');
  const queue = keys.filter(k => !keyRest(k));
  if (!queue.length) throw new Error(restingMessage(keys, null));
  let partial = '', lastErr = null, dropRetried = false;
  while (queue.length) {
    const key = queue.shift(), idx = keys.indexOf(key), cont = partial.length > 0;
    try {
      if (onNote && (cont || idx > 0)) onNote(keyLabel(key, idx) + (cont ? ': carrying on from where the last key stopped' : ': working on it'));
      const text = await streamOnce(key, cont ? continuationPrompt(prompt, partial) : prompt, cont ? (t => onText && onText(partial + t)) : onText, !cont);
      if (!cont) return parseJSON(text);
      try { return parseJSON(joinContinuation(partial, text)); } catch (e1) {
        try { return parseJSON(text); } catch (e2) {   // the AI may have rewritten the whole answer
          lastErr = e1; partial = '';
          if (onNote) onNote('The joined answer did not fit together, starting that part again');
          continue;
        }
      }
    } catch (e) {
      lastErr = e;
      if (e.partial && (e.kind === 'quota' || e.kind === 'drop')) partial = cont ? joinContinuation(partial, e.partial) : e.partial;
      if (e.kind === 'quota') {
        const r = quotaRest(e.detail);
        restKey(key, r.until, r.why);
        if (onNote && queue.length) onNote(keyLabel(key, idx) + ' is out of quota. Switching keys.');
        continue;
      }
      if (e.kind === 'badkey') {
        restKey(key, Date.now() + 3600 * 1000, 'rejected by Google');
        if (onNote && queue.length) onNote(keyLabel(key, idx) + ' was rejected. Switching keys.');
        continue;
      }
      if (e.kind === 'drop' && !dropRetried) { dropRetried = true; queue.push(key); continue; }
      throw e;
    }
  }
  throw new Error(restingMessage(keys, lastErr));
}

// Check every key once and report.
async function testAllKeys() {
  const keys = apiKeys();
  if (!keys.length) throw new Error('Add your Gemini API key first.');
  const results = [];
  for (let i = 0; i < keys.length; i++) {
    try {
      await streamOnce(keys[i], 'Reply with exactly this JSON: {"ok": true}', null, true);
      if (state.settings.keyStatus) delete state.settings.keyStatus[keyId(keys[i])];
      results.push({ ok: true, text: keyLabel(keys[i], i) + ' works' });
    } catch (e) {
      if (e.kind === 'quota') { const r = quotaRest(e.detail); restKey(keys[i], r.until, r.why); results.push({ ok: false, text: keyLabel(keys[i], i) + ' is out of quota (' + r.why + ')' }); }
      else if (e.kind === 'badkey') { restKey(keys[i], Date.now() + 3600 * 1000, 'rejected by Google'); results.push({ ok: false, text: keyLabel(keys[i], i) + ' was rejected. Check that you copied it correctly.' }); }
      else results.push({ ok: false, text: keyLabel(keys[i], i) + ': ' + e.message });
    }
  }
  saveState();
  return results;
}

const LOG_SHAPE = '"log": ["3 to 5 short status lines about what you are doing right now, in the style \'Compiling topic - <specific thing>\', \'Reviewing <specific thing>\' or \'Setting up <specific thing>\'"]';

function buildOutlinePrompt(d) {
  const mins = PERIOD_MINUTES[d.period];
  const countRule = d.count
    ? 'Create a course with exactly ' + d.count + ' lessons, one per ' + PERIOD_NAME[d.period] + ', each about ' + mins + ' minutes long.'
    : 'Decide how many lessons this topic needs, from 3 to ' + MAX_LESSONS + ', based on how broad and deep the topic is and the learner level. One lesson is given per ' + PERIOD_NAME[d.period] + ' and each lesson is about ' + mins + ' minutes long. Do not pad a small topic and do not cram a big one. Give a one-sentence reason in "reason".';
  return [
    'You are an expert curriculum designer who uses evidence-based teaching.',
    'Topic the learner wants to learn: ' + d.topic,
    'Learner level: ' + d.level + '.',
    d.notes ? 'Learner notes and goals: ' + d.notes : '',
    countRule,
    'Order the lessons so each builds on the previous ones. Do not repeat content across lessons.',
    'Return ONLY JSON in this shape. The first key must be "log":',
    '{' + LOG_SHAPE + ', "title": "short course title", "reason": "why this many lessons", "lessons": [{"title": "lesson title", "summary": "one sentence on what this lesson covers"}]}'
  ].filter(Boolean).join('\n');
}

function buildLessonPrompt(course, i, m) {
  const l = course.lessons[i];
  const outline = course.lessons.map((x, k) => (k + 1) + '. ' + x.title).join('\n');
  const rules = [
    'Write for a ' + course.level + ' learner in plain, friendly language. No markdown symbols.',
    'Only state things you are confident are true. If something is uncertain or debated, say so.',
    'The whole lesson should take about ' + PERIOD_MINUTES[course.period] + ' minutes to read, split across its pages.',
    m.chunking
      ? 'Use 4 to 7 short sections. Each section is one page of a book: a clear heading and at most about 120 words.'
      : 'Use 3 to 5 sections. Each section is one page of a book: a clear heading and at most about 250 words.'
  ];
  const shape = [LOG_SHAPE, '"title": "lesson title"', '"sections": [{"heading": "...", "text": "..."' + (m.visuals ? ', "visual": OPTIONAL' : '') + '}]', '"keyTakeaways": ["3 to 5 short points"]'];
  if (m.visuals) {
    rules.push('Add a simple diagram to 1 to 3 sections where a picture helps most (a process, a comparison, a sequence in time). Put it in that section\'s "visual" field and leave the field out of other sections. Use only these formats: {"type":"flow","title":"...","alt":"one sentence describing the diagram","steps":["...","..."]} or {"type":"compare","title":"...","alt":"...","columns":[{"heading":"...","points":["..."]}]} (2 or 3 columns) or {"type":"timeline","title":"...","alt":"...","events":[{"label":"...","text":"..."}]}. Keep every item short.');
  }
  if (m.analogies) {
    rules.push('Include one memorable everyday analogy that explains the hardest idea.');
    shape.push('"analogy": "the analogy, 2 to 4 sentences"');
  }
  if (m.workedExamples) {
    rules.push('Include one worked example that shows every step, where it fits the topic.');
    shape.push('"workedExample": {"problem": "...", "steps": ["step 1", "step 2"]}');
  }
  const q = '{"q": "question", "options": ["A", "B", "C", "D"], "correctIndex": 0, "explanation": "why the answer is right"}';
  if (m.preTest) {
    rules.push('Write 3 pre-test questions about what this lesson will teach. Learners may not know the answers yet.');
    shape.push('"preTest": [' + q + ' ...3 items]');
  }
  if (m.recall || m.interleave || m.spaced) {
    rules.push('Write 5 multiple-choice quiz questions that test understanding of THIS lesson, not just memory of wording. Exactly 4 options each, one clearly correct, never use "all of the above" or "none of the above".');
    shape.push('"quiz": [' + q + ' ...5 items]');
  }
  if (m.explainBack) {
    shape.push('"explainPrompt": "one prompt asking the learner to explain the main idea in their own words"');
  }
  return [
    'You are a skilled teacher creating one lesson of a course.',
    'Course: ' + course.title,
    'All lessons:\n' + outline,
    'This lesson is number ' + (i + 1) + ': ' + l.title + ' (' + l.summary + ')',
    '',
    'Rules:',
    rules.map(r => '- ' + r).join('\n'),
    '',
    'Return ONLY JSON in this shape. The first key must be "log":',
    '{' + shape.join(', ') + '}'
  ].join('\n');
}

function buildFeedbackPrompt(course, lesson, content, text) {
  return [
    'You are a kind, honest teacher. A learner just studied this lesson and wrote a summary in their own words.',
    'Course: ' + course.title + '. Lesson: ' + lesson.title + '.',
    'Key points the lesson taught: ' + (content.keyTakeaways || []).join('; '),
    'Learner summary: ' + text,
    'Give brief feedback: what they got right, anything wrong or missing, and one tip. Keep it under 150 words, plain text.',
    'Return ONLY JSON: {"feedback": "..."}'
  ].join('\n');
}

function buildCoachPrompt(course, lesson) {
  const r = lesson.result || { right: [], missed: [], score: 0 };
  return [
    'You are a supportive, honest teacher reviewing a learner\'s results.',
    'Course: ' + course.title + '. Lesson: ' + lesson.title + '. Quiz score: ' + (lesson.score == null ? 'no quiz taken' : lesson.score + '%') + '.',
    'Questions answered correctly: ' + (r.right.length ? r.right.join(' | ') : 'none'),
    'Questions missed: ' + (r.missed.length ? r.missed.map(x => x.q + ' (they chose "' + x.yours + '", correct was "' + x.right + '")').join(' | ') : 'none'),
    lesson.explainFeedback ? 'Feedback they got on their own summary: ' + lesson.explainFeedback : '',
    'Write two short plain-text paragraphs. "didWell": what they clearly understand. "improve": the specific gaps and two concrete things to do next. No flattery.',
    'Return ONLY JSON: {"didWell": "...", "improve": "..."}'
  ].filter(Boolean).join('\n');
}

// Make sure a question from the AI is usable, and shuffle its options so the
// right answer is not always in the same spot.
function cleanQuestion(q) {
  if (!q || typeof q.q !== 'string' || !Array.isArray(q.options)) return null;
  const ci = parseInt(q.correctIndex, 10);
  if (!(ci >= 0 && ci < q.options.length)) return null;
  const correctText = String(q.options[ci]);
  const opts = shuffle(Array.from(new Set(q.options.map(String).filter(o => o.trim()))));
  const correct = opts.indexOf(correctText);
  if (opts.length < 2 || correct < 0) return null;
  return { q: q.q, options: opts, correct: correct, explanation: String(q.explanation || '') };
}

// Check a diagram description from the AI. Anything odd is dropped, never shown.
function cleanVisual(v) {
  if (!v || typeof v !== 'object') return null;
  const str = x => String(x == null ? '' : x).slice(0, 200);
  const base = { title: str(v.title), alt: str(v.alt) };
  if (v.type === 'flow' && Array.isArray(v.steps) && v.steps.length >= 2) {
    return Object.assign(base, { type: 'flow', steps: v.steps.slice(0, 8).map(str) });
  }
  if (v.type === 'compare' && Array.isArray(v.columns) && v.columns.length >= 2) {
    return Object.assign(base, { type: 'compare', columns: v.columns.slice(0, 3).map(c => ({ heading: str(c && c.heading), points: ((c && Array.isArray(c.points)) ? c.points : []).slice(0, 6).map(str) })) });
  }
  if (v.type === 'timeline' && Array.isArray(v.events) && v.events.length >= 2) {
    return Object.assign(base, { type: 'timeline', events: v.events.slice(0, 8).map(e => ({ label: str(e && e.label), text: str(e && e.text) })) });
  }
  return null;
}

function cleanLesson(o) {
  if (!o || !Array.isArray(o.sections) || !o.sections.length) {
    throw new Error('The AI did not return a usable lesson. Please try again.');
  }
  const sections = o.sections.filter(s => s && s.text).map(s => ({ heading: String(s.heading || ''), text: String(s.text), visual: cleanVisual(s.visual) }));
  if (!sections.length) throw new Error('The AI did not return a usable lesson. Please try again.');
  return {
    sections: sections,
    analogy: o.analogy ? String(o.analogy) : '',
    workedExample: (o.workedExample && o.workedExample.problem)
      ? { problem: String(o.workedExample.problem), steps: (o.workedExample.steps || []).map(String) } : null,
    keyTakeaways: (o.keyTakeaways || []).map(String),
    preTest: (o.preTest || []).map(cleanQuestion).filter(Boolean),
    quiz: (o.quiz || []).map(cleanQuestion).filter(Boolean),
    explainPrompt: String(o.explainPrompt || 'In your own words, explain the main idea of this lesson.')
  };
}

/* ================= 5. Screens ================= */

function applySettings() {
  const s = state.settings, r = document.documentElement;
  r.dataset.theme = s.theme;
  r.style.setProperty('--scale', s.fontScale);
  r.dataset.spacing = s.spacing;
  r.dataset.easyfont = s.easyFont ? '1' : '0';
  r.dataset.motion = s.reduceMotion ? 'reduce' : 'normal';
}

function announce(text) {
  const el = document.getElementById('live');
  if (el) { el.textContent = ''; setTimeout(() => { el.textContent = text; }, 50); }
}

function render() {
  applySettings();
  const main = document.getElementById('main');
  let html = '';
  if (ui.message) {
    html += '<div class="msg ' + ui.message.type + '" role="' + (ui.message.type === 'error' ? 'alert' : 'status') + '">' + esc(ui.message.text) + '</div>';
  }
  if (ui.busy) {
    html += '<div class="busy" role="status"><strong>' + esc(ui.busy) + '</strong><p id="busy-note" class="muted" style="margin:.2rem 0">' + esc(ui.busyNote || '') + '</p><ul id="busy-log" class="plain" aria-hidden="true">' +
      ui.log.map(l => '<li>' + esc(l) + '</li>').join('') + '</ul></div>';
  }
  const titles = { home: 'Learn Anything', new: 'New course', course: 'Course', lesson: 'Lesson', review: 'Review', stats: 'Stats', settings: 'Settings' };
  const title = titles[ui.view] || 'Learn Anything';
  switch (ui.view) {
    case 'home': html += viewHome(); break;
    case 'new': html += viewNew(); break;
    case 'course': html += viewCourse(); break;
    case 'lesson': html += viewLesson(); break;
    case 'review': html += viewReview(); break;
    case 'stats': html += viewStats(); break;
    case 'settings': html += viewSettings(); break;
  }
  main.innerHTML = html;
  document.getElementById('title').textContent = title;
  document.title = title === 'Learn Anything' ? title : title + ' - Learn Anything';
  ['home', 'review', 'stats', 'settings'].forEach(v => {
    const b = document.getElementById('nav-' + v);
    if (!b) return;
    const active = (ui.view === v) || (v === 'home' && ['new', 'course', 'lesson'].indexOf(ui.view) >= 0);
    if (active) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
  const reviewBtn = document.getElementById('nav-review');
  if (reviewBtn) reviewBtn.hidden = !state.settings.methods.spaced;
  if (ui.focus) {
    const el = document.querySelector(ui.focus);
    if (el) el.focus();
    ui.focus = null;
  }
}

function go(view, opts) {
  ui.view = view;
  ui.message = null;
  Object.assign(ui, opts || {});
  ui.focus = ui.focus || '#main';
  window.scrollTo(0, 0);
  render();
}

function getCourse(id) { return state.courses.find(c => c.id === id); }

function viewHome() {
  const due = dueCards(state.cards).length;
  const streak = currentStreak(state.activity);
  let h = '';
  if (!state.courses.length) {
    h += '<section class="card"><h2>Welcome</h2>' +
      '<p>Type in anything you want to learn. The app plans a course and gives you one lesson per day, week or month, using proven teaching methods you can switch on and off.</p>' +
      '<p>First open <strong>Settings</strong> and add your free Gemini API key. Then tap New course.</p></section>';
  }
  h += '<div class="row"><button class="btn primary" data-action="newCourse">+ New course</button>';
  if (state.settings.methods.spaced) {
    h += '<button class="btn" data-action="nav" data-view="review">Review (' + due + ' due)</button>';
  }
  h += '</div>';
  if (streak > 0) h += '<p class="muted">Streak: <strong>' + streak + ' day' + (streak === 1 ? '' : 's') + '</strong> in a row</p>';
  state.courses.forEach(c => {
    const done = c.lessons.filter(l => l.completed).length;
    const pct = Math.round(100 * done / c.lessons.length);
    const next = c.lessons.findIndex(l => !l.completed);
    let nextHtml = '';
    if (next < 0) nextHtml = '<p>Course complete. Well done!</p>';
    else {
      const st = lessonStatus(c, next, state.settings);
      const l = c.lessons[next];
      const verb = (l.content && l.lastPage > 0) ? 'Continue' : 'Start';
      if (st === 'ready') nextHtml = '<button class="btn primary" data-action="startLesson" data-id="' + c.id + '" data-i="' + next + '">' + verb + ' lesson ' + (next + 1) + ': ' + esc(l.title) + '</button>';
      else nextHtml = '<p class="muted">Next lesson (' + (next + 1) + ') opens ' + esc(niceDate(lessonDate(c, next))) + '.</p>';
    }
    h += '<section class="card"><h2>' + esc(c.title) + '</h2>' +
      '<p class="muted">' + done + ' of ' + c.lessons.length + ' lessons done, one per ' + PERIOD_NAME[c.period] + '</p>' +
      '<div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '" aria-label="Progress"><span style="width:' + pct + '%"></span></div>' +
      '<div class="row">' + nextHtml + '<button class="btn" data-action="openCourse" data-id="' + c.id + '">All lessons</button></div></section>';
  });
  if (state.bookmarks.length) {
    h += '<section class="card"><h2>Bookmarks</h2><ul class="plain">';
    state.bookmarks.slice().reverse().slice(0, 12).forEach(b => {
      const c = getCourse(b.courseId);
      if (!c || !c.lessons[b.lessonIndex]) return;
      h += '<li class="bm"><button class="btn" data-action="openBookmark" data-id="' + b.id + '">' + esc(c.title) + ', lesson ' + (b.lessonIndex + 1) + ': ' + esc(b.label) + '</button>' +
        '<button class="btn danger" data-action="removeBookmark" data-id="' + b.id + '" aria-label="Remove bookmark ' + esc(b.label) + '">Remove</button></li>';
    });
    h += '</ul></section>';
  }
  return h;
}

function viewNew() {
  const d = ui.draft;
  const auto = d.auto !== false;
  function opt(v, label, cur) { return '<option value="' + v + '"' + (cur === v ? ' selected' : '') + '>' + label + '</option>'; }
  return '<form id="new-form" onsubmit="return false">' +
    '<label class="field" for="f-topic">What do you want to learn?</label>' +
    '<input type="text" id="f-topic" value="' + esc(d.topic || '') + '" placeholder="e.g. Basics of personal budgeting" autocomplete="off">' +
    '<label class="field" for="f-level">Your level</label>' +
    '<select id="f-level">' + opt('complete beginner', 'Complete beginner', d.level || 'complete beginner') + opt('some knowledge', 'Some knowledge', d.level) + opt('intermediate', 'Intermediate', d.level) + opt('advanced', 'Advanced', d.level) + '</select>' +
    '<label class="field" for="f-period">How often do you want a lesson?</label>' +
    '<select id="f-period">' + opt('daily', 'Every day (about 10 min)', d.period || 'daily') + opt('weekly', 'Every week (about 20 min)', d.period) + opt('monthly', 'Every month (about 30 min)', d.period) + '</select>' +
    '<label class="check"><input type="checkbox" id="f-auto"' + (auto ? ' checked' : '') + '><span>Let the AI decide how many lessons<span class="help">It sizes the course to your topic and level. Untick to choose the number yourself.</span></span></label>' +
    '<div id="count-wrap"' + (auto ? ' hidden' : '') + '><label class="field" for="f-count">Number of lessons (1 to ' + MAX_LESSONS + ')</label>' +
    '<input type="number" id="f-count" min="1" max="' + MAX_LESSONS + '" value="' + esc(d.count || 7) + '" inputmode="numeric"></div>' +
    '<label class="field" for="f-notes">Anything else? (optional: your goals, what to focus on)</label>' +
    '<textarea id="f-notes">' + esc(d.notes || '') + '</textarea>' +
    '<div class="row"><button class="btn primary" data-action="createCourse"' + (ui.busy ? ' disabled' : '') + '>Create course</button>' +
    '<button class="btn" data-action="nav" data-view="home">Cancel</button></div></form>';
}

function viewCourse() {
  const c = getCourse(ui.courseId);
  if (!c) return '<p>Course not found.</p>';
  let h = '<h2>' + esc(c.title) + '</h2><p class="muted">' + esc(c.level) + ' level. Started ' + esc(niceDate(c.start)) + '.</p>';
  if (c.countReason) h += '<p class="muted">' + c.lessons.length + ' lessons: ' + esc(c.countReason) + '</p>';
  h += '<ol class="steps">';
  c.lessons.forEach((l, i) => {
    const st = lessonStatus(c, i, state.settings);
    let status, btn = '';
    const a = 'data-id="' + c.id + '" data-i="' + i + '"';
    if (st === 'done') {
      status = 'Done' + (typeof l.score === 'number' ? ' (quiz ' + l.score + '%)' : '');
      btn = (l.content ? '<button class="btn" data-action="reread" ' + a + '>Read again</button>' : '') + '<button class="btn" data-action="startLesson" ' + a + '>Retake quiz</button>';
    } else if (st === 'ready') {
      status = 'Ready';
      btn = '<button class="btn primary" data-action="startLesson" ' + a + '>' + (l.content && l.lastPage > 0 ? 'Continue' : 'Start') + '</button>';
    } else if (st === 'locked-date') status = 'Opens ' + niceDate(lessonDate(c, i));
    else status = 'Finish the earlier lesson first';
    h += '<li><strong>' + esc(l.title) + '</strong> <span class="pill">' + esc(status) + '</span><br><span class="muted">' + esc(l.summary) + '</span><div class="row">' + btn + '</div></li>';
  });
  h += '</ol><div class="row"><button class="btn" data-action="nav" data-view="home">Back</button><button class="btn danger" data-action="deleteCourse" data-id="' + c.id + '">Delete course</button></div>';
  return h;
}

// ----- diagrams (built from plain lists and tables so screen readers can read them) -----
function renderVisual(v) {
  if (!v) return '';
  let body = '';
  if (v.type === 'flow') {
    body = '<ol class="flow">' + v.steps.map(s => '<li>' + esc(s) + '</li>').join('') + '</ol>';
  } else if (v.type === 'compare') {
    body = '<div class="cols">' + v.columns.map(c => '<section><h4>' + esc(c.heading) + '</h4><ul>' + c.points.map(p => '<li>' + esc(p) + '</li>').join('') + '</ul></section>').join('') + '</div>';
  } else if (v.type === 'timeline') {
    body = '<ol class="timeline">' + v.events.map(e => '<li><strong>' + esc(e.label) + '</strong> ' + esc(e.text) + '</li>').join('') + '</ol>';
  }
  return '<figure class="visual">' + (v.title ? '<figcaption>' + esc(v.title) + '</figcaption>' : '') +
    (v.alt ? '<p class="sr-only">' + esc(v.alt) + '</p>' : '') + body + '</figure>';
}

function pageHtml(p) {
  let h = '<h3 id="page-title" tabindex="-1">' + esc(p.heading) + '</h3>';
  if (p.kind === 'text') h += paras(p.text) + renderVisual(p.visual);
  else if (p.kind === 'analogy') h += '<section class="card">' + paras(p.text) + '</section>';
  else if (p.kind === 'example') h += '<section class="card">' + paras(p.problem) + '<ol class="steps">' + p.steps.map(x => '<li>' + esc(x) + '</li>').join('') + '</ol></section>';
  else if (p.kind === 'takeaways') h += '<ul>' + p.points.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>';
  return h;
}

// ----- question lists (used by pre-test, quiz and review) -----
function renderQuestions(items, answers) {
  return items.map((it, n) => {
    const done = answers != null;
    let h = '<fieldset class="q"><legend>' + (it.review ? '(Review) ' : '') + (n + 1) + '. ' + esc(it.q) + '</legend>';
    it.options.forEach((o, k) => {
      const id = 'q' + n + '_' + k;
      let cls = '', note = '';
      if (done) {
        if (k === it.correct) { cls = 'right'; note = ' - correct answer'; }
        else if (k === answers[n]) { cls = 'wrong'; note = ' - your answer'; }
      }
      h += '<label class="opt ' + cls + '" for="' + id + '"><input type="radio" id="' + id + '" name="q' + n + '" value="' + k + '"' +
        (done ? ' disabled' : '') + (done && answers[n] === k ? ' checked' : '') + '><span>' + esc(o) + esc(note) + '</span></label>';
    });
    if (done) h += '<p class="explain">' + esc(it.explanation) + '</p>';
    return h + '</fieldset>';
  }).join('');
}
function readAnswers(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const el = document.querySelector('input[name="q' + i + '"]:checked');
    out.push(el ? parseInt(el.value, 10) : null);
  }
  return out;
}
function scoreOf(items, answers) { return answers.filter((a, n) => a === items[n].correct).length; }

function stepsFor(content, m) {
  const s = [];
  if (m.preTest && content.preTest.length) s.push('pretest');
  s.push('lesson');
  if (m.recall && (content.quiz.length)) s.push('quiz');
  if (m.explainBack) s.push('explain');
  s.push('done');
  return s;
}

function viewLesson() {
  const S = ui.session;
  if (!S) return ui.busy ? '' : '<p>No lesson open.</p>';
  const c = getCourse(S.courseId), lesson = c.lessons[S.index], content = lesson.content;
  const step = S.steps[S.step];
  const total = S.steps.length - 1;
  const reread = S.mode === 'reread';
  let h = '<p class="muted">' + esc(c.title) + ' - lesson ' + (S.index + 1) + ' of ' + c.lessons.length + (step !== 'done' && !reread ? ' - step ' + (S.step + 1) + ' of ' + total : '') + (reread ? ' - reading again' : '') + '</p>';
  h += '<h2 id="step-title" tabindex="-1">' + esc(lesson.title) + '</h2>';

  if (step === 'pretest') {
    h += '<h3>Warm-up (not graded)</h3><p>Try these before reading. Guessing is fine. It primes your brain to learn.</p>';
    h += renderQuestions(S.preItems, S.preAnswers);
    h += '<p id="inline-msg" class="muted" role="status"></p><div class="row">' +
      (S.preAnswers ? '<button class="btn primary" data-action="next">Continue to the lesson</button>'
        : '<button class="btn primary" data-action="submitPre">Check my answers</button>') + '</div>';
  } else if (step === 'lesson') {
    const np = S.pages.length, p = S.pages[S.page];
    const marked = hasBookmark(S.courseId, S.index, S.page);
    const pct = Math.round(100 * (S.page + 1) / np);
    h += '<div class="row"><button class="btn" data-action="bookmark" aria-pressed="' + marked + '">' + (marked ? '★ Bookmarked' : '☆ Bookmark this page') + '</button>' +
      '<button class="btn" data-action="speak">Read aloud</button><button class="btn" data-action="stopSpeak">Stop</button></div>';
    h += '<p class="muted" id="page-count">Page ' + (S.page + 1) + ' of ' + np + '</p>' +
      '<div class="progress" aria-hidden="true"><span style="width:' + pct + '%"></span></div>';
    h += '<label class="field" for="jump">Jump to page</label><select id="jump">' +
      S.pages.map((x, k) => '<option value="' + k + '"' + (k === S.page ? ' selected' : '') + '>' + (k + 1) + '. ' + esc(x.heading) + (hasBookmark(S.courseId, S.index, k) ? ' ★' : '') + '</option>').join('') + '</select>';
    h += '<article class="page">' + pageHtml(p) + '</article>';
    const last = S.page === np - 1;
    const nextName = { quiz: 'Take the quiz', explain: 'Explain it back', done: reread ? 'Finish reading' : 'Finish lesson' }[S.steps[S.step + 1]];
    h += '<div class="row pager"><button class="btn" data-action="page" data-dir="-1"' + (S.page === 0 ? ' disabled' : '') + '>← Previous</button>' +
      (last ? '<button class="btn primary" data-action="next">' + nextName + '</button>' : '<button class="btn primary" data-action="page" data-dir="1">Next page →</button>') + '</div>';
    if (last) h += '<div class="row"><button class="btn" data-action="regen">Regenerate lesson</button></div>';
  } else if (step === 'quiz') {
    h += '<h3>Quiz</h3>';
    h += renderQuestions(S.quizItems, S.quizAnswers);
    if (S.quizAnswers) {
      const sc = scoreOf(S.quizItems, S.quizAnswers);
      const mine = S.quizItems.filter(it => it.kind === 'new').length;
      h += '<div class="msg ok" id="result" tabindex="-1" role="status">You scored ' + sc + ' of ' + S.quizItems.length + '.' +
        (mine !== S.quizItems.length && typeof lesson.score === 'number' ? ' This lesson\'s questions: ' + lesson.score + '%.' : '') +
        (state.settings.methods.spaced ? ' Questions you missed will come back sooner in Review.' : '') + '</div>';
      h += '<div class="row"><button class="btn primary" data-action="next">Continue</button></div>';
    } else {
      h += '<p id="inline-msg" class="muted" role="status"></p><div class="row"><button class="btn primary" data-action="submitQuiz">Check my answers</button></div>';
    }
  } else if (step === 'explain') {
    h += '<h3>Explain it back</h3>' + paras(content.explainPrompt) +
      '<label class="field" for="explain-text">Your explanation</label><textarea id="explain-text">' + esc(S.explainText || '') + '</textarea>';
    if (S.feedback) h += '<div class="msg ok" id="result" tabindex="-1" role="status"><strong>Feedback</strong>' + paras(S.feedback) + '</div>';
    h += '<p id="inline-msg" class="muted" role="status"></p><div class="row">' +
      (S.feedback ? '' : '<button class="btn primary" data-action="submitExplain"' + (ui.busy ? ' disabled' : '') + '>Get feedback</button>') +
      '<button class="btn ' + (S.feedback ? 'primary' : '') + '" data-action="next">' + (S.feedback ? 'Finish lesson' : 'Skip') + '</button></div>';
  } else if (step === 'done') {
    if (reread) {
      h += '<div class="msg ok" id="result" tabindex="-1" role="status">That is the end of the lesson.</div>' +
        '<div class="row"><button class="btn primary" data-action="openCourse" data-id="' + c.id + '">Back to course</button>' +
        '<button class="btn" data-action="startLesson" data-id="' + c.id + '" data-i="' + S.index + '">Retake lesson and quiz</button></div>';
    } else {
      const nxt = S.index + 1;
      h += '<div class="msg ok" id="result" tabindex="-1" role="status">Lesson complete. Nice work!' +
        (typeof lesson.score === 'number' ? ' Quiz score: ' + lesson.score + '%.' : '') + '</div>';
      if (nxt < c.lessons.length) {
        const st = lessonStatus(c, nxt, state.settings);
        if (st === 'ready') h += '<p>The next lesson is ready.</p><div class="row"><button class="btn primary" data-action="startLesson" data-id="' + c.id + '" data-i="' + nxt + '">Start lesson ' + (nxt + 1) + '</button></div>';
        else h += '<p>Next lesson opens <strong>' + esc(niceDate(lessonDate(c, nxt))) + '</strong>. Come back then.</p>';
      } else h += '<p>That was the last lesson. Course complete!</p>';
      h += '<div class="row"><button class="btn" data-action="nav" data-view="home">Home</button><button class="btn" data-action="nav" data-view="stats">See your stats</button></div>';
    }
  }
  if (step !== 'done') h += '<div class="row"><button class="btn" data-action="leaveLesson">Leave lesson</button></div>';
  return h;
}

function viewReview() {
  if (!state.settings.methods.spaced) {
    return '<p>Spaced repetition is switched off. Turn it on in Settings to use Review.</p>';
  }
  const R = ui.review;
  const due = dueCards(state.cards);
  if (!R) {
    return '<h2>Review</h2><p>' + (due.length ? 'You have <strong>' + due.length + '</strong> question' + (due.length === 1 ? '' : 's') + ' due. A short session keeps what you learned from fading.' : 'Nothing is due right now. Check back tomorrow.') + '</p>' +
      '<div class="row">' + (due.length ? '<button class="btn primary" data-action="startReview">Start review</button>' : '') + '<button class="btn" data-action="nav" data-view="home">Home</button></div>';
  }
  if (R.i >= R.queue.length) {
    return '<h2>Review finished</h2><div class="msg ok" id="result" tabindex="-1" role="status">You got ' + R.correct + ' of ' + R.queue.length + ' right.</div>' +
      '<div class="row"><button class="btn primary" data-action="endReview">Done</button></div>';
  }
  const card = state.cards.find(c => c.id === R.queue[R.i]);
  if (!card) { R.i++; return viewReview(); }
  let h = '<p class="muted">Question ' + (R.i + 1) + ' of ' + R.queue.length + '</p><fieldset class="q"><legend>' + esc(card.q) + '</legend>';
  card.options.forEach((o, k) => {
    let cls = '', note = '';
    if (R.answered != null) {
      if (k === card.correct) { cls = 'right'; note = ' - correct answer'; }
      else if (k === R.answered) { cls = 'wrong'; note = ' - your answer'; }
    }
    h += '<button class="btn opt ' + cls + '" style="width:100%;text-align:left;margin:.3rem 0" data-action="reviewAnswer" data-k="' + k + '"' + (R.answered != null ? ' disabled' : '') + '>' + esc(o) + esc(note) + '</button>';
  });
  h += '</fieldset>';
  if (R.answered != null) {
    h += '<div class="msg ' + (R.answered === card.correct ? 'ok' : 'error') + '" id="result" tabindex="-1" role="status">' + (R.answered === card.correct ? 'Correct. ' : 'Not quite. ') + esc(card.explanation) + '</div>' +
      '<div class="row"><button class="btn primary" data-action="reviewNext">Next</button></div>';
  }
  return h;
}

// ----- Stats tab -----
function statTile(label, value, tone) {
  return '<div class="tile"><span class="tile-v ' + (tone || '') + '">' + esc(value) + '</span><span class="tile-l">' + esc(label) + '</span></div>';
}

function lessonStatHtml(c, l, i) {
  const key = c.id + ':' + i;
  let right, body;
  if (l.completed && typeof l.score === 'number') {
    const r = rating(l.score);
    right = starsHtml(r.stars, r.tone) + ' <span class="pct ' + r.tone + '">' + l.score + '% ' + esc(r.word) + '</span>';
  } else if (l.completed) right = '<span class="pill">Completed, no quiz</span>';
  else right = '<span class="pill">Not done yet</span>';

  if (!l.completed) {
    body = '<p class="muted">Finish this lesson to see your results here.</p>';
  } else {
    const r = l.result;
    let well = '', imp = '';
    if (r) {
      well = r.right.length
        ? r.right.slice(0, 6).map(q => '<li>Got right: ' + esc(q) + '</li>').join('')
        : '<li>You finished the lesson. Scores improve with review, so keep going.</li>';
      imp = r.missed.length
        ? r.missed.map(x => '<li><strong>' + esc(x.q) + '</strong><br>You chose: ' + esc(x.yours) + '. Correct: ' + esc(x.right) + '. ' + esc(x.why) + '</li>').join('')
        : '<li>Nothing missed. Keep it fresh with spaced review.</li>';
    } else {
      well = '<li>You completed the lesson.</li>';
      imp = '<li>No quiz was taken, so there is no score. Turn on the quiz method in Settings to measure what sticks.</li>';
    }
    body = '<h4>What you did well</h4><ul>' + well + '</ul><h4>What to improve</h4><ul>' + imp + '</ul>';
    if (l.explainFeedback) body += '<h4>Feedback on your own summary</h4>' + paras(l.explainFeedback);
    if (l.coach) body += '<h4>AI coach</h4>' + paras(l.coach.didWell) + paras(l.coach.improve);
    if (l.attempts && l.attempts.length > 1) body += '<p class="muted">Quiz attempts: ' + l.attempts.map(a => a.score + '%').join(' then ') + '</p>';
    const a = 'data-id="' + c.id + '" data-i="' + i + '"';
    body += '<div class="row">' + (l.coach ? '' : '<button class="btn" data-action="coach" ' + a + (ui.busy ? ' disabled' : '') + '>Ask AI for a deeper breakdown</button>') +
      (l.content ? '<button class="btn" data-action="reread" ' + a + '>Read again</button>' : '') +
      '<button class="btn" data-action="startLesson" ' + a + '>Retake quiz</button></div>';
  }
  const open = ui.statOpen[key] === true;
  return '<details class="lesson-stat" data-key="' + esc(key) + '"' + (open ? ' open' : '') + '><summary><span class="ls-title">' + (i + 1) + '. ' + esc(l.title) + '</span><span class="ls-score">' + right + '</span></summary><div class="ls-body">' + body + '</div></details>';
}

function viewStats() {
  if (!state.courses.length) return '<h2>Stats</h2><p>No courses yet. Finish a lesson and your results will appear here.</p>';
  const all = [];
  state.courses.forEach(c => c.lessons.forEach(l => all.push(l)));
  const done = all.filter(l => l.completed);
  const scored = done.filter(l => typeof l.score === 'number');
  const avg = scored.length ? Math.round(scored.reduce((s, l) => s + l.score, 0) / scored.length) : null;
  let h = '<h2>Your progress</h2><div class="tiles">' +
    statTile('Day streak', currentStreak(state.activity)) +
    statTile('Lessons done', done.length + ' of ' + all.length) +
    statTile('Average score', avg == null ? '-' : avg + '%', avg == null ? '' : rating(avg).tone) +
    statTile('Reviews due', dueCards(state.cards).length) + '</div>';
  state.courses.forEach(c => {
    const d = c.lessons.filter(l => l.completed).length;
    const sc = c.lessons.filter(l => typeof l.score === 'number');
    const cavg = sc.length ? Math.round(sc.reduce((s, l) => s + l.score, 0) / sc.length) : null;
    const key = 'course:' + c.id;
    const open = ui.statOpen[key] !== false;
    h += '<details class="course-stat" data-key="' + esc(key) + '"' + (open ? ' open' : '') + '><summary><strong>' + esc(c.title) + '</strong> <span class="muted">' + d + ' of ' + c.lessons.length + ' done' +
      (cavg == null ? '' : ', average <span class="pct ' + rating(cavg).tone + '">' + cavg + '%</span>') + '</span></summary>';
    c.lessons.forEach((l, i) => { h += lessonStatHtml(c, l, i); });
    h += '</details>';
  });
  return h;
}

// Backup keys box + a line per key saying whether it is ready or resting.
function keysHtml() {
  const s = state.settings, keys = apiKeys();
  let h = '<label class="field" for="s-backupKeys">Backup API keys (optional, one per line)</label>' +
    '<textarea id="s-backupKeys" data-setting="backupKeys" style="min-height:5rem" autocapitalize="off" spellcheck="false" autocomplete="off" placeholder="Paste extra keys here">' + esc(s.backupKeys || '') + '</textarea>' +
    '<p class="muted">If a key runs out, the app moves on to the next one. If a key runs out partway through writing a lesson, the next key carries on from that exact point instead of starting over. Every key uses the model name below. Free limits are counted per Google project, so a second key from the same project will not help.</p>' +
    '<p class="msg" style="border-color:var(--warn)"><strong>Heads up:</strong> Google\'s terms say not to get around its usage limits, and Google has restricted projects it believed were doing that with many accounts. Backups are safest when they are keys you are entitled to use, such as your own paid key.</p>';
  if (keys.length) {
    h += '<ul class="plain">' + keys.map((k, i) => {
      const r = keyRest(k);
      return '<li>' + esc(keyLabel(k, i)) + ': ' + (r ? '<span class="warn">resting until ' + esc(clockTime(r.until)) + ' (' + esc(r.why) + ')</span>' : '<span class="good">ready</span>') + '</li>';
    }).join('') + '</ul>';
    if (keys.some(k => keyRest(k))) h += '<div class="row"><button class="btn" data-action="clearRest">Clear resting timers</button></div>';
  }
  return h;
}

function viewSettings() {
  const s = state.settings;
  function chk(key, label, help, kind) {
    const on = kind === 'method' ? s.methods[key] : s[key];
    return '<label class="check"><input type="checkbox" ' + (kind === 'method' ? 'data-method' : 'data-setting') + '="' + key + '"' + (on ? ' checked' : '') + '><span>' + esc(label) + '<span class="help">' + esc(help) + '</span></span></label>';
  }
  function sel(key, label, options) {
    return '<label class="field" for="s-' + key + '">' + label + '</label><select id="s-' + key + '" data-setting="' + key + '">' +
      options.map(o => '<option value="' + o[0] + '"' + (s[key] === o[0] ? ' selected' : '') + '>' + o[1] + '</option>').join('') + '</select>';
  }
  let h = '<h2>AI connection</h2>' +
    '<p class="muted">Get a free key at aistudio.google.com. It is saved only in this browser, on this device.</p>' +
    '<label class="field" for="s-apiKey">Gemini API key</label><input type="password" id="s-apiKey" data-setting="apiKey" value="' + esc(s.apiKey) + '" autocomplete="off" autocapitalize="off" spellcheck="false">' +
    keysHtml() +
    '<label class="field" for="s-model">Model name</label><input type="text" id="s-model" data-setting="model" value="' + esc(s.model) + '" autocapitalize="off" spellcheck="false">' +
    '<p class="muted">If the AI says a model was not found, look up a current free model name in Google AI Studio and paste it here.</p>' +
    '<div class="row"><button class="btn" data-action="testKey"' + (ui.busy ? ' disabled' : '') + '>Test connection (all keys)</button></div>';
  h += '<h2>Teaching methods</h2><p class="muted">Switch any combination on or off. Applies to lessons created from now on (use Regenerate on a lesson\'s last page to redo it).</p>';
  Object.keys(METHOD_INFO).forEach(k => { h += chk(k, METHOD_INFO[k].label, METHOD_INFO[k].help, 'method'); });
  h += '<h2>Schedule</h2>' + chk('allowAhead', 'Let me work ahead', 'Open upcoming lessons early instead of waiting for their date.', 'setting');
  if (typeof notifySettingsHtml === 'function') h += notifySettingsHtml();
  h += '<h2>Accessibility</h2>' +
    sel('theme', 'Color theme', [['auto', 'Match my device'], ['light', 'Light'], ['dark', 'Dark'], ['contrast', 'High contrast']]) +
    '<label class="field" for="s-fontScale">Text size</label><input type="range" id="s-fontScale" data-setting="fontScale" min="0.85" max="2" step="0.05" value="' + s.fontScale + '">' +
    sel('spacing', 'Line spacing', [['normal', 'Normal'], ['relaxed', 'Extra space']]) +
    chk('easyFont', 'Easier-to-read font', 'Uses a wide, clear font with extra letter and word spacing.', 'setting') +
    chk('reduceMotion', 'Reduce motion', 'Turns off animations.', 'setting');
  h += '<h2>Your data</h2><p class="muted">Everything lives in this browser. Make a backup file now and then (your API key is not included).</p>' +
    '<div class="row"><button class="btn" data-action="exportData">Download backup</button>' +
    '<label class="btn" for="import-file" style="display:inline-flex;align-items:center;cursor:pointer">Restore backup</label>' +
    '<input type="file" id="import-file" accept="application/json" class="sr-only"></div>' +
    '<div class="row"><button class="btn danger" data-action="eraseAll">Erase all data</button></div>';
  return h;
}

/* ================= 6. Buttons and events ================= */

function inlineMsg(text) {
  const el = document.getElementById('inline-msg');
  if (el) el.textContent = text;
}
function setError(e) { ui.message = { type: 'error', text: (e && e.message) || String(e) }; }

// Called while the AI is writing: shows the status lines it reports.
function updateLog(text) {
  const lines = extractLog(text);
  if (lines.length === ui.log.length) return;
  ui.log = lines;
  const ul = document.getElementById('busy-log');
  if (ul) ul.innerHTML = lines.map(l => '<li>' + esc(l) + '</li>').join('');
  if (lines.length) announce(lines[lines.length - 1]);
}

// Shows things like "Key 2: carrying on from where the last key stopped".
function setBusyNote(text) {
  ui.busyNote = text;
  const el = document.getElementById('busy-note');
  if (el) el.textContent = text;
  announce(text);
}

async function withBusy(text, fn) {
  ui.busy = text; ui.message = null; ui.log = []; ui.busyNote = ''; render(); announce(text);
  try { return await fn(); }
  finally { ui.busy = null; ui.log = []; ui.busyNote = ''; }
}

async function createCourse() {
  const auto = document.getElementById('f-auto').checked;
  const d = {
    topic: document.getElementById('f-topic').value.trim(),
    level: document.getElementById('f-level').value,
    period: document.getElementById('f-period').value,
    auto: auto,
    count: auto ? null : parseInt(document.getElementById('f-count').value, 10),
    notes: document.getElementById('f-notes').value.trim()
  };
  ui.draft = Object.assign({}, d, { count: document.getElementById('f-count').value });
  if (!d.topic) return inlineErrorNew('Please type what you want to learn.');
  if (!auto && !(d.count >= 1 && d.count <= MAX_LESSONS)) return inlineErrorNew('Choose between 1 and ' + MAX_LESSONS + ' lessons.');
  try {
    const out = await withBusy('Planning your course...', () => callAI(buildOutlinePrompt(d), updateLog));
    let lessons = (out && Array.isArray(out.lessons)) ? out.lessons.filter(l => l && l.title) : [];
    if (!lessons.length) throw new Error('The AI did not return a course plan. Please try again.');
    lessons = lessons.slice(0, d.count || MAX_LESSONS).map(l => ({ title: String(l.title), summary: String(l.summary || ''), completed: false, content: null }));
    const course = {
      id: uid(), title: String((out && out.title) || d.topic), level: d.level, period: d.period, start: todayStr(), lessons: lessons,
      countReason: d.count ? '' : String((out && out.reason) || '').slice(0, 300)
    };
    state.courses.push(course);
    saveState();
    ui.draft = {};
    go('course', { courseId: course.id });
  } catch (e) {
    setError(e); render();
  }
}
function inlineErrorNew(text) { ui.message = { type: 'error', text: text }; ui.focus = '#main'; render(); }

async function startLesson(courseId, index, opts) {
  const c = getCourse(courseId);
  if (!c) return;
  const lesson = c.lessons[index];
  const m = state.settings.methods;
  try {
    if (!lesson.content) {
      ui.view = 'lesson'; ui.session = null;
      lesson.content = await withBusy('Writing your lesson...', async () => cleanLesson(await callAI(buildLessonPrompt(c, index, m), updateLog)));
      saveState();
    }
    openSession(c, index, opts);
  } catch (e) {
    setError(e);
    ui.view = 'course'; ui.courseId = courseId; render();
  }
}

function openSession(c, index, opts) {
  opts = opts || {};
  const lesson = c.lessons[index], content = lesson.content, m = state.settings.methods;
  const reread = opts.mode === 'reread';
  const pages = buildPages(content);
  let page = typeof opts.page === 'number' ? opts.page : ((!reread && !lesson.completed && lesson.lastPage) ? lesson.lastPage : 0);
  page = Math.max(0, Math.min(page, pages.length - 1));
  let steps = reread ? ['lesson', 'done'] : stepsFor(content, m);
  if (!reread && page > 0) steps = steps.filter(s => s !== 'pretest');
  let items = [];
  if (!reread) {
    const quizItems = content.quiz.map(q => Object.assign({ kind: 'new' }, q));
    items = quizItems;
    if (m.interleave) {
      const old = pickInterleaved(state.cards, c.id, index, 3).map(card => ({
        kind: 'review', cardId: card.id, review: true, q: card.q, options: card.options, correct: card.correct, explanation: card.explanation
      }));
      items = shuffle(quizItems.concat(old));
    }
  }
  ui.session = {
    courseId: c.id, index: index, mode: reread ? 'reread' : 'normal', steps: steps, step: steps.indexOf('pretest') >= 0 ? 0 : steps.indexOf('lesson'),
    pages: pages, page: page, preItems: content.preTest, preAnswers: null, quizItems: items, quizAnswers: null, explainText: '', feedback: null
  };
  go('lesson', { courseId: c.id, focus: '#step-title' });
}

function nextStep() {
  const S = ui.session;
  S.step++;
  if (S.steps[S.step] === 'done' && S.mode !== 'reread') completeLesson();
  window.scrollTo(0, 0);
  ui.focus = S.steps[S.step] === 'done' ? '#result' : '#step-title';
  render();
}

function completeLesson() {
  const S = ui.session, c = getCourse(S.courseId), lesson = c.lessons[S.index];
  lesson.completed = true;
  lesson.completedOn = todayStr();
  lesson.lastPage = 0;
  markActive();
  const now = new Date();
  state.completions = (state.completions || []).concat([now.getHours() * 60 + now.getMinutes()]).slice(-30);
  saveState();
}

function turnPage(dir) {
  const S = ui.session;
  setPage(S.page + dir);
}
function setPage(n) {
  const S = ui.session;
  if (!(n >= 0 && n < S.pages.length)) return;
  S.page = n;
  const lesson = getCourse(S.courseId).lessons[S.index];
  if (S.mode !== 'reread' && !lesson.completed) { lesson.lastPage = n; saveState(); }
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
  window.scrollTo(0, 0);
  ui.focus = '#page-title';
  render();
}

function toggleBookmark() {
  const S = ui.session;
  const i = state.bookmarks.findIndex(b => b.courseId === S.courseId && b.lessonIndex === S.index && b.page === S.page);
  if (i >= 0) state.bookmarks.splice(i, 1);
  else state.bookmarks.push({ id: uid(), courseId: S.courseId, lessonIndex: S.index, page: S.page, label: S.pages[S.page].heading, on: todayStr() });
  saveState();
  render();
  const b = document.querySelector('[data-action="bookmark"]');
  if (b) b.focus();
  announce(i >= 0 ? 'Bookmark removed' : 'Page bookmarked');
}

function submitPre() {
  const S = ui.session, a = readAnswers(S.preItems.length);
  if (a.indexOf(null) >= 0) return inlineMsg('Please answer every question. Guessing is fine.');
  S.preAnswers = a; ui.focus = '#step-title'; render();
}

function submitQuiz() {
  const S = ui.session, c = getCourse(S.courseId), lesson = c.lessons[S.index], m = state.settings.methods, today = todayStr();
  const a = readAnswers(S.quizItems.length);
  if (a.indexOf(null) >= 0) return inlineMsg('Please answer every question.');
  S.quizAnswers = a;

  // This lesson's own questions decide the lesson score (older mixed-in questions do not).
  const mine = S.quizItems.map((it, n) => ({ it: it, n: n })).filter(x => x.it.kind === 'new');
  if (mine.length) {
    const right = mine.filter(x => a[x.n] === x.it.correct);
    const wrong = mine.filter(x => a[x.n] !== x.it.correct);
    const score = Math.round(100 * right.length / mine.length);
    lesson.result = {
      date: today, total: mine.length, correct: right.length, score: score,
      right: right.map(x => x.it.q),
      missed: wrong.map(x => ({ q: x.it.q, yours: x.it.options[a[x.n]], right: x.it.options[x.it.correct], why: x.it.explanation }))
    };
    lesson.score = score;
    lesson.attempts = (lesson.attempts || []).concat([{ date: today, score: score }]).slice(-20);
    delete lesson.coach;   // an old AI breakdown no longer matches this attempt
  }

  if (m.spaced || m.interleave) {
    // Replace any older cards from this lesson (e.g. when retaking it).
    const fresh = S.quizItems.filter(it => it.kind === 'new');
    if (fresh.length) state.cards = state.cards.filter(cd => !(cd.courseId === c.id && cd.lessonIndex === S.index));
    S.quizItems.forEach((it, n) => {
      const ok = a[n] === it.correct;
      if (it.kind === 'new') {
        const card = { id: uid(), courseId: c.id, lessonIndex: S.index, q: it.q, options: it.options, correct: it.correct, explanation: it.explanation, box: 0, due: today };
        gradeCard(card, ok, today);
        state.cards.push(card);
      } else {
        const card = state.cards.find(cd => cd.id === it.cardId);
        if (card) gradeCard(card, ok, today);
      }
    });
  }
  saveState();
  ui.focus = '#result'; render();
}

async function submitExplain() {
  const S = ui.session, c = getCourse(S.courseId), lesson = c.lessons[S.index];
  const text = document.getElementById('explain-text').value.trim();
  S.explainText = text;
  if (text.length < 10) return inlineMsg('Write a few sentences first.');
  try {
    const out = await withBusy('Reading your explanation...', () => callAI(buildFeedbackPrompt(c, lesson, lesson.content, text)));
    S.feedback = String((out && out.feedback) || 'No feedback was returned.');
    lesson.explainFeedback = S.feedback;
    saveState();
    ui.focus = '#result';
  } catch (e) { setError(e); }
  render();
}

async function coach(courseId, index) {
  const c = getCourse(courseId);
  if (!c) return;
  const lesson = c.lessons[index];
  ui.statOpen[courseId + ':' + index] = true;
  try {
    const out = await withBusy('Reviewing your results...', () => callAI(buildCoachPrompt(c, lesson)));
    lesson.coach = { didWell: String((out && out.didWell) || ''), improve: String((out && out.improve) || '') };
    saveState();
  } catch (e) { setError(e); }
  render();
}

function speak() {
  if (!('speechSynthesis' in window)) { ui.message = { type: 'error', text: 'Read aloud is not supported in this browser.' }; return render(); }
  const S = ui.session;
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(pageText(S.pages[S.page])));
}

function startReview() {
  const due = dueCards(state.cards);
  if (!due.length) { ui.message = { type: 'ok', text: 'Nothing is due.' }; return render(); }
  ui.review = { queue: shuffle(due).slice(0, 10).map(c => c.id), i: 0, answered: null, correct: 0 };
  ui.focus = '#main'; render();
}
function reviewAnswer(k) {
  const R = ui.review, card = state.cards.find(c => c.id === R.queue[R.i]);
  if (!card || R.answered != null) return;
  R.answered = k;
  const ok = k === card.correct;
  if (ok) R.correct++;
  gradeCard(card, ok);
  markActive();
  saveState();
  ui.focus = '#result'; render();
}

function exportData() {
  const copy = JSON.parse(JSON.stringify(state));
  copy.settings.apiKey = '';
  copy.settings.backupKeys = '';
  copy.settings.keyStatus = {};
  const blob = new Blob([JSON.stringify(copy, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'learn-anything-backup-' + todayStr() + '.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function importData(file) {
  if (!file) return;
  const r = new FileReader();
  r.onload = () => {
    try {
      const p = JSON.parse(r.result);
      if (!p || !Array.isArray(p.courses) || !Array.isArray(p.cards)) throw new Error('bad');
      const key = state.settings.apiKey, backups = state.settings.backupKeys;
      const d = defaultState();
      state = {
        settings: Object.assign({}, d.settings, p.settings, { methods: Object.assign({}, d.settings.methods, (p.settings && p.settings.methods) || {}), apiKey: key, backupKeys: backups, keyStatus: state.settings.keyStatus || {} }),
        courses: p.courses, cards: p.cards,
        bookmarks: Array.isArray(p.bookmarks) ? p.bookmarks : [],
        activity: Array.isArray(p.activity) ? p.activity : [],
        completions: Array.isArray(p.completions) ? p.completions : []
      };
      saveState(); ui.message = { type: 'ok', text: 'Backup restored.' };
    } catch (e) { ui.message = { type: 'error', text: 'That file is not a valid backup.' }; }
    render();
  };
  r.readAsText(file);
}

async function handleAction(a, data) {
  switch (a) {
    case 'nav': ui.session = null; if (data.view !== 'review') ui.review = null; return go(data.view);
    case 'newCourse': return go('new');
    case 'createCourse': return createCourse();
    case 'openCourse': ui.session = null; return go('course', { courseId: data.id });
    case 'deleteCourse':
      if (window.confirm('Delete this course and its review questions? This cannot be undone.')) {
        state.courses = state.courses.filter(c => c.id !== data.id);
        state.cards = state.cards.filter(c => c.courseId !== data.id);
        state.bookmarks = state.bookmarks.filter(b => b.courseId !== data.id);
        saveState(); return go('home');
      }
      return;
    case 'startLesson': return startLesson(data.id, parseInt(data.i, 10));
    case 'reread': {
      const c = getCourse(data.id), i = parseInt(data.i, 10);
      if (!c || !c.lessons[i] || !c.lessons[i].content) return;
      return openSession(c, i, { mode: 'reread' });
    }
    case 'openBookmark': {
      const b = state.bookmarks.find(x => x.id === data.id);
      const c = b && getCourse(b.courseId);
      if (!c || !c.lessons[b.lessonIndex] || !c.lessons[b.lessonIndex].content) { ui.message = { type: 'error', text: 'That bookmarked lesson is no longer available.' }; return render(); }
      return openSession(c, b.lessonIndex, { mode: c.lessons[b.lessonIndex].completed ? 'reread' : 'normal', page: b.page });
    }
    case 'removeBookmark':
      state.bookmarks = state.bookmarks.filter(x => x.id !== data.id);
      saveState(); return render();
    case 'bookmark': return toggleBookmark();
    case 'page': return turnPage(parseInt(data.dir, 10));
    case 'regen': {
      if (!window.confirm('Write this lesson again with your current settings? Its quiz questions and bookmarks will be replaced.')) return;
      const S = ui.session, c = getCourse(S.courseId);
      c.lessons[S.index].content = null;
      c.lessons[S.index].lastPage = 0;
      state.bookmarks = state.bookmarks.filter(b => !(b.courseId === S.courseId && b.lessonIndex === S.index));
      saveState();
      return startLesson(S.courseId, S.index);
    }
    case 'leaveLesson': ui.session = null; return go('course', { courseId: ui.courseId });
    case 'next': return nextStep();
    case 'submitPre': return submitPre();
    case 'submitQuiz': return submitQuiz();
    case 'submitExplain': return submitExplain();
    case 'coach': return coach(data.id, parseInt(data.i, 10));
    case 'speak': return speak();
    case 'stopSpeak': if ('speechSynthesis' in window) window.speechSynthesis.cancel(); return;
    case 'startReview': return startReview();
    case 'reviewAnswer': return reviewAnswer(parseInt(data.k, 10));
    case 'reviewNext': ui.review.i++; ui.review.answered = null; ui.focus = '#main'; return render();
    case 'endReview': ui.review = null; return go('home');
    case 'testKey':
      try {
        const res = await withBusy('Testing the connection...', testAllKeys);
        const bad = res.filter(r => !r.ok);
        ui.message = bad.length
          ? { type: 'error', text: res.map(r => r.text).join('. ') + '.' }
          : { type: 'ok', text: res.length === 1 ? 'Connected. The AI answered.' : 'Connected. All ' + res.length + ' keys work.' };
      } catch (e) { setError(e); }
      return render();
    case 'clearRest': state.settings.keyStatus = {}; saveState(); return render();
    case 'exportData': return exportData();
    case 'eraseAll':
      if (window.confirm('Erase ALL courses, review questions and settings from this browser?')) {
        state = defaultState(); saveState(); ui.session = null; ui.review = null; return go('home');
      }
      return;
  }
}

function init() {
  document.addEventListener('click', e => {
    const b = e.target.closest('[data-action]');
    if (!b || b.disabled) return;
    handleAction(b.dataset.action, b.dataset);
  });
  document.addEventListener('change', e => {
    const t = e.target;
    if (t.dataset && t.dataset.setting) {
      const v = t.type === 'checkbox' ? t.checked : (t.type === 'range' ? parseFloat(t.value) : t.value.trim());
      state.settings[t.dataset.setting] = v; saveState(); applySettings();
    } else if (t.dataset && t.dataset.method) {
      state.settings.methods[t.dataset.method] = t.checked; saveState();
      if (t.dataset.method === 'spaced') { const rb = document.getElementById('nav-review'); if (rb) rb.hidden = !t.checked; }
    } else if (t.id === 'import-file') importData(t.files[0]);
    else if (t.id === 'f-auto') {
      const w = document.getElementById('count-wrap');
      if (w) w.hidden = t.checked;
    } else if (t.id === 'jump' && ui.session) setPage(parseInt(t.value, 10));
  });
  document.addEventListener('input', e => {
    const t = e.target;
    if (t.dataset && t.dataset.setting === 'fontScale') { state.settings.fontScale = parseFloat(t.value); applySettings(); }
  });
  // Remember which Stats dropdowns are open (the "toggle" event does not bubble, so listen while it travels down).
  document.addEventListener('toggle', e => {
    const d = e.target;
    if (d && d.tagName === 'DETAILS' && d.dataset && d.dataset.key) ui.statOpen[d.dataset.key] = d.open;
  }, true);
  render();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
}
if (typeof module !== 'undefined') {
  module.exports = { nextBox, gradeCard, dueCards, pickInterleaved, lessonStatus, lessonDate, addDays, cleanQuestion, cleanLesson, cleanVisual, parseJSON, extractLog, rating, currentStreak, buildPages, buildLessonPrompt, buildOutlinePrompt };
}

/* Learn Anything
 * A single-page app with no build step. Everything is saved in your own
 * browser (localStorage). The only outside service it talks to is the AI
 * provider you configure in Settings (Gemini by default).
 *
 * Layout of this file:
 *   1. Settings, teaching-method list, saved data
 *   2. Small helpers (dates, text safety)
 *   3. Teaching logic: schedule + spaced repetition (plain code, no AI)
 *   4. AI: the ONE place that talks to the AI provider (callAI)
 *   5. Screens (what you see)
 *   6. Buttons and events
 */
'use strict';

/* ================= 1. Settings and saved data ================= */

const STORE_KEY = 'learnanything.v1';

// Every teaching method is a switch. "prompt" ones change what the AI is
// asked to write; "code" ones change what the app itself does.
const METHOD_INFO = {
  preTest:        { label: 'Pre-test',            help: 'A few ungraded questions BEFORE the lesson to prime your brain.' },
  recall:         { label: 'Quiz after the lesson (active recall)', help: 'Testing yourself beats rereading.' },
  spaced:         { label: 'Spaced repetition',   help: 'Old questions return on a schedule, just before you would forget them.' },
  interleave:     { label: 'Interleaving',        help: 'Each quiz also mixes in questions from earlier lessons.' },
  explainBack:    { label: 'Explain it back',     help: 'Write a short summary in your own words and get AI feedback.' },
  workedExamples: { label: 'Worked examples',     help: 'A full step-by-step example in each lesson.' },
  analogies:      { label: 'Analogies',           help: 'Ideas explained through everyday comparisons.' },
  chunking:       { label: 'Chunking',            help: 'Short sections instead of long blocks of text.' }
};

function defaultState() {
  return {
    settings: {
      apiKey: '',
      model: 'gemini-2.5-flash',
      theme: 'auto',
      fontScale: 1,
      spacing: 'normal',
      easyFont: false,
      reduceMotion: false,
      allowAhead: false,
      methods: {
        preTest: false, recall: true, spaced: true, interleave: true,
        explainBack: false, workedExamples: true, analogies: true, chunking: true
      }
    },
    courses: [],
    cards: []
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
      cards: Array.isArray(p.cards) ? p.cards : []
    };
  } catch (e) {
    return defaultState();
  }
}

let state = (typeof localStorage !== 'undefined') ? loadState() : defaultState();

// What is on screen right now (not saved).
const ui = {
  view: 'home',      // home | new | course | lesson | review | settings
  courseId: null,
  session: null,     // the lesson in progress
  review: null,      // the review in progress
  message: null,     // {type:'error'|'ok', text}
  busy: null,        // text while waiting for the AI
  draft: {},         // keeps the "new course" form filled in after an error
  focus: null        // CSS selector to focus after drawing
};

function saveState() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state));
  } catch (e) {
    ui.message = { type: 'error', text: 'Could not save to this browser. Storage may be full or blocked (private browsing?).' };
  }
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

/* ================= 4. The AI (swap providers here) ================= */

function parseJSON(text) {
  let t = String(text).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  try { return JSON.parse(t); } catch (e) {
    const a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a >= 0 && b > a) { try { return JSON.parse(t.slice(a, b + 1)); } catch (e2) { /* fall through */ } }
    throw new Error('The AI answer was not in the expected format. Please try again.');
  }
}

// To use a different AI later, only this function needs to change. It takes
// a prompt and must return a JavaScript object parsed from JSON.
async function callAI(prompt) {
  const s = state.settings;
  if (!s.apiKey) throw new Error('Add your Gemini API key in Settings first.');
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(s.model) + ':generateContent';
  let res;
  // Google's free models sometimes answer 503 ("busy"). That is shared
  // capacity, not your key, so wait a moment and try again (up to 3 retries).
  const waits = [2000, 5000, 10000];
  for (let attempt = 0; ; attempt++) {
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': s.apiKey },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: 'application/json', temperature: 0.7 }
        })
      });
    } catch (e) {
      throw new Error('Could not reach the AI. Check your internet connection.');
    }
    if (res.status === 503 && attempt < waits.length) {
      await new Promise(r => setTimeout(r, waits[attempt]));
      continue;
    }
    break;
  }
  if (res.status === 503) {
    throw new Error('Google\'s AI is busy right now. This is shared capacity, not a problem with your key. Wait a minute and try again, or change the model name in Settings to a lighter one such as gemini-2.5-flash-lite.');
  }
  if (!res.ok) {
    let detail = '';
    try { const e = await res.json(); detail = (e.error && e.error.message) || ''; } catch (e2) { /* ignore */ }
    if (res.status === 429) throw new Error('The free AI limit was reached. Wait a minute and try again.');
    if (res.status === 400 || res.status === 403) throw new Error('The AI rejected the request. Check your API key and model name in Settings. ' + detail);
    if (res.status === 404) throw new Error('That model name was not found. Change the model in Settings. ' + detail);
    throw new Error('AI error ' + res.status + '. ' + detail);
  }
  const data = await res.json();
  const parts = data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts;
  const text = parts ? parts.map(p => p.text || '').join('') : '';
  if (!text) throw new Error('The AI returned an empty answer. Please try again.');
  return parseJSON(text);
}

function buildOutlinePrompt(d) {
  return [
    'You are an expert curriculum designer who uses evidence-based teaching.',
    'Topic the learner wants to learn: ' + d.topic,
    'Learner level: ' + d.level + '.',
    d.notes ? 'Learner notes and goals: ' + d.notes : '',
    'Create a course with exactly ' + d.count + ' lessons, one per ' + PERIOD_NAME[d.period] + ', each about ' + PERIOD_MINUTES[d.period] + ' minutes long.',
    'Order the lessons so each builds on the previous ones. Do not repeat content across lessons.',
    'Return ONLY JSON in this shape:',
    '{"title": "short course title", "lessons": [{"title": "lesson title", "summary": "one sentence on what this lesson covers"}]}'
  ].filter(Boolean).join('\n');
}

function buildLessonPrompt(course, i, m) {
  const l = course.lessons[i];
  const outline = course.lessons.map((x, k) => (k + 1) + '. ' + x.title).join('\n');
  const rules = [
    'Write for a ' + course.level + ' learner in plain, friendly language. No markdown symbols.',
    'Only state things you are confident are true. If something is uncertain or debated, say so.',
    'The whole lesson should take about ' + PERIOD_MINUTES[course.period] + ' minutes.',
    m.chunking
      ? 'Use 3 to 5 short sections, each at most about 120 words, with a clear heading.'
      : 'Use 2 to 4 sections of moderate length, each with a clear heading.'
  ];
  const shape = ['"title": "lesson title"', '"sections": [{"heading": "...", "text": "..."}]', '"keyTakeaways": ["3 to 5 short points"]'];
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
    'Return ONLY JSON in this shape:',
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

function cleanLesson(o) {
  if (!o || !Array.isArray(o.sections) || !o.sections.length) {
    throw new Error('The AI did not return a usable lesson. Please try again.');
  }
  const sections = o.sections.filter(s => s && s.text).map(s => ({ heading: String(s.heading || ''), text: String(s.text) }));
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
  if (ui.busy) html += '<div class="busy" role="status">' + esc(ui.busy) + '</div>';
  const titles = { home: 'Learn Anything', new: 'New course', course: 'Course', lesson: 'Lesson', review: 'Review', settings: 'Settings' };
  let title = titles[ui.view] || 'Learn Anything';
  switch (ui.view) {
    case 'home': html += viewHome(); break;
    case 'new': html += viewNew(); break;
    case 'course': html += viewCourse(); break;
    case 'lesson': html += viewLesson(); break;
    case 'review': html += viewReview(); break;
    case 'settings': html += viewSettings(); break;
  }
  main.innerHTML = html;
  document.getElementById('title').textContent = title;
  document.title = title === 'Learn Anything' ? title : title + ' - Learn Anything';
  ['home', 'review', 'settings'].forEach(v => {
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
  state.courses.forEach(c => {
    const done = c.lessons.filter(l => l.completed).length;
    const pct = Math.round(100 * done / c.lessons.length);
    const next = c.lessons.findIndex(l => !l.completed);
    let nextHtml = '';
    if (next < 0) nextHtml = '<p>Course complete. Well done!</p>';
    else {
      const st = lessonStatus(c, next, state.settings);
      if (st === 'ready') nextHtml = '<button class="btn primary" data-action="startLesson" data-id="' + c.id + '" data-i="' + next + '">Start lesson ' + (next + 1) + ': ' + esc(c.lessons[next].title) + '</button>';
      else nextHtml = '<p class="muted">Next lesson (' + (next + 1) + ') opens ' + esc(niceDate(lessonDate(c, next))) + '.</p>';
    }
    h += '<section class="card"><h2>' + esc(c.title) + '</h2>' +
      '<p class="muted">' + done + ' of ' + c.lessons.length + ' lessons done, one per ' + PERIOD_NAME[c.period] + '</p>' +
      '<div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="' + pct + '" aria-label="Progress"><span style="width:' + pct + '%"></span></div>' +
      '<div class="row">' + nextHtml + '<button class="btn" data-action="openCourse" data-id="' + c.id + '">All lessons</button></div></section>';
  });
  return h;
}

function viewNew() {
  const d = ui.draft;
  function opt(v, label, cur) { return '<option value="' + v + '"' + (cur === v ? ' selected' : '') + '>' + label + '</option>'; }
  return '<form id="new-form" onsubmit="return false">' +
    '<label class="field" for="f-topic">What do you want to learn?</label>' +
    '<input type="text" id="f-topic" value="' + esc(d.topic || '') + '" placeholder="e.g. Basics of personal budgeting" autocomplete="off">' +
    '<label class="field" for="f-level">Your level</label>' +
    '<select id="f-level">' + opt('complete beginner', 'Complete beginner', d.level || 'complete beginner') + opt('some knowledge', 'Some knowledge', d.level) + opt('intermediate', 'Intermediate', d.level) + opt('advanced', 'Advanced', d.level) + '</select>' +
    '<label class="field" for="f-period">How often do you want a lesson?</label>' +
    '<select id="f-period">' + opt('daily', 'Every day (about 10 min)', d.period || 'daily') + opt('weekly', 'Every week (about 20 min)', d.period) + opt('monthly', 'Every month (about 30 min)', d.period) + '</select>' +
    '<label class="field" for="f-count">How many lessons? (1 to 30)</label>' +
    '<input type="number" id="f-count" min="1" max="30" value="' + esc(d.count || 7) + '" inputmode="numeric">' +
    '<label class="field" for="f-notes">Anything else? (optional: your goals, what to focus on)</label>' +
    '<textarea id="f-notes">' + esc(d.notes || '') + '</textarea>' +
    '<div class="row"><button class="btn primary" data-action="createCourse"' + (ui.busy ? ' disabled' : '') + '>Create course</button>' +
    '<button class="btn" data-action="nav" data-view="home">Cancel</button></div></form>';
}

function viewCourse() {
  const c = getCourse(ui.courseId);
  if (!c) return '<p>Course not found.</p>';
  let h = '<h2>' + esc(c.title) + '</h2><p class="muted">' + esc(c.level) + ' level. Started ' + esc(niceDate(c.start)) + '.</p><ol class="steps">';
  c.lessons.forEach((l, i) => {
    const st = lessonStatus(c, i, state.settings);
    let status, btn = '';
    if (st === 'done') { status = 'Done' + (typeof l.score === 'number' ? ' (quiz ' + l.score + '%)' : ''); btn = '<button class="btn" data-action="startLesson" data-id="' + c.id + '" data-i="' + i + '">Revisit</button>'; }
    else if (st === 'ready') { status = 'Ready'; btn = '<button class="btn primary" data-action="startLesson" data-id="' + c.id + '" data-i="' + i + '">Start</button>'; }
    else if (st === 'locked-date') status = 'Opens ' + niceDate(lessonDate(c, i));
    else status = 'Finish the earlier lesson first';
    h += '<li><strong>' + esc(l.title) + '</strong> <span class="pill">' + esc(status) + '</span><br><span class="muted">' + esc(l.summary) + '</span><div class="row">' + btn + '</div></li>';
  });
  h += '</ol><div class="row"><button class="btn" data-action="nav" data-view="home">Back</button><button class="btn danger" data-action="deleteCourse" data-id="' + c.id + '">Delete course</button></div>';
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
  const last = S.steps[S.steps.length - 1] === 'done';
  const total = S.steps.length - 1;
  let h = '<p class="muted">' + esc(c.title) + ' - lesson ' + (S.index + 1) + ' of ' + c.lessons.length + (step !== 'done' ? ' - step ' + (S.step + 1) + ' of ' + total : '') + '</p>';
  h += '<h2 id="step-title" tabindex="-1">' + esc(lesson.title) + '</h2>';

  if (step === 'pretest') {
    h += '<h3>Warm-up (not graded)</h3><p>Try these before reading. Guessing is fine. It primes your brain to learn.</p>';
    h += renderQuestions(S.preItems, S.preAnswers);
    h += '<p id="inline-msg" class="muted" role="status"></p><div class="row">' +
      (S.preAnswers ? '<button class="btn primary" data-action="next">Continue to the lesson</button>'
        : '<button class="btn primary" data-action="submitPre">Check my answers</button>') + '</div>';
  } else if (step === 'lesson') {
    h += '<div class="row"><button class="btn" data-action="speak">Read aloud</button><button class="btn" data-action="stopSpeak">Stop reading</button></div>';
    content.sections.forEach(s => {
      h += (s.heading ? '<h3>' + esc(s.heading) + '</h3>' : '') + paras(s.text);
    });
    if (content.analogy) h += '<section class="card"><h3>Think of it this way</h3>' + paras(content.analogy) + '</section>';
    if (content.workedExample) {
      h += '<section class="card"><h3>Worked example</h3>' + paras(content.workedExample.problem) + '<ol class="steps">' +
        content.workedExample.steps.map(x => '<li>' + esc(x) + '</li>').join('') + '</ol></section>';
    }
    if (content.keyTakeaways.length) h += '<h3>Key takeaways</h3><ul>' + content.keyTakeaways.map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>';
    const nextName = { quiz: 'Take the quiz', explain: 'Explain it back', done: 'Finish lesson' }[S.steps[S.step + 1]];
    h += '<div class="row"><button class="btn primary" data-action="next">' + nextName + '</button>' +
      '<button class="btn" data-action="regen">Regenerate lesson</button></div>';
  } else if (step === 'quiz') {
    h += '<h3>Quiz</h3>';
    h += renderQuestions(S.quizItems, S.quizAnswers);
    if (S.quizAnswers) {
      const sc = scoreOf(S.quizItems, S.quizAnswers);
      h += '<div class="msg ok" id="result" tabindex="-1" role="status">You scored ' + sc + ' of ' + S.quizItems.length + '.' +
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
    const nxt = S.index + 1;
    h += '<div class="msg ok" id="result" tabindex="-1" role="status">Lesson complete. Nice work!' +
      (typeof lesson.score === 'number' ? ' Quiz score: ' + lesson.score + '%.' : '') + '</div>';
    if (nxt < c.lessons.length) {
      const st = lessonStatus(c, nxt, state.settings);
      if (st === 'ready') h += '<p>The next lesson is ready.</p><div class="row"><button class="btn primary" data-action="startLesson" data-id="' + c.id + '" data-i="' + nxt + '">Start lesson ' + (nxt + 1) + '</button></div>';
      else h += '<p>Next lesson opens <strong>' + esc(niceDate(lessonDate(c, nxt))) + '</strong>. Come back then.</p>';
    } else h += '<p>That was the last lesson. Course complete!</p>';
    h += '<div class="row"><button class="btn" data-action="nav" data-view="home">Home</button></div>';
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
    '<label class="field" for="s-model">Model name</label><input type="text" id="s-model" data-setting="model" value="' + esc(s.model) + '" autocapitalize="off" spellcheck="false">' +
    '<p class="muted">If the AI says a model was not found, look up a current free model name in Google AI Studio and paste it here.</p>' +
    '<div class="row"><button class="btn" data-action="testKey"' + (ui.busy ? ' disabled' : '') + '>Test connection</button></div>';
  h += '<h2>Teaching methods</h2><p class="muted">Switch any combination on or off. Applies to lessons created from now on (use Regenerate to redo a lesson).</p>';
  Object.keys(METHOD_INFO).forEach(k => { h += chk(k, METHOD_INFO[k].label, METHOD_INFO[k].help, 'method'); });
  h += '<h2>Schedule</h2>' + chk('allowAhead', 'Let me work ahead', 'Open upcoming lessons early instead of waiting for their date.', 'setting');
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

async function withBusy(text, fn) {
  ui.busy = text; ui.message = null; render(); announce(text);
  try { return await fn(); }
  finally { ui.busy = null; }
}

async function createCourse() {
  const d = {
    topic: document.getElementById('f-topic').value.trim(),
    level: document.getElementById('f-level').value,
    period: document.getElementById('f-period').value,
    count: parseInt(document.getElementById('f-count').value, 10),
    notes: document.getElementById('f-notes').value.trim()
  };
  ui.draft = d;
  if (!d.topic) return inlineErrorNew('Please type what you want to learn.');
  if (!(d.count >= 1 && d.count <= 30)) return inlineErrorNew('Choose between 1 and 30 lessons.');
  try {
    const out = await withBusy('Planning your course...', () => callAI(buildOutlinePrompt(d)));
    let lessons = (out && Array.isArray(out.lessons)) ? out.lessons.filter(l => l && l.title) : [];
    if (!lessons.length) throw new Error('The AI did not return a course plan. Please try again.');
    lessons = lessons.slice(0, d.count).map(l => ({ title: String(l.title), summary: String(l.summary || ''), completed: false, content: null }));
    const course = { id: uid(), title: String((out && out.title) || d.topic), level: d.level, period: d.period, start: todayStr(), lessons: lessons };
    state.courses.push(course);
    saveState();
    ui.draft = {};
    go('course', { courseId: course.id });
  } catch (e) {
    setError(e); render();
  }
}
function inlineErrorNew(text) { ui.message = { type: 'error', text: text }; ui.focus = '#main'; render(); }

async function startLesson(courseId, index) {
  const c = getCourse(courseId);
  if (!c) return;
  const lesson = c.lessons[index];
  const m = state.settings.methods;
  try {
    if (!lesson.content) {
      ui.view = 'lesson'; ui.session = null;
      lesson.content = await withBusy('Writing your lesson...', async () => cleanLesson(await callAI(buildLessonPrompt(c, index, m))));
      saveState();
    }
    openSession(c, index);
  } catch (e) {
    setError(e);
    ui.view = 'course'; ui.courseId = courseId; render();
  }
}

function openSession(c, index) {
  const lesson = c.lessons[index], content = lesson.content, m = state.settings.methods;
  const steps = stepsFor(content, m);
  const quizItems = content.quiz.map(q => Object.assign({ kind: 'new' }, q));
  let items = quizItems;
  if (m.interleave) {
    const old = pickInterleaved(state.cards, c.id, index, 3).map(card => ({
      kind: 'review', cardId: card.id, review: true, q: card.q, options: card.options, correct: card.correct, explanation: card.explanation
    }));
    items = shuffle(quizItems.concat(old));
  }
  ui.session = { courseId: c.id, index: index, steps: steps, step: 0, preItems: content.preTest, preAnswers: null, quizItems: items, quizAnswers: null, explainText: '', feedback: null };
  go('lesson', { courseId: c.id, focus: '#step-title' });
}

function nextStep() {
  const S = ui.session;
  S.step++;
  if (S.steps[S.step] === 'done') completeLesson();
  window.scrollTo(0, 0);
  ui.focus = S.steps[S.step] === 'done' ? '#result' : '#step-title';
  render();
}

function completeLesson() {
  const S = ui.session, c = getCourse(S.courseId), lesson = c.lessons[S.index];
  lesson.completed = true;
  lesson.completedOn = todayStr();
  if (S.quizAnswers) lesson.score = Math.round(100 * scoreOf(S.quizItems, S.quizAnswers) / S.quizItems.length);
  saveState();
}

function submitPre() {
  const S = ui.session, a = readAnswers(S.preItems.length);
  if (a.indexOf(null) >= 0) return inlineMsg('Please answer every question. Guessing is fine.');
  S.preAnswers = a; ui.focus = '#step-title'; render();
}

function submitQuiz() {
  const S = ui.session, c = getCourse(S.courseId), m = state.settings.methods, today = todayStr();
  const a = readAnswers(S.quizItems.length);
  if (a.indexOf(null) >= 0) return inlineMsg('Please answer every question.');
  S.quizAnswers = a;
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
    saveState();
  }
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
    ui.focus = '#result';
  } catch (e) { setError(e); }
  render();
}

function speak() {
  if (!('speechSynthesis' in window)) { ui.message = { type: 'error', text: 'Read aloud is not supported in this browser.' }; return render(); }
  const S = ui.session, c = getCourse(S.courseId), content = c.lessons[S.index].content;
  const text = [c.lessons[S.index].title].concat(content.sections.map(s => s.heading + '. ' + s.text)).concat(content.analogy ? [content.analogy] : []).concat(content.keyTakeaways).join('\n');
  window.speechSynthesis.cancel();
  window.speechSynthesis.speak(new SpeechSynthesisUtterance(text));
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
  saveState();
  ui.focus = '#result'; render();
}

function exportData() {
  const copy = JSON.parse(JSON.stringify(state));
  copy.settings.apiKey = '';
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
      const key = state.settings.apiKey;
      const d = defaultState();
      state = {
        settings: Object.assign({}, d.settings, p.settings, { methods: Object.assign({}, d.settings.methods, (p.settings && p.settings.methods) || {}), apiKey: key }),
        courses: p.courses, cards: p.cards
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
    case 'openCourse': return go('course', { courseId: data.id });
    case 'deleteCourse':
      if (window.confirm('Delete this course and its review questions? This cannot be undone.')) {
        state.courses = state.courses.filter(c => c.id !== data.id);
        state.cards = state.cards.filter(c => c.courseId !== data.id);
        saveState(); return go('home');
      }
      return;
    case 'startLesson': return startLesson(data.id, parseInt(data.i, 10));
    case 'regen': {
      if (!window.confirm('Write this lesson again with your current settings? Its quiz questions will be replaced.')) return;
      const S = ui.session, c = getCourse(S.courseId);
      c.lessons[S.index].content = null;
      return startLesson(S.courseId, S.index);
    }
    case 'leaveLesson': ui.session = null; return go('course', { courseId: ui.courseId });
    case 'next': return nextStep();
    case 'submitPre': return submitPre();
    case 'submitQuiz': return submitQuiz();
    case 'submitExplain': return submitExplain();
    case 'speak': return speak();
    case 'stopSpeak': if ('speechSynthesis' in window) window.speechSynthesis.cancel(); return;
    case 'startReview': return startReview();
    case 'reviewAnswer': return reviewAnswer(parseInt(data.k, 10));
    case 'reviewNext': ui.review.i++; ui.review.answered = null; ui.focus = '#main'; return render();
    case 'endReview': ui.review = null; return go('home');
    case 'testKey':
      try {
        await withBusy('Testing the connection...', () => callAI('Reply with exactly this JSON: {"ok": true}'));
        ui.message = { type: 'ok', text: 'Connected. The AI answered.' };
      } catch (e) { setError(e); }
      return render();
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
  });
  document.addEventListener('input', e => {
    const t = e.target;
    if (t.dataset && t.dataset.setting === 'fontScale') { state.settings.fontScale = parseFloat(t.value); applySettings(); }
  });
  render();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
}
if (typeof module !== 'undefined') {
  module.exports = { nextBox, gradeCard, dueCards, pickInterleaved, lessonStatus, lessonDate, addDays, cleanQuestion, cleanLesson, parseJSON, buildLessonPrompt, buildOutlinePrompt };
}

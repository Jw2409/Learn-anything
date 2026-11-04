// Learn Anything home-screen widget, for the free Scriptable app.
// The Learn Anything app fills in the two lines below for you
// (Settings > Home-screen widget > Copy widget script).
// Paste this whole script into a new Scriptable script, then add a Scriptable
// widget to your Home Screen and choose this script.

const SERVER = '__SERVER__';
const ID = '__ID__';

const fm = FileManager.local();
const dir = fm.documentsDirectory();
const cachePath = fm.joinPath(dir, 'learn-anything-widget.json');
const SIZES = { small: [158, 158], medium: [338, 158], large: [338, 354] };

function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return String(h >>> 0);
}

// Ask the server how you are doing. If the phone is offline, use the last answer.
async function getData() {
  try {
    const data = await new Request(SERVER + '/w/' + ID).loadJSON();
    if (data && data.key) {
      fm.writeString(cachePath, JSON.stringify(data));
      return data;
    }
  } catch (e) { /* fall through to the saved copy */ }
  try {
    if (fm.fileExists(cachePath)) return JSON.parse(fm.readString(cachePath));
  } catch (e) { /* nothing saved yet */ }
  return null;
}

// Pictures are saved on the phone after the first download.
async function getImage(url) {
  if (!url) return null;
  const path = fm.joinPath(dir, 'learn-img-' + hash(url) + '.jpg');
  try {
    if (fm.fileExists(path)) return fm.readImage(path);
  } catch (e) { /* download again */ }
  try {
    const img = await new Request(url).loadImage();
    fm.writeImage(path, img);
    return img;
  } catch (e) { return null; }
}

// Paint the picture, a dark fade at the bottom for readable text, and the words.
function draw(img, d, family) {
  const size = SIZES[family] || SIZES.medium;
  const W = size[0], H = size[1];
  const small = family === 'small';
  const ctx = new DrawContext();
  ctx.size = new Size(W, H);
  ctx.opaque = true;
  ctx.respectScreenScale = true;
  ctx.setFillColor(new Color('#111111'));
  ctx.fillRect(new Rect(0, 0, W, H));
  if (img) {
    const s = Math.max(W / img.size.width, H / img.size.height);   // fill the box, crop the extra
    const w = img.size.width * s, h = img.size.height * s;
    ctx.drawImageInRect(img, new Rect((W - w) / 2, (H - h) / 2, w, h));
  }
  ctx.setFillColor(new Color('#000000', 0.25));
  ctx.fillRect(new Rect(0, 0, W, H * 0.3));
  const N = 24, top = H * 0.3, step = (H * 0.7) / N;
  for (let i = 0; i < N; i++) {
    ctx.setFillColor(new Color('#000000', 0.82 * Math.pow(i / (N - 1), 1.4)));
    ctx.fillRect(new Rect(0, top + i * step, W, step + 1));
  }
  ctx.setTextAlignedLeft();
  ctx.setTextColor(new Color('#ffffff'));
  ctx.setFont(Font.heavySystemFont(small ? 30 : 36));
  ctx.drawTextInRect(String(d.streak), new Rect(12, 8, W - 24, small ? 36 : 42));
  ctx.setFont(Font.boldSystemFont(small ? 8 : 10));
  ctx.drawTextInRect((d.streak === 1 ? 'DAY' : 'DAYS') + ' STREAK  -  ' + d.name, new Rect(12, small ? 44 : 50, W - 24, 14));
  const capH = family === 'large' ? 70 : small ? 56 : 46;
  ctx.setFont(Font.heavySystemFont(family === 'large' ? 18 : small ? 12 : 14));
  ctx.drawTextInRect(d.caption, new Rect(12, H - capH - 8, W - 24, capH));
  if (!img) {
    ctx.setTextColor(new Color('#bbbbbb'));
    ctx.setFont(Font.mediumSystemFont(10));
    ctx.drawTextInRect('Add a picture: Learn Anything > Settings > Widget pictures', new Rect(12, H * 0.42, W - 24, 28));
  }
  return ctx.getImage();
}

async function main() {
  const family = config.widgetFamily || 'medium';
  const d = await getData();
  const w = new ListWidget();
  if (!d) {
    w.backgroundColor = new Color('#111111');
    const t = w.addText('Open Learn Anything, finish a lesson, then come back here.');
    t.textColor = Color.white();
    t.font = Font.mediumSystemFont(12);
  } else {
    const img = await getImage(d.image);
    w.backgroundImage = draw(img, d, family);
    if (d.appUrl) w.url = d.appUrl;
  }
  w.refreshAfterDate = new Date(Date.now() + 30 * 60 * 1000);
  if (config.runsInWidget) Script.setWidget(w);
  else await w.presentMedium();
  Script.complete();
}

await main();

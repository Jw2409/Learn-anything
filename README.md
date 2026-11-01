# Learn Anything

A free web app that teaches you any topic. You type what you want to learn,
choose daily, weekly or monthly lessons, and it builds a course with quizzes
and review. Teaching methods can be switched on and off in Settings.
Works on iPhone: open it in Safari and use Share > Add to Home Screen.

Your data stays in your own browser. The only outside service used is the AI
you set up in Settings (Gemini by default).

## Put it online for free (GitHub Pages, no commands needed)

1. Go to github.com and create a free account (or sign in).
2. Click the + at the top right > New repository.
   - Name: learn-anything
   - Choose Public (free Pages needs Public on a free account)
   - Tick "Add a README file" is NOT needed. Click Create repository.
3. On the new empty repository page, click "uploading an existing file".
4. Drag ALL the files from the unzipped learn-anything folder into the
   page: index.html, app.js, style.css, manifest.json, icon.png, README.md.
   Click Commit changes.
5. Go to Settings (the repo's own Settings tab) > Pages.
   Under Branch, pick main and folder /(root), then Save.
6. Wait 1 to 2 minutes. The page shows your address:
   https://YOUR-USERNAME.github.io/learn-anything/
7. On your iPhone, open that address in Safari, tap Share, then
   Add to Home Screen.
8. Open the app, go to Settings, paste your Gemini API key.

Your API key is never uploaded to GitHub. You type it into the app on each
device and it stays in that browser.

## Try it on your PC first (optional)

Open a terminal in this folder and run:

    python -m http.server 8000

Then open http://localhost:8000 in your browser.

# Setting up reminders and the widget

Everything here is free. You do it once.

Why it needs extra setup: an iPhone web app cannot wake itself up at a set
time. Something on the internet has to send the reminder. That "something" is a
tiny program (cloudflare-worker.js) that runs for free on Cloudflare. The app
tells it your schedule and how you are doing; it sends the reminders and picks
the widget picture. It never sees your lessons, answers or your Gemini key.

## Part 1: The reminder server (Cloudflare, about 10 minutes)

Menu names in Cloudflare change now and then. If one is slightly different,
look for the closest match.

1. Go to cloudflare.com and create a free account.
2. In the dashboard open **Workers & Pages**, then **Create**, then **Create
   Worker**. Start from the Hello World example. Name it `learn-reminders` and
   click **Deploy**.
3. Click **Edit code**. Delete everything in the editor, open
   `cloudflare-worker.js` from this folder in Notepad, copy ALL of it, paste it
   in, and click **Deploy**.
4. Create the storage: in the left menu open **Storage & Databases**, then
   **KV**, then **Create**. Name it `learn-kv`.
5. Connect the storage to the Worker: open your Worker, go to **Settings**,
   then **Bindings**, then **Add**, choose **KV namespace**. The variable name
   MUST be exactly `KV` (capital letters). Pick `learn-kv`. Save and deploy.
6. Add the clock: in the Worker's **Settings**, find **Triggers** (or Trigger
   Events), then **Cron Triggers**, then **Add**. Enter `* * * * *` (that means
   every minute). Save.
7. Copy your Worker address (it looks like
   `https://learn-reminders.yourname.workers.dev`) and open it in a browser. It
   should say: "Learn Anything reminder server is running."

If it says "Setup problem: add a KV namespace binding", redo step 5.

## Part 2: Turn on reminders in the app

1. Put the new files on GitHub (see README: Updating the app later). Include
   the new files: notify.js, sw.js, widget.js, cloudflare-worker.js,
   SETUP-REMINDERS.md.
2. On your iPhone, close the app and open it again from the Home Screen icon.
   Reminders only work from the Home Screen app, on iOS 16.4 or newer.
3. Settings, then Reminders: paste your Worker address and tap **Connect**.
4. Tap **Turn on reminders** and allow notifications.
5. Tap **Send a test reminder**. It should arrive in a few seconds.
   If not: iPhone Settings, Notifications, Learn, make sure they are allowed.

Reminders arrive in the times you pick, or on "best spacing". The longer a
lesson sits there, the harder the messages get. Never more than 8 a day.

## Part 3: The widget (Scriptable)

1. Install **Scriptable** from the App Store (free).
2. In Learn Anything: Settings, then Home-screen widget, then **Copy widget
   script**.
3. In Scriptable tap **+**, paste, tap the title to name it "Learn Widget".
4. Add pictures: Settings, then Widget pictures. For each character paste the
   web address of a picture (up to 4). Use free-to-use photos from unsplash.com,
   pexels.com or commons.wikimedia.org. On a computer, right-click a photo and
   choose **Copy image address**, then send yourself the links.
5. Long-press your Home Screen, tap **+**, pick **Scriptable**, choose a size,
   tap **Add Widget**. Long-press the widget, tap **Edit Widget**, and choose
   the script "Learn Widget".

Which character shows:
- Lion cub: you are just starting.
- Wolf: you are building a streak.
- Pegasus: streak of 7+ days with an 80%+ average.
- Greek god and robot (swap daily): streak of 14+ days with a 95%+ average.
- Fallen knight: you lost a streak of 3+ days.

## Editing the messages

Open cloudflare-worker.js in Notepad. The messages are near the top, in
groups from gentle to harsh. A leading `!` marks a swearing message and `#`
marks one that needs a streak. Change them, copy the file into the Cloudflare
editor again, and Deploy.

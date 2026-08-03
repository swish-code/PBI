# BPA Platform — start here

This is your website. It's a folder of files that runs on your computer.
You don't need to know web development. Just follow the four steps.

---

## What's inside

Two small programs that run together:

- **the website** — the dashboard you see (in the `src` folder)
- **the waiter** — fetches numbers from Power BI (in the `server` folder)

Right now the waiter serves **sample data**, so the app works immediately.
Later you point it at your real Power BI model by filling in one file.

---

## Step 1 — Install two free things (once)

1. **Node.js** — the engine that runs the code.
   Download the "LTS" version from https://nodejs.org and click through the installer.
2. **VS Code** — where you'll open the folder and press run.
   Download from https://code.visualstudio.com

That's the whole toolkit.

---

## Step 2 — Open this folder

- Open **VS Code**.
- Go to **File → Open Folder** and pick this `bpa-platform` folder.
- Open the built-in terminal: **Terminal → New Terminal** (a command box appears at the bottom).

---

## Step 3 — Run it

Type these two lines into that terminal, pressing Enter after each:

```
npm install
npm run dev
```

- `npm install` downloads the parts it needs (takes a minute, once).
- `npm run dev` starts both the website and the waiter.

You'll see a line like `http://localhost:5173`.
**Hold Ctrl (or Cmd on Mac) and click it** — your dashboard opens in your browser.

That's your website, running on your computer. Try the role dropdown in the
top-right — it changes what data is shown (this is how security will work).

To stop it, click the terminal and press **Ctrl + C**.

---

## Step 4 — Switch from sample data to your real Power BI (when ready)

1. In the `server` folder, rename **`.env.example`** to **`.env`**.
2. Fill in the values (your IT/Azure admin can get most of them fast — see the
   comments in that file).
3. Open `server/server.js` and paste your dashboard's real query into
   `TEMPLATES` (you copy that query from Power BI Desktop → Performance
   Analyzer → **Copy query**).
4. Stop the app (Ctrl + C) and run `npm run dev` again.

The badge at the top will switch from **"Sample data"** to **"Live Power BI,"**
and your real numbers appear — in your own design, not Power BI's.

---

## Later — putting it online for your team

Once it runs on your computer, you "publish" it so others get a link:

- **the website** → Vercel or Azure Static Web Apps (free tier)
- **the waiter** → Azure App Service or Render

You connect this folder and they give you a web address. Not needed yet —
get it running locally first.

---

## If something breaks

- **"npm is not recognized"** → Node.js didn't install; redo Step 1 and reopen VS Code.
- **The page is blank** → make sure `npm run dev` is still running in the terminal.
- **"Login failed" after adding .env** → the robot account likely needs to be
  exempt from MFA, or its password/IDs are off. Check with your Azure admin.
- **Live data is empty** → the query names in `TEMPLATES` must match your real
  measures. Paste the exact one from Power BI's "Copy query."
```

# SWiSH Analytics — Go-Live Checklist (for IT)

A one-page runbook to host the app. It is a Node.js app (Express API + built React SPA)
served on port **7001**, behind an IIS reverse proxy.

---

## What you received
- **The code** (this repo / zip). Contains everything EXCEPT secrets.
- **`server/.env.local`** — sent to you **separately** (it holds live secrets). Place it in
  the `server/` folder. Do NOT commit it. (In the repo it appears as
  `server/.env.local.PRODUCTION-for-IT` / `.env.local.example` — the real one comes separately.)

## Requirements
- Windows Server with **Node.js 18+** (`node -v`).
- IIS with **URL Rewrite** + **Application Request Routing (ARR)** modules.
- Outbound HTTPS to `api.powerbi.com` and `login.microsoftonline.com`.
- The app **must be served over HTTPS** (via the IIS proxy) — logins use Secure cookies.
- The **`server/` folder must be writable** — the app maintains its Power BI token there.

## Steps
1. **Put the code on the server** and open a terminal in the project folder.
2. **Add the config:** copy the separately-sent env file to **`server/.env.local`**.
   Set the 3 URL lines to your real public address:
   - `APP_URL=https://analytics.<yourdomain>`
   - `MS_REDIRECT_URI=https://analytics.<yourdomain>/api/auth/microsoft/callback`
   - (leave `PORT=7001`)
3. **Build & run:**
   ```
   npm install
   npm run build
   npm start
   ```
   The app now listens on `http://127.0.0.1:7001`. Run it as a Windows service
   (e.g. NSSM) so it restarts on reboot.
   > Power BI connects automatically using the pre-authorised token already inside the
   > env file (`PBI_REFRESH_TOKEN`) — **no device-code / interactive login is needed.** On
   > first start the app copies it into `server/.pbi-token.json` and auto-renews from there.
4. **IIS reverse proxy:** point the site at `http://127.0.0.1:7001`. A ready `web.config`
   (URL Rewrite → ARR) is in the project root. In IIS Manager enable ARR:
   *Application Request Routing Cache → Server Proxy Settings → Enable proxy.*
5. **Azure redirect URI (one-time):** in Azure Portal → App registrations →
   app `b16c4d77-3582-4951-ab0c-e0f326c5fb94` → Authentication → Web → add:
   `https://analytics.<yourdomain>/api/auth/microsoft/callback`
   (must match `MS_REDIRECT_URI` exactly). Enable **ID tokens** if prompted.

## Verify
- `https://analytics.<yourdomain>/` loads the login page.
- "Sign in with Microsoft" works (redirects back and logs in).
- Admin login: `admin@swishhh.net` (password provided separately).
- First load of each page warms from Power BI (a few seconds), then it's fast/cached.

## Security notes
- Never commit `server/.env` or `server/.env.local` (already git-ignored).
- After go-live, the dev team should **rotate the Azure client secret** and update the env.
- Cookies are set **Secure** automatically because `APP_URL` is https — so the site MUST be
  served over HTTPS (via the IIS proxy) or logins won't stick.

## Notes for the dev/data team (not IT)
- `MODEL-FIX-STEPS.md` — optional Power BI model tweak; performance is already ~2s without it.
- Node entry points: `npm start` (prod, serves ./dist) · `npm run dev` (local, Vite + API).

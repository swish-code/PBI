# Deployment (for IT) - SWiSH Analytics

The app is a **single Node process** that serves both the API and the built web app.
Development (localhost) is done by the data team; **hosting is IT** via **IIS reverse proxy**.

## What IT does

### 1. Prerequisites
- **Node.js 18+** (LTS) on the Windows host.
- The repo, plus a **`server/.env.local`** file with the production values (see below).
  Never commit `.env.local` - it holds secrets.

### 2. Install & build
```powershell
npm ci               # install exact dependencies
npm run build        # compile the web app -> ./dist (hashed, cached assets)
```

### 3. Run (production)
```powershell
npm start          # = SERVE_STATIC=1 node server/server.js  (one process: API + SPA)
```
`SERVE_STATIC=1` (also set in `.env.local`) serves the built SPA + API from one process.
It listens on **PORT (default 7001)**. Run it as a Windows service / behind a process
manager (NSSM, pm2) so it restarts on reboot. One process serves everything.

### 4. Configuration - `server/.env.local` (overrides `server/.env`)
The server loads **`.env.local` first (wins)**, then `.env` (dev defaults). IT only
needs to set what differs in production. Typical `.env.local`:
```
PORT=7001
SERVE_STATIC=1
APP_URL=https://analytics.yourcompany.com           # public URL users hit
TRUST_PROXY_HOPS=1                                   # behind IIS/ARR
MS_REDIRECT_URI=https://analytics.yourcompany.com/api/auth/microsoft/callback
# Secret/dataset overrides go here too, e.g.:
# MS_CLIENT_SECRET=...       (rotate here when the Azure secret expires)
```
A ready-to-copy template lives at `server/.env.local.example`.

### 5. IIS reverse proxy
- Install **URL Rewrite** + **Application Request Routing (ARR)**.
- Enable ARR proxy, then reverse-proxy the site to `http://localhost:7001` (the PORT).
- Because the SPA and API share the same origin, **no path rewriting is needed** -
  forward everything (`/` and `/api/*`) to the Node process.
- ARR forwards `X-Forwarded-*` headers; the server already trusts them
  (`TRUST_PROXY_HOPS`) so secure cookies and client IPs work.
- Terminate **HTTPS at IIS** (users must reach the site over https for Microsoft login).

### 6. Microsoft (Azure AD) sign-in
Users log in with their company Microsoft account (no passwords stored).
On the Azure **App Registration** (client id `b16c4d77-...`, tenant `e37d603e-...`):
- **Authentication -> Web -> Redirect URIs**: add the **public** callback, exactly:
  `https://analytics.yourcompany.com/api/auth/microsoft/callback`
  (and keep `http://localhost:7001/api/auth/microsoft/callback` for local testing).
- **API permissions**: `openid`, `profile`, `email`, `User.Read` - grant admin consent.
- Set `MS_REDIRECT_URI` in `.env.local` to that same public callback URL.
- **Client secrets expire** - when they do, sign-in breaks until IT pastes a new
  secret value into `MS_CLIENT_SECRET` in `.env.local` and restarts the service.

## Notes
- **Health check**: `GET /api/status` returns `200` when the server is up.
- **Ports**: server = `PORT` (7001). In dev, the Vite site is on `:5173` and proxies
  `/api` to the server; production doesn't use Vite (the built `dist` is served directly).
- **Back up `server/data/`** - it holds the app's own state (users, audit, working
  hours, AOV targets, location mappings, dataset IDs, home layouts). Must persist across
  redeploys; do not wipe it.
- **Secrets** (`server/.env`, `server/.env.local`, `server/.pbi-token.json`) stay on the
  host only - keep them out of source control.

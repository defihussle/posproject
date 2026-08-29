# Clover Mini — Phase 1 local test steps

**Scope:** OAuth only. Connect the draft Clover app, store the merchant's token
off-git, and prove the token works with a read-only merchant lookup.

**Nothing about payments changes.** `PAYMENTS_PROVIDER` stays `mock`, no card
button changes, no Cloud Pay Display call. See
[plan.md](plan.md) · [task.md](task.md).

> Jargon, one line each:
> - **OAuth code** — a one-time ticket Clover puts in the redirect URL; our
>   server swaps it for a long-lived token.
> - **Callback / redirect URL** — the address on our server Clover sends the
>   browser back to after you click Connect.
> - **Sandbox** — Clover's fake-money test world. Nothing here touches real cards.

---

## 1. What you need before starting

- **Docker Desktop running** (the Postgres container `narcos_tacos_db` lives there).
- Your Clover sandbox app **Narcos Pos** open in the Clover developer dashboard.

---

## 2. Apply the database migration

Phase 1 adds one new table, `clover_oauth_tokens`. Apply it locally:

```powershell
docker compose up -d
docker exec -i narcos_tacos_db psql -U narcos -d narcos_tacos < database/clover_oauth.sql
```

Confirm the schema guard is happy:

```powershell
cd backend
npm run check:schema
```

You want `Schema OK`.

> **The app will refuse to boot** if this table is missing — that's the schema
> guard doing its job. See §8 for the production side, which is **not done yet**.

---

## 3. Set the environment variables

Edit `backend/.env` (this file is git-ignored — **never** put these in
`.env.example` or paste them into chat).

| Env var name | What to put in it |
| --- | --- |
| `CLOVER_APP_ID` | Your app's **App ID / client_id**. Public value: `2P5T9VH3N0H7T` |
| `CLOVER_APP_SECRET` | The matching **App Secret** from the Clover dashboard. **Secret — backend only.** |
| `CLOVER_RAID` | Leave **blank** for Phase 1. Only used from Phase 3 (talking to a device). |
| `CLOVER_MERCHANT_ID` | `2N9FRNJANSV31` (the sandbox Test Merchant). Optional but recommended — it pins this server to one merchant. |
| `CLOVER_API_BASE` | `https://apisandbox.dev.clover.com` (this is also the default if you leave it out) |

Leave `PAYMENTS_PROVIDER=mock` exactly as it is.

**Where to find the App Secret:** Clover dashboard → **Your Apps** → *Narcos Pos*
→ **App Settings** → *API tokens / App Secret*.

---

## 4. Clover dashboard settings — leave these as they are

These are already correct and were **proven working**: Clover has already
redirected to our callback once.

| Setting | Value |
| --- | --- |
| Site URL | `http://localhost:4000` |
| Alternate Launch Path | `/api/clover/oauth/callback` |
| OAuth response type | **Code** (not Token) |
| Device family | Mini 3rd Gen |
| Permissions | Read + Write Orders, Read + Write Payments, Read Merchant |

Do **not** change the Site URL to `api.narcostacos.ca` yet — that cutover is a
Phase 5 decision (plan.md §8, open questions).

---

## 5. Start the backend on Windows

The Clover redirect goes to **port 4000 on your own machine**, so the backend
must be listening there. In VS Code, open a terminal:

```powershell
cd backend
npm run dev
```

You should see these lines:

```
Payments: provider=mock, stripeClient=not configured
Clover: configured, apiBase=https://apisandbox.dev.clover.com, merchantPin=set
Narcos Tacos POS API running on http://localhost:4000
```

- `Clover: configured` means it found `CLOVER_APP_ID` + `CLOVER_APP_SECRET`.
- `Clover: not configured` means one is missing — the app still runs fine, the
  Clover routes just report "not configured".

**Leave this terminal running.** `npm run dev` restarts automatically when
`server.js` changes; plain `node server.js` does not.

Quick check that the route is alive — open in a browser:

```
http://localhost:4000/api/clover/status
```

Before connecting you should see:

```json
{"configured":true,"merchantId":"2N9FRNJANSV31","tokenPresent":false,"lastMerchantPing":"never"}
```

---

## 6. The Preview → Connect click path

1. Clover developer dashboard → **Your Apps** → **Narcos Pos**.
2. Left sidebar → **App Market Listing** → **Preview** (the app stays a **draft**
   — do not publish it; locked decision L12).
3. Choose the sandbox merchant **Test Merchant** (`2N9FRNJANSV31`).
4. Click **Connect** (it may say *Install* / *Open*).
5. Clover redirects your browser to:
   `http://localhost:4000/api/clover/oauth/callback?merchant_id=…&client_id=…&code=…`

**What you should see — a plain page saying `Clover connected`, listing:**
- Merchant ID
- Merchant name
- **Token stored**

### If it fails instead

The page says **Clover callback failed** and lists the query parameter **names**
that arrived (never their values — a `code` is a live credential).

| Page says | What it means |
| --- | --- |
| "No authorization code arrived" | You opened the URL directly instead of arriving from Connect. |
| "The server has no Clover credentials" | `CLOVER_APP_ID` / `CLOVER_APP_SECRET` missing — set them and **restart the backend**. |
| "pinned to a different merchant" | `CLOVER_MERCHANT_ID` doesn't match who connected. Nothing was stored. |
| "Clover token exchange failed (HTTP 401)" | Wrong App Secret, or the code was already used. Codes are single-use — click Connect again for a fresh one. |
| "Token stored, but the merchant lookup failed" | The token saved but reading the merchant back failed. Check the app has **Read Merchant** permission. |
| Browser says "can't reach this page" | The backend isn't running on port 4000. Go back to §5. |

---

## 7. Check the status afterward

Open in a browser (or `curl`):

```
http://localhost:4000/api/clover/status
```

After a successful connect:

```json
{"configured":true,"merchantId":"2N9FRNJANSV31","tokenPresent":true,"lastMerchantPing":"ok"}
```

| Field | Meaning |
| --- | --- |
| `configured` | The server has an App ID + App Secret. |
| `merchantId` | Which merchant is connected. |
| `tokenPresent` | A token is stored in the database. |
| `lastMerchantPing` | `ok` \| `fail` \| `never` — result of the last merchant lookup. |

This endpoint **never** returns a token or the App Secret.

---

## 8. Production — NOT done, and deliberately so

**Nothing here has been applied to production, and no Clover code has been
pushed.** Per CLAUDE.md's Schema Change Checklist, the migration must reach
production **before** the code that reads it. The backend **exits at boot** when
a required table is missing, so pushing this code first would take the live API
down.

When you are ready, run these two commands yourself with the Render External
Database URL:

```powershell
psql "<Render External Database URL>" -f database/clover_oauth.sql
```

```powershell
cd backend
$env:DATABASE_URL="<Render External Database URL>"; npm run check:schema
```

The second must print **`Schema OK`**. Only then is it safe to push/deploy.

Production needs no Clover env vars at all — with none set, the routes report
"not configured" and every existing flow is unchanged.

---

## 9. What Phase 1 deliberately does NOT do

- No charge, no tip, no Cloud Pay Display, no talking to a Mini.
- No `PAYMENTS_PROVIDER=clover` — boot still rejects it (Phase 2's job).
- No frontend change; the Card button is untouched.
- No `stripe_*` column renamed; the `tmr_` reader-id check is untouched.
- No token refresh yet — Phase 1 stores `refresh_token` and its expiry but
  never uses them. Refreshing belongs with the code that depends on a live
  token (Phase 3).

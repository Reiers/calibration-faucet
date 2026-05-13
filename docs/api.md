# Plumbline Faucet API

Programmatic interface to the Filecoin Calibration faucet at `https://faucet.reiers.io`. Intended for CLI tooling, integration tests, and CI pipelines that need tFIL or USDFC on calibration without solving a captcha.

All endpoints return JSON. CORS is open.

---

## Quick reference

| Method | Path                | Purpose                                     | Auth |
|--------|---------------------|---------------------------------------------|------|
| GET    | `/healthz`          | liveness + dispenser balances               | —    |
| GET    | `/api/info`         | brand, drip amounts, rate-limit defaults    | —    |
| GET    | `/api/stats`        | lifetime + 24h counters                     | —    |
| GET    | `/api/recent`       | last N drips (address + tx hashes)          | —    |
| GET    | `/api/convert`      | 0x ↔ f410f address conversion               | —    |
| POST   | `/api/drip/fil`     | request a tFIL drip                         | captcha OR API key |
| POST   | `/api/drip/usdfc`   | request a USDFC drip (0x / t410f only)      | captcha OR API key |

---

## Authentication for drip endpoints

The drip endpoints accept **either**:

1. **Cloudflare Turnstile token** (the default, used by the browser UI). Pass `{ "turnstileToken": "..." }` in the JSON body. Not usable from CLI.

2. **API key** (intended for CLI / CI). Pass it as an HTTP header:

   ```
   Authorization: Bearer <key>
   ```

   or:

   ```
   X-API-Key: <key>
   ```

   A request that presents a valid, enabled key bypasses the captcha entirely.

### Getting an API key

API keys are issued out-of-band by the operator. To request one, email `nicklas@reiers.io` (or DM `@Reiers` on Filecoin Slack) with:

- Your name / project name
- A short description of what you'll use it for (test runner, CI, CLI, etc)
- Expected drip volume (per day)

Default per-key allowance is 50 drips per asset per 24 hours, which is plenty for normal CI usage. Higher limits are available on request.

### Rate limits with an API key

When using an API key, the per-IP limit is **replaced** by a per-key window. Per-address limits still apply (so you cannot drain the faucet into a single wallet by rotating keys). Default per-address limit is 2 drips per asset per 24 hours.

| Limit            | With API key             | Without API key (captcha) |
|------------------|--------------------------|---------------------------|
| Per IP           | not enforced             | 2 / asset / 24h           |
| Per address      | 2 / asset / 24h          | 2 / asset / 24h           |
| Per API key      | configurable per key     | n/a                       |

---

## Endpoints

### `GET /api/info`

Public metadata about the faucet. Useful for clients to discover drip amounts and rate-limit defaults.

```bash
curl https://faucet.reiers.io/api/info
```

```json
{
  "brand": "Plumbline",
  "filDrip": "5",
  "usdfcDrip": "100",
  "ipRateLimitSec": 86400,
  "addressRateLimitSec": 86400,
  "maxDripsPerIp": 2,
  "maxDripsPerAddress": 2,
  "turnstileSiteKey": "0x...",
  "usdfcAddress": "0xb3042734b608a1B16e9e86B374A3f3e389B4cDf0",
  "rpcUrl": "https://api.calibration.node.glif.io/rpc/v1",
  "dispenser": "0x...",
  "filBalanceWei": "...",
  "usdfcBalanceWei": "...",
  "minReserveFil": "20",
  "minReserveUsdfc": "500",
  "apiKeyAuthSupported": true
}
```

### `POST /api/drip/fil`

Request a tFIL drip.

**Body:**
- `address` (required) — any of:
  - `0x...` Ethereum-style address (40 hex)
  - `t410f...` delegated Filecoin address (gets converted to the matching 0x)
  - `t1...`, `t3...` native Filecoin BLS/SECP address
  - `t0...` ID address
- `turnstileToken` (optional, ignored if API key present) — Turnstile token from the browser UI

**Headers (for CLI):**
- `Authorization: Bearer <key>` **or** `X-API-Key: <key>`

**Example (CLI with API key):**

```bash
curl -X POST https://faucet.reiers.io/api/drip/fil \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer pk_yourkeyhere" \
  -d '{"address": "0xYourAddressHere"}'
```

**Success response (200):**

```json
{
  "ok": true,
  "txHash": "0xabc...",
  "verified": true,
  "amount": "5000000000000000000",
  "asset": "fil"
}
```

### `POST /api/drip/usdfc`

Same as `/api/drip/fil` but for the USDFC ERC-20. Only accepts `0x` or `t410f` addresses (USDFC is an ERC-20 token; native t1/t3 addresses don't hold ERC-20 balances directly).

```bash
curl -X POST https://faucet.reiers.io/api/drip/usdfc \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer pk_yourkeyhere" \
  -d '{"address": "0xYourAddressHere"}'
```

### `GET /api/convert`

Convert between `0x` and `f410f` form using the underlying lotus RPC.

```bash
curl "https://faucet.reiers.io/api/convert?address=0xabc..."
```

```json
{ "ok": true, "input": "0xabc...", "output": "f410f..." }
```

### `GET /api/stats`

```bash
curl https://faucet.reiers.io/api/stats
```

```json
{
  "totalDrips": { "fil": 1234, "usdfc": 567 },
  "totalDistributed": { "fil": "6170", "usdfc": "56700" },
  "drips24h": { "fil": 42, "usdfc": 13 }
}
```

### `GET /api/recent?limit=10`

Last N drips (max 50). Returns address + tx hash + timestamp.

```bash
curl "https://faucet.reiers.io/api/recent?limit=5"
```

---

## Error responses

All errors are JSON with `ok: false` and an `error` code. HTTP status reflects the error class.

| HTTP | error                       | When                                                        |
|------|-----------------------------|-------------------------------------------------------------|
| 400  | `bad_request`               | body didn't parse                                           |
| 400  | `invalid_address`           | address couldn't be classified                              |
| 400  | `usdfc_native_unsupported`  | tried to drip USDFC to a native t1/t3 address               |
| 400  | `captcha`                   | no API key, and Turnstile token was missing or invalid      |
| 401  | `invalid_api_key`           | API key header present but not recognised                   |
| 401  | `revoked_api_key`           | API key was disabled by the operator                        |
| 429  | `api_key_rate_limited`      | per-key drip window exhausted                               |
| 429  | `ip_rate_limited`           | per-IP window exhausted (no API key)                        |
| 429  | `address_rate_limited`      | per-address window exhausted                                |
| 503  | `faucet_dry`                | dispenser balance below the configured reserve              |
| 500  | `drip_failed`               | RPC error sending the on-chain tx                           |

A 429 always includes:

```json
{
  "scope": "ip" | "address" | "api_key",
  "used": 2,
  "max": 2,
  "windowSec": 86400,
  "retryAfterSec": 12345,
  "retryAtUnix": 1700000000
}
```

Use `retryAtUnix` (epoch seconds) to know when to retry — it's already adjusted for the actual window open time.

---

## Example: shell helper for CI

```bash
#!/usr/bin/env bash
set -euo pipefail

ADDR="${1:?usage: drip-fil <address>}"
KEY="${PLUMBLINE_API_KEY:?set PLUMBLINE_API_KEY in env}"

resp=$(curl -fsS -X POST https://faucet.reiers.io/api/drip/fil \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${KEY}" \
  -d "{\"address\": \"${ADDR}\"}")

echo "${resp}" | jq .
tx=$(echo "${resp}" | jq -r .txHash)
echo "Drip tx: ${tx}"
```

## Example: TypeScript

```ts
const resp = await fetch('https://faucet.reiers.io/api/drip/fil', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${process.env.PLUMBLINE_API_KEY}`,
  },
  body: JSON.stringify({ address: '0xYourAddressHere' }),
})
const data = await resp.json()
if (!data.ok) throw new Error(`drip failed: ${data.error} (${data.reason ?? ''})`)
console.log('tx:', data.txHash)
```

---

## Operator notes

To issue an API key (operator only):

```bash
pnpm run keygen create --name "Lee CLI test runner" \
  --max-drips 50 --window-sec 86400 --notes "lee@example.com"
```

List keys:

```bash
pnpm run keygen list
```

Revoke / re-enable:

```bash
pnpm run keygen revoke pk_xxxxx
pnpm run keygen enable pk_xxxxx
```

Inspect a key (including current window usage):

```bash
pnpm run keygen show pk_xxxxx
```

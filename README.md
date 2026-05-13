<div align="center">
  <a href="https://github.com/Reiers/plumbline">
    <img src="https://raw.githubusercontent.com/Reiers/plumbline/main/brand/banner.png" alt="Plumbline — public faucet" />
  </a>
</div>

# plumbline-faucet

Public Filecoin Calibration testnet faucet. Drips **tFIL** and **USDFC** independently for builders and Storage Providers. Live at **<https://faucet.reiers.io>**.

Part of the [**Plumbline**](https://github.com/Reiers/plumbline) umbrella — stability infrastructure for Filecoin Calibration.

> _Calibration testnet only. Don't deploy this to mainnet._

---

## What this is

A two-asset public faucet for Filecoin Calibration. tFIL and USDFC are
served from independent panels — take only what you need. Designed
for:

- **Builders** writing FEVM contracts that need gas + USDFC settlement
- **Storage Providers** stress-testing under stable network conditions
- **Tooling authors** automating end-to-end Calibration test runs

Replaces the manual Trove-collateralization ceremony at
`stg.usdfc.net` and the half-deprecated chainsafe USDFC drip with one
HTTP call (or one click) per asset.

## Endpoints

```
GET  /                  landing page (split-panel UI)
GET  /status            full status page (live counters + recent activity)
GET  /healthz           liveness probe
GET  /api/info          public faucet metadata + live dispenser balances
GET  /api/stats         per-asset lifetime + 24h aggregate counters
GET  /api/recent        last N drips (default 10, max 50)
POST /api/drip/fil      { address, turnstileToken } → tFIL drip
POST /api/drip/usdfc    { address, turnstileToken } → USDFC drip
```

Full API reference for CLI / CI integrators: [`docs/api.md`](docs/api.md).
Web-UI callers use Turnstile; CLI / CI callers should use an API key
(`Authorization: Bearer <key>`) issued by the operator — see
[`docs/api.md`](docs/api.md) for the request flow.

### Drip request (browser / captcha)

```bash
curl -X POST https://<your-host>/api/drip/fil \
  -H 'content-type: application/json' \
  -d '{
    "address": "0x...",
    "turnstileToken": "..."
  }'
```

### Drip request (CLI / CI, with API key)

```bash
curl -X POST https://<your-host>/api/drip/fil \
  -H 'content-type: application/json' \
  -H 'Authorization: Bearer pk_yourkeyhere' \
  -d '{"address": "0x..."}'
```

An API key replaces the Turnstile captcha and substitutes its own
per-key rate-limit window for the per-IP limit. Per-address limits
still apply.

Success:

```json
{
  "ok": true,
  "txHash": "0x...",
  "amount": "5000",
  "asset": "fil",
  "recipientBalanceBefore": "...",
  "recipientBalanceAfter": "...",
  "verified": true
}
```

`verified: true` means the server confirmed on-chain that the
recipient's balance moved by at least the drip amount before
returning. The UI surfaces this in the modal as "✓ confirmed."

Errors:

| Status | `error` | Meaning |
| --- | --- | --- |
| 400 | `bad_request`             | Body shape invalid |
| 400 | `invalid_address`         | Recipient is malformed |
| 400 | `native_filecoin_address_not_supported` | t1/t3/t0 received; user should use their delegated 0x |
| 400 | `captcha`                 | Turnstile failed (`reason` carries the code) |
| 429 | `ip_rate_limited`         | Same IP requested this asset in last cooldown window |
| 429 | `address_rate_limited`    | Same address requested this asset in last cooldown window |
| 503 | `faucet_dry`              | Dispenser balance below configured reserve |
| 500 | `drip_failed`             | RPC / chain error during the transfer |

## Address handling

| Form | tFIL | USDFC |
| --- | --- | --- |
| `0x...`         (Ethereum-style)        | ✓ direct send | ✓ direct send |
| `t410f...`      (delegated EAM)         | ✓ extract embedded 0x and send | ✓ extract embedded 0x and send |
| `t1...` / `t3...` (native secp256k1/BLS)| ✗ pending — use delegated 0x | ✗ USDFC is ERC-20 |
| `t0...`         (numeric actor ID)      | ✗ pending — use delegated 0x | ✗ USDFC is ERC-20 |

Native t1/t3/t0 sends via the FEVM `CallActor` precompile are on the
roadmap. SPs running `lotus state account-key-eth <t1addr>` get back
their delegated 0x form, which works today.

## Defaults

| Setting | Default |
| --- | --- |
| tFIL per drip | 5 |
| USDFC per drip | 100 |
| Per-IP cooldown   (per asset) | 24h |
| Per-address cooldown (per asset) | 24h |
| Global per-IP burst | 5 req/sec |
| Min reserve | 20 tFIL + 500 USDFC (faucet refuses below) |

The canonical public deployment runs at much higher drip amounts
(see the live status page); the repo defaults are intentionally
conservative so other operators forking this don't inherit large
drips by accident.

## Local development

```bash
pnpm install

# Required: dispenser key with both tFIL and USDFC balances on Calibration.
# Bootstrap tFIL: https://faucet.calibnet.chainsafe-fil.io/funds.html
# Bootstrap USDFC: open a Trove on https://stg.usdfc.net
cp .env.example .env
# edit .env, set FAUCET_PK
pnpm dev
# faucet listens on http://127.0.0.1:8003

curl http://127.0.0.1:8003/healthz
curl -X POST http://127.0.0.1:8003/api/drip/fil \
  -H 'content-type: application/json' \
  -d '{"address":"0x...your-test-address..."}'
```

In dev with no `TURNSTILE_SECRET` set, captcha is bypassed and the
server logs a loud warning on startup. **Never run a public
deployment without Turnstile.**

## Production deploy

See [`docs/deploy.md`](docs/deploy.md) for the Hetzner + nginx
walkthrough, including dispenser bootstrap (chainsafe drip → Trove
mint), TLS via Cloudflare Origin CA, top-up / key-rotation
operations, and a failure-modes table.

## Security model

- **Single hot wallet.** The dispenser key is the only thing the faucet
  signs with. Compromise drains the dispenser, full stop. Keep
  balances bounded (`MIN_RESERVE_*` enforces a floor below which drips
  fail closed; cap *total* dispenser balance via top-ups, not via the
  faucet).
- **Captcha-first, rate-limit-second.** Cloudflare Turnstile is the
  primary defense against bot floods. SQLite per-IP and per-address
  cooldowns are the secondary defense, scoped per-asset so the two
  rails are independent. A burst limiter at the Fastify layer
  catches obvious DoS attempts before they touch SQLite.
- **`X-Forwarded-For` honored only behind a trusted proxy.** When
  `TRUSTED_PROXY=true` the server reads the X-Forwarded-For chain
  populated by Cloudflare/nginx; otherwise it falls back to the
  socket address. Misconfigure this and rate limiting is either
  bypassed or attributed to the proxy IP.
- **No request bodies are logged.** Drip-success lines log only
  addresses and tx hashes; turnstile tokens, raw IPs, and headers
  are never persisted at info level.
- **No IP attribution in `recent_drips`.** The public `/api/recent`
  endpoint shows recent rows verbatim, so we deliberately don't
  store IP alongside drip records — only the address.
- **On-chain verification.** Every drip awaits the receipt AND
  re-reads the recipient balance to confirm the funds actually
  landed before returning to the client. The `verified` boolean
  in the response is the user-visible signal.

## Contact

Need a larger transfer or a custom amount?

- DM **@Reiers** on Filecoin Slack for anything urgent.
- Tag **@Reiers** in `#fil-net-calibration-discuss` for bigger
  transfers or SP-side requests.

## Roadmap

- [ ] Native `t1` / `t3` / `t0` send via the FEVM `CallActor`
      precompile
- [ ] Auto-refill of the dispenser from external Calibration faucets
      when tFIL drops below a threshold
- [ ] USDFC top-up via owned Troves rather than manual top-up
- [ ] Discord / X verification path for higher-tier drips
- [ ] Public dashboard with historical charts (currently `/status`
      is point-in-time only)

## License

MIT

<div align="center">
  <sub>TSE Reiersen · Org. 929 074 912</sub>
</div>

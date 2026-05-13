// SPDX-License-Identifier: MIT
//
// Plumb (Calibration Faucet) HTTP server.
//
// Two-panel split: tFIL and USDFC are independent drips with their own
// rate limit per (asset, ip) and per (asset, address). A user can drip
// just tFIL, just USDFC, or both — but cannot repeat either inside the
// 24h cooldown window.
//
// Routes:
//   GET  /                  static landing page (public/index.html)
//   GET  /status            static status page  (public/status.html)
//   GET  /api                static API docs page (public/api.html)
//   GET  /healthz           liveness + dispenser balances
//   GET  /api/info          public faucet metadata + live balances
//   GET  /api/stats         lifetime + 24h aggregate counters
//   GET  /api/recent        last N drips (address + tx hashes only)
//   POST /api/drip/fil      { address, turnstileToken } → tFIL drip
//   POST /api/drip/usdfc    { address, turnstileToken } → USDFC drip
//   POST /api/public/drip/fil    { address } → small anonymous tFIL drip
//   POST /api/public/drip/usdfc  { address } → small anonymous USDFC drip
//   GET  /api/claim_token_all?address=...      → ChainSafe-compatible
//                                                 envelope, both tokens
//
// Anonymous public-drip endpoints (intended for public OSS CLIs that
// cannot embed a secret, e.g. SynapS3's `synaps3 wallet fund-testnet`):
//   - No auth, no captcha.
//   - Smaller drip amounts (PUBLIC_FIL_DRIP / PUBLIC_USDFC_DRIP).
//   - Stricter per-IP cap (MAX_PUBLIC_DRIPS_PER_IP, default 1/24h)
//     in addition to the standard per-address cap, which still applies.
//   - Per-IP windows are kept in a separate (asset, ip) bucket so they
//     do not interfere with the captcha-gated path counters.
//
// API key authentication (optional, for CLI / CI integrations):
//   Send `Authorization: Bearer <key>` or `X-API-Key: <key>` on the
//   drip endpoints. When a valid, enabled key is present, the request
//   bypasses Turnstile (no captcha required) and uses the key's own
//   per-window rate limit instead of the per-IP limit. Per-address
//   limits still apply. Keys are managed via `pnpm run keygen`.

import Fastify, { type FastifyRequest, type FastifyReply } from 'fastify'
import cors from '@fastify/cors'
import rateLimitPlugin from '@fastify/rate-limit'
import staticPlugin from '@fastify/static'
import { z } from 'zod'
import { parseEther, parseUnits } from 'viem'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { loadConfig } from './config.js'
import { RateLimitStore } from './rate-limit-store.js'
import { StatsStore } from './stats-store.js'
import { Drip } from './drip.js'
import { verifyTurnstile } from './turnstile.js'
import { classifyRecipient } from './fil-address.js'
import { ApiKeyStore, type ApiKey } from './api-key-store.js'

const USDFC_DECIMALS = 18

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

async function main() {
  const cfg = loadConfig()
  const store = new RateLimitStore(cfg.RATE_LIMIT_DB)
  const stats = new StatsStore(store.db)
  const apiKeys = new ApiKeyStore(store.db)
  const drip = new Drip(cfg)

  // Extract a bearer-style API key from either `X-API-Key` or
  // `Authorization: Bearer ...`. Returns the raw key string, or null
  // if no header was present.
  const extractApiKey = (req: FastifyRequest): string | null => {
    const headerKey = req.headers['x-api-key']
    if (typeof headerKey === 'string' && headerKey.trim() !== '') {
      return headerKey.trim()
    }
    const auth = req.headers['authorization']
    if (typeof auth === 'string') {
      const m = auth.match(/^\s*Bearer\s+(\S+)\s*$/i)
      if (m) return m[1]
    }
    return null
  }

  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? 'info' },
    trustProxy: cfg.TRUSTED_PROXY,
  })

  await app.register(cors, { origin: true })
  await app.register(rateLimitPlugin, {
    max: cfg.GLOBAL_RPS * 60,
    timeWindow: '1 minute',
    keyGenerator: (req) => req.ip,
  })

  const publicDir = path.join(__dirname, '..', 'public')
  await app.register(staticPlugin, {
    root: publicDir,
    prefix: '/',
    decorateReply: false,
  })

  // Pretty URL for the status page: /status -> public/status.html
  const statusHtml = await import('node:fs').then((fs) =>
    fs.promises.readFile(path.join(publicDir, 'status.html'), 'utf8'),
  )
  app.get('/status', async (_req, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8')
    return statusHtml
  })

  // Pretty URL for the API docs page: /api -> public/api.html
  // Sibling to the /api/* JSON namespace; Fastify resolves exact-match
  // routes independently so there is no collision with /api/info etc.
  const apiDocsHtml = await import('node:fs').then((fs) =>
    fs.promises.readFile(path.join(publicDir, 'api.html'), 'utf8'),
  )
  app.get('/api', async (_req, reply) => {
    reply.header('content-type', 'text/html; charset=utf-8')
    return apiDocsHtml
  })


  // ─── Liveness ────────────────────────────────────────────────────
  app.get('/healthz', async () => {
    const state = await drip.state()
    return {
      ok: true,
      dispenser: state.address,
      fil: state.filBalance.toString(),
      usdfc: state.usdfcBalance.toString(),
    }
  })

  // ─── Public metadata + live balances (rendered by the UI) ───────
  app.get('/api/info', async () => {
    const state = await drip.state()
    return {
      brand: cfg.BRAND_NAME,
      brandUrl: cfg.BRAND_URL,
      filDrip: cfg.FIL_DRIP,
      usdfcDrip: cfg.USDFC_DRIP,
      ipRateLimitSec: cfg.IP_RATE_LIMIT_SEC,
      addressRateLimitSec: cfg.ADDRESS_RATE_LIMIT_SEC,
      maxDripsPerIp: cfg.MAX_DRIPS_PER_IP,
      maxDripsPerAddress: cfg.MAX_DRIPS_PER_ADDRESS,
      turnstileSiteKey: cfg.TURNSTILE_SITE_KEY,
      usdfcAddress: cfg.USDFC_ADDRESS,
      rpcUrl: cfg.RPC_URL,
      dispenser: state.address,
      filBalanceWei: state.filBalance.toString(),
      usdfcBalanceWei: state.usdfcBalance.toString(),
      minReserveFil: cfg.MIN_RESERVE_FIL,
      minReserveUsdfc: cfg.MIN_RESERVE_USDFC,
      apiKeyAuthSupported: true,
      publicDrip: {
        enabled: true,
        filDrip: cfg.PUBLIC_FIL_DRIP,
        usdfcDrip: cfg.PUBLIC_USDFC_DRIP,
        maxDripsPerIp: cfg.MAX_PUBLIC_DRIPS_PER_IP,
        windowSec: cfg.IP_RATE_LIMIT_SEC,
      },
    }
  })

  app.get('/api/stats', async () => stats.read())

  app.get('/api/recent', async (req) => {
    const limit = Math.min(50, Math.max(1, Number((req.query as { limit?: string }).limit ?? 10)))
    return { drips: stats.recent(limit) }
  })

  // ─── Address converter (0x ↔ f4) ───────────────────────────────
  // Uses the Filecoin native JSON-RPC at glif (or whatever RPC_URL
  // points at). Lotus exposes:
  //   Filecoin.EthAddressToFilecoinAddress(0xabc) -> f410f…
  //   Filecoin.FilecoinAddressToEthAddress(f410f…) -> 0xabc
  // Native t1/t3/t0 addresses cannot be losslessly mapped to 0x; for
  // those we return a friendly note pointing at the converter limits.
  app.get('/api/convert', async (req) => {
    const addr = String((req.query as { address?: string }).address ?? '').trim()
    if (!addr) return { ok: false, error: 'missing_address' }

    const isEth = /^0x[0-9a-fA-F]{40}$/.test(addr)
    const isFil = /^[ft][0-4][a-zA-Z0-9]+$/.test(addr)
    if (!isEth && !isFil) {
      return { ok: false, error: 'invalid_address' }
    }
    if (isFil && !/^[ft]4/.test(addr)) {
      return {
        ok: false,
        error: 'native_filecoin_no_eth_form',
        reason:
          'Native Filecoin addresses (t1/t3/t0) do not have a lossless 0x form. The converter handles 0x ↔ t410f only.',
      }
    }

    const method = isEth
      ? 'Filecoin.EthAddressToFilecoinAddress'
      : 'Filecoin.FilecoinAddressToEthAddress'
    try {
      const res = await fetch(cfg.RPC_URL, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method,
          params: [addr],
        }),
      })
      if (!res.ok) {
        return { ok: false, error: 'rpc_http', reason: `status ${res.status}` }
      }
      const data = (await res.json()) as { result?: string; error?: { message?: string } }
      if (data.error) {
        return { ok: false, error: 'rpc_error', reason: data.error.message ?? 'unknown' }
      }
      return { ok: true, input: addr, output: data.result }
    } catch (err) {
      return { ok: false, error: 'rpc_unreachable', reason: String(err) }
    }
  })

  // ─── Drip handlers (one per asset) ──────────────────────────────
  const dripBody = z.object({
    // Native BLS (t3) addresses are 86 chars; allow some headroom.
    address: z.string().min(3).max(120),
    turnstileToken: z.string().optional(),
  })

  type Asset = 'fil' | 'usdfc'

  const handleDrip = async (
    asset: Asset,
    req: FastifyRequest,
    reply: FastifyReply,
  ) => {
    const ip = req.ip
    const parsed = dripBody.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: 'bad_request' })
    }

    const recipient = classifyRecipient(parsed.data.address)
    if (recipient.kind === 'invalid') {
      return reply.code(400).send({
        ok: false,
        error: 'invalid_address',
        reason: recipient.reason,
      })
    }
    if (asset === 'usdfc' && recipient.kind === 'filecoin') {
      return reply.code(400).send({
        ok: false,
        error: 'usdfc_native_unsupported',
        reason: 'USDFC is an ERC-20. Only 0x and t410f addresses are accepted. Use the converter to get your t410f form.',
      })
    }
    // For rate-limit and stats keying, use a stable string identifier.
    // For 0x and t410f-as-0x, use the 0x form. For native filecoin
    // (t0/t1/t3), use the original string (lower-cased).
    const target: string =
      recipient.kind === 'eth' || recipient.kind === 'delegated'
        ? recipient.address.toLowerCase()
        : recipient.original.toLowerCase()

    // Resolve API-key authentication first; a valid key bypasses
    // Turnstile and replaces the IP rate-limit with a per-key window.
    const presentedKey = extractApiKey(req)
    let authedKey: ApiKey | null = null
    if (presentedKey !== null) {
      const found = apiKeys.get(presentedKey)
      if (!found) {
        return reply.code(401).send({
          ok: false,
          error: 'invalid_api_key',
          reason: 'API key is not recognised',
        })
      }
      if (!found.enabled) {
        return reply.code(401).send({
          ok: false,
          error: 'revoked_api_key',
          reason: 'API key has been revoked',
        })
      }
      authedKey = found
    }

    if (!authedKey) {
      const tsResult = await verifyTurnstile(
        cfg,
        parsed.data.turnstileToken ?? '',
        ip,
      )
      if (!tsResult.ok) {
        return reply.code(400).send({ ok: false, error: 'captcha', reason: tsResult.reason })
      }
    }

    const now = Math.floor(Date.now() / 1000)

    if (authedKey) {
      const keyWin = apiKeys.windowFor(authedKey.key, asset)
      if (
        keyWin &&
        now - keyWin.windowStartUnix <= authedKey.windowSec &&
        keyWin.count >= authedKey.maxDripsPerWindow
      ) {
        const retryAfterSec =
          authedKey.windowSec - (now - keyWin.windowStartUnix)
        return reply.code(429).send({
          ok: false,
          error: 'api_key_rate_limited',
          scope: 'api_key',
          used: keyWin.count,
          max: authedKey.maxDripsPerWindow,
          windowSec: authedKey.windowSec,
          retryAfterSec,
          retryAtUnix: now + retryAfterSec,
        })
      }
    } else {
      const ipWin = store.windowForIp(ip, asset)
      if (
        ipWin &&
        now - ipWin.windowStartUnix <= cfg.IP_RATE_LIMIT_SEC &&
        ipWin.count >= cfg.MAX_DRIPS_PER_IP
      ) {
        const retryAfterSec = cfg.IP_RATE_LIMIT_SEC - (now - ipWin.windowStartUnix)
        return reply.code(429).send({
          ok: false,
          error: 'ip_rate_limited',
          scope: 'ip',
          used: ipWin.count,
          max: cfg.MAX_DRIPS_PER_IP,
          windowSec: cfg.IP_RATE_LIMIT_SEC,
          retryAfterSec,
          retryAtUnix: now + retryAfterSec,
        })
      }
    }

    const addrWin = store.windowForAddress(target, asset)
    if (
      addrWin &&
      now - addrWin.windowStartUnix <= cfg.ADDRESS_RATE_LIMIT_SEC &&
      addrWin.count >= cfg.MAX_DRIPS_PER_ADDRESS
    ) {
      const retryAfterSec = cfg.ADDRESS_RATE_LIMIT_SEC - (now - addrWin.windowStartUnix)
      return reply.code(429).send({
        ok: false,
        error: 'address_rate_limited',
        scope: 'address',
        used: addrWin.count,
        max: cfg.MAX_DRIPS_PER_ADDRESS,
        windowSec: cfg.ADDRESS_RATE_LIMIT_SEC,
        retryAfterSec,
        retryAtUnix: now + retryAfterSec,
      })
    }

    const reserveProblem = await drip.checkReserves(asset)
    if (reserveProblem) {
      app.log.warn({ reserveProblem, asset }, 'faucet dry')
      return reply.code(503).send({ ok: false, error: 'faucet_dry', reason: reserveProblem })
    }

    try {
      const result = asset === 'fil' ? await drip.dripFil(recipient) : await drip.dripUsdfc(recipient)
      if (authedKey) {
        apiKeys.recordDrip(authedKey.key, asset, now, authedKey.windowSec)
      } else {
        store.recordDrip(ip, target, asset, now, cfg.IP_RATE_LIMIT_SEC)
      }
      stats.recordDrip(
        now,
        target,
        asset,
        result.txHash,
        asset === 'fil'
          ? parseEther(cfg.FIL_DRIP)
          : parseUnits(cfg.USDFC_DRIP, USDFC_DECIMALS),
      )
      app.log.info(
        {
          asset,
          recipient: target,
          ip,
          apiKey: authedKey?.name ?? null,
          txHash: result.txHash,
          verified: result.verified,
        },
        'drip ok',
      )
      return { ok: true, ...result }
    } catch (err) {
      app.log.error({ err, recipient: target, ip, asset }, 'drip failed')
      return reply.code(500).send({ ok: false, error: 'drip_failed', reason: String(err) })
    }
  }

  app.post('/api/drip/fil', async (req, reply) => handleDrip('fil', req, reply))
  app.post('/api/drip/usdfc', async (req, reply) => handleDrip('usdfc', req, reply))

  // ─── Anonymous public-drip endpoints (no auth, no captcha) ────────
  //
  // Designed for public open-source CLIs (e.g. SynapS3) that ship to
  // end users and cannot embed a secret. We compensate by:
  //   - serving a deliberately small amount (PUBLIC_*_DRIP)
  //   - capping per-IP at MAX_PUBLIC_DRIPS_PER_IP per 24h (default 1)
  //   - keeping the same per-address cap (2/24h) so wallet rotation
  //     within a single IP doesn't help
  //
  // We bucket the per-IP counter under an explicit 'public_<asset>'
  // pseudo-asset string so callers of /api/public/drip don't burn the
  // captcha-path IP quota and vice versa.
  const publicDripBody = z.object({
    address: z.string().min(3).max(120),
  })
  const handlePublicDrip = async (
    asset: Asset,
    req: FastifyRequest,
    reply: FastifyReply,
  ) => {
    const ip = req.ip
    const parsed = publicDripBody.safeParse(req.body)
    if (!parsed.success) {
      return reply.code(400).send({ ok: false, error: 'bad_request' })
    }
    const recipient = classifyRecipient(parsed.data.address)
    if (recipient.kind === 'invalid') {
      return reply.code(400).send({
        ok: false,
        error: 'invalid_address',
        reason: recipient.reason,
      })
    }
    if (asset === 'usdfc' && recipient.kind === 'filecoin') {
      return reply.code(400).send({
        ok: false,
        error: 'usdfc_native_unsupported',
        reason:
          'USDFC is an ERC-20. Only 0x and t410f addresses are accepted.',
      })
    }
    const target =
      recipient.kind === 'eth' || recipient.kind === 'delegated'
        ? recipient.address.toLowerCase()
        : recipient.original.toLowerCase()

    const publicBucket = `public_${asset}` as Asset // separate counter family
    const now = Math.floor(Date.now() / 1000)

    const ipWin = store.windowForIp(ip, publicBucket)
    if (
      ipWin &&
      now - ipWin.windowStartUnix <= cfg.IP_RATE_LIMIT_SEC &&
      ipWin.count >= cfg.MAX_PUBLIC_DRIPS_PER_IP
    ) {
      const retryAfterSec = cfg.IP_RATE_LIMIT_SEC - (now - ipWin.windowStartUnix)
      return reply.code(429).send({
        ok: false,
        error: 'public_ip_rate_limited',
        scope: 'public_ip',
        used: ipWin.count,
        max: cfg.MAX_PUBLIC_DRIPS_PER_IP,
        windowSec: cfg.IP_RATE_LIMIT_SEC,
        retryAfterSec,
        retryAtUnix: now + retryAfterSec,
      })
    }

    // Per-address cap still uses the canonical 'fil'/'usdfc' bucket so
    // an address can't get one public drip AND one captcha drip in the
    // same window from the same wallet.
    const addrWin = store.windowForAddress(target, asset)
    if (
      addrWin &&
      now - addrWin.windowStartUnix <= cfg.ADDRESS_RATE_LIMIT_SEC &&
      addrWin.count >= cfg.MAX_DRIPS_PER_ADDRESS
    ) {
      const retryAfterSec =
        cfg.ADDRESS_RATE_LIMIT_SEC - (now - addrWin.windowStartUnix)
      return reply.code(429).send({
        ok: false,
        error: 'address_rate_limited',
        scope: 'address',
        used: addrWin.count,
        max: cfg.MAX_DRIPS_PER_ADDRESS,
        windowSec: cfg.ADDRESS_RATE_LIMIT_SEC,
        retryAfterSec,
        retryAtUnix: now + retryAfterSec,
      })
    }

    const reserveProblem = await drip.checkReserves(asset)
    if (reserveProblem) {
      app.log.warn({ reserveProblem, asset, route: 'public' }, 'faucet dry')
      return reply
        .code(503)
        .send({ ok: false, error: 'faucet_dry', reason: reserveProblem })
    }

    const amountHuman = asset === 'fil' ? cfg.PUBLIC_FIL_DRIP : cfg.PUBLIC_USDFC_DRIP
    try {
      const result =
        asset === 'fil'
          ? await drip.dripFil(recipient, { amountHuman })
          : await drip.dripUsdfc(recipient, { amountHuman })
      // Per-IP counter under the public bucket only (the captcha-path
      // IP quota is untouched). Per-address counter under the canonical
      // asset so wallet rotation can't sidestep the address cap.
      store.recordIpOnly(ip, publicBucket, now, cfg.IP_RATE_LIMIT_SEC)
      store.recordAddressOnly(target, asset, now, cfg.ADDRESS_RATE_LIMIT_SEC)
      stats.recordDrip(
        now,
        target,
        asset,
        result.txHash,
        asset === 'fil'
          ? parseEther(amountHuman)
          : parseUnits(amountHuman, USDFC_DECIMALS),
      )
      app.log.info(
        {
          asset,
          route: 'public',
          recipient: target,
          ip,
          txHash: result.txHash,
          verified: result.verified,
          amount: amountHuman,
        },
        'public drip ok',
      )
      return { ok: true, ...result }
    } catch (err) {
      app.log.error({ err, recipient: target, ip, asset, route: 'public' }, 'public drip failed')
      return reply.code(500).send({ ok: false, error: 'drip_failed', reason: String(err) })
    }
  }
  app.post('/api/public/drip/fil', async (req, reply) =>
    handlePublicDrip('fil', req, reply),
  )
  app.post('/api/public/drip/usdfc', async (req, reply) =>
    handlePublicDrip('usdfc', req, reply),
  )

  // ─── ChainSafe-compatible claim_token_all endpoint ─────────────
  //
  // The ChainSafe Forest Explorer faucet exposes a single GET endpoint
  // that drips BOTH tFIL and USDFC in one call and returns a JSON array
  // of token-claim results. SynapS3 (and likely other Filecoin CLIs)
  // hardcode that exact endpoint shape.
  //
  // We mirror that contract so callers can swap their endpoint URL to
  // Plumbline without rewriting their client. Rate limits match the
  // anonymous /api/public/drip/* path (per-IP + per-address) and the
  // smaller PUBLIC_*_DRIP amounts are used.
  //
  // Request:  GET /api/claim_token_all?address=0x...
  // Response: [
  //   { "faucetInfo": "CalibnetFIL",   "tx_hash": "0x..." },
  //   { "faucetInfo": "CalibnetUSDFC", "tx_hash": "0x..." }
  // ]
  // Per-token errors are reported per-element (so a partial success
  // — e.g. FIL ok, USDFC rate-limited — still returns 200 with an
  // error key on the USDFC element). Full-failure responses use a
  // non-2xx status with the same array shape in the body.
  type ChainSafeClaim = {
    faucetInfo: string
    tx_hash?: string
    error?: { message: string }
  }
  const chainSafeAssetMap = [
    { asset: 'fil' as Asset, label: 'CalibnetFIL' },
    { asset: 'usdfc' as Asset, label: 'CalibnetUSDFC' },
  ]
  app.get('/api/claim_token_all', async (req, reply) => {
    // Keep the connection alive while we do back-to-back on-chain
    // transactions; a full dual-drip can take ~60s wall time.
    reply.raw.setTimeout(120_000)
    reply.header('Connection', 'keep-alive')

    const ip = req.ip
    const addr = String(
      (req.query as { address?: string }).address ?? '',
    ).trim()
    // Optional ?assets=fil,usdfc filter. Default = both. Lets callers
    // skip the slow asset when they only need one (e.g. SynapS3's
    // 'wallet fund-testnet' wanting tFIL only on first run).
    const assetsParam = String(
      (req.query as { assets?: string }).assets ?? 'fil,usdfc',
    ).toLowerCase()
    const wantAssets = new Set(
      assetsParam.split(',').map((s) => s.trim()).filter(Boolean),
    )
    if (!addr) {
      return reply.code(400).send([
        {
          faucetInfo: 'CalibnetFIL',
          error: { message: 'missing address query parameter' },
        },
        {
          faucetInfo: 'CalibnetUSDFC',
          error: { message: 'missing address query parameter' },
        },
      ])
    }
    const recipient = classifyRecipient(addr)
    if (recipient.kind === 'invalid') {
      return reply.code(400).send([
        {
          faucetInfo: 'CalibnetFIL',
          error: { message: `invalid address: ${recipient.reason}` },
        },
        {
          faucetInfo: 'CalibnetUSDFC',
          error: { message: `invalid address: ${recipient.reason}` },
        },
      ])
    }
    const target =
      recipient.kind === 'eth' || recipient.kind === 'delegated'
        ? recipient.address.toLowerCase()
        : recipient.original.toLowerCase()

    const now = Math.floor(Date.now() / 1000)
    const results: ChainSafeClaim[] = []
    let anyOk = false
    let anyFail = false

    const requestedAssets = chainSafeAssetMap.filter((a) =>
      wantAssets.has(a.asset),
    )
    if (requestedAssets.length === 0) {
      return reply.code(400).send([
        {
          faucetInfo: 'CalibnetFIL',
          error: {
            message: `unknown assets in ?assets=${assetsParam}; valid values are 'fil' and 'usdfc'`,
          },
        },
      ])
    }
    for (const { asset, label } of requestedAssets) {
      // USDFC requires an 0x or t410f recipient.
      if (asset === 'usdfc' && recipient.kind === 'filecoin') {
        results.push({
          faucetInfo: label,
          error: {
            message:
              'USDFC is an ERC-20; native t1/t3 addresses are not supported',
          },
        })
        anyFail = true
        continue
      }
      const publicBucket = `public_${asset}` as Asset
      const ipWin = store.windowForIp(ip, publicBucket)
      if (
        ipWin &&
        now - ipWin.windowStartUnix <= cfg.IP_RATE_LIMIT_SEC &&
        ipWin.count >= cfg.MAX_PUBLIC_DRIPS_PER_IP
      ) {
        const retryAfterSec =
          cfg.IP_RATE_LIMIT_SEC - (now - ipWin.windowStartUnix)
        results.push({
          faucetInfo: label,
          error: {
            message: `per-IP rate limit reached, retry after ${retryAfterSec}s`,
          },
        })
        anyFail = true
        continue
      }
      const addrWin = store.windowForAddress(target, asset)
      if (
        addrWin &&
        now - addrWin.windowStartUnix <= cfg.ADDRESS_RATE_LIMIT_SEC &&
        addrWin.count >= cfg.MAX_DRIPS_PER_ADDRESS
      ) {
        const retryAfterSec =
          cfg.ADDRESS_RATE_LIMIT_SEC - (now - addrWin.windowStartUnix)
        results.push({
          faucetInfo: label,
          error: {
            message: `per-address rate limit reached, retry after ${retryAfterSec}s`,
          },
        })
        anyFail = true
        continue
      }
      const reserveProblem = await drip.checkReserves(asset)
      if (reserveProblem) {
        app.log.warn(
          { reserveProblem, asset, route: 'claim_token_all' },
          'faucet dry',
        )
        results.push({
          faucetInfo: label,
          error: { message: `faucet dry: ${reserveProblem}` },
        })
        anyFail = true
        continue
      }
      const amountHuman =
        asset === 'fil' ? cfg.PUBLIC_FIL_DRIP : cfg.PUBLIC_USDFC_DRIP
      try {
        const result =
          asset === 'fil'
            ? await drip.dripFil(recipient, { amountHuman })
            : await drip.dripUsdfc(recipient, { amountHuman })
        store.recordIpOnly(ip, publicBucket, now, cfg.IP_RATE_LIMIT_SEC)
        store.recordAddressOnly(
          target,
          asset,
          now,
          cfg.ADDRESS_RATE_LIMIT_SEC,
        )
        stats.recordDrip(
          now,
          target,
          asset,
          result.txHash,
          asset === 'fil'
            ? parseEther(amountHuman)
            : parseUnits(amountHuman, USDFC_DECIMALS),
        )
        app.log.info(
          {
            asset,
            route: 'claim_token_all',
            recipient: target,
            ip,
            txHash: result.txHash,
            verified: result.verified,
            amount: amountHuman,
          },
          'public drip ok',
        )
        results.push({ faucetInfo: label, tx_hash: result.txHash })
        anyOk = true
      } catch (err) {
        app.log.error(
          { err, asset, route: 'claim_token_all', recipient: target, ip },
          'public drip failed',
        )
        results.push({
          faucetInfo: label,
          error: { message: `drip failed: ${String(err)}` },
        })
        anyFail = true
      }
    }

    // ChainSafe's status convention: 200 if anything succeeded, 4xx if
    // both failed for client-fixable reasons (we use 429 since the most
    // common cause is rate-limit), 5xx only on server-side failure.
    if (!anyOk && anyFail) {
      reply.code(429)
    }
    return results
  })

  if (!cfg.TURNSTILE_SECRET) {
    app.log.warn(
      'TURNSTILE_SECRET not set — captcha is disabled. Do NOT use this in production.',
    )
  }
  app.log.info(
    { dispenser: drip.dispenserAddress, filDrip: cfg.FIL_DRIP, usdfcDrip: cfg.USDFC_DRIP },
    'faucet starting',
  )

  await app.listen({ host: cfg.HOST, port: cfg.PORT })
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err)
  process.exit(1)
})

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

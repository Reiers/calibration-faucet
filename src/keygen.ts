// SPDX-License-Identifier: MIT
//
// Plumbline operator CLI for managing API keys.
//
// Usage:
//   pnpm run keygen -- create --name "Lee CLI test runner" \
//     [--max-drips 50] [--window-sec 86400] [--notes "lee@example.com"]
//
//   pnpm run keygen -- list
//   pnpm run keygen -- revoke <key>
//   pnpm run keygen -- enable <key>
//
// The store lives in the same SQLite file as the rate-limit store
// (RATE_LIMIT_DB env var, default ./rate-limits.sqlite).

import { randomBytes } from 'node:crypto'
import Database from 'better-sqlite3'
import { ApiKeyStore } from './api-key-store.js'
import { loadConfig } from './config.js'

function generateKey(): string {
  // 32 random bytes → 64 hex chars. Plenty of entropy, easy to
  // copy/paste, no padding issues.
  return 'pk_' + randomBytes(32).toString('hex')
}

function fmtKey(k: string): string {
  // Show first 12 and last 4 to avoid pasting full secrets into logs.
  if (k.length <= 16) return k
  return `${k.slice(0, 12)}…${k.slice(-4)}`
}

function help(): never {
  process.stderr.write(`Plumbline keygen

  create --name "Label" [--max-drips N] [--window-sec N] [--notes "..."]
  list
  revoke <key>
  enable <key>
  show <key>

  Environment:
    RATE_LIMIT_DB   Path to the SQLite store (default: ./rate-limits.sqlite)
`)
  process.exit(2)
}

function parseArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>()
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[i + 1]
    if (next === undefined || next.startsWith('--')) {
      out.set(key, 'true')
    } else {
      out.set(key, next)
      i++
    }
  }
  return out
}

function main() {
  const [, , cmd, ...rest] = process.argv
  if (!cmd) help()
  const cfg = loadConfig()
  const db = new Database(cfg.RATE_LIMIT_DB)
  db.pragma('journal_mode = WAL')
  const store = new ApiKeyStore(db)

  switch (cmd) {
    case 'create': {
      const args = parseArgs(rest)
      const name = args.get('name')
      if (!name) {
        process.stderr.write('error: --name is required\n')
        process.exit(1)
      }
      const maxDrips = Number(args.get('max-drips') ?? '50')
      const windowSec = Number(args.get('window-sec') ?? '86400')
      const notes = args.get('notes') ?? null

      if (!Number.isFinite(maxDrips) || maxDrips < 1) {
        process.stderr.write('error: --max-drips must be a positive integer\n')
        process.exit(1)
      }
      if (!Number.isFinite(windowSec) || windowSec < 1) {
        process.stderr.write('error: --window-sec must be a positive integer\n')
        process.exit(1)
      }

      const key = generateKey()
      store.create({
        key,
        name,
        maxDripsPerWindow: maxDrips,
        windowSec,
        notes,
      })
      process.stdout.write(
        `${key}\n\n  name        ${name}\n  max-drips   ${maxDrips} per ${windowSec}s\n  notes       ${notes ?? '-'}\n\nGive this value to the caller. They send it as:\n  Authorization: Bearer ${key}\nor\n  X-API-Key: ${key}\n`,
      )
      break
    }

    case 'list': {
      const keys = store.list()
      if (keys.length === 0) {
        process.stdout.write('(no api keys)\n')
        break
      }
      process.stdout.write(
        ['key', 'name', 'enabled', 'max/win', 'created', 'notes']
          .join('\t') + '\n',
      )
      for (const k of keys) {
        process.stdout.write(
          [
            fmtKey(k.key),
            k.name,
            k.enabled ? 'yes' : 'no',
            `${k.maxDripsPerWindow}/${k.windowSec}s`,
            new Date(k.createdUnix * 1000).toISOString(),
            k.notes ?? '-',
          ].join('\t') + '\n',
        )
      }
      break
    }

    case 'revoke': {
      const key = rest[0]
      if (!key) {
        process.stderr.write('error: revoke needs a key\n')
        process.exit(1)
      }
      const found = store.get(key)
      if (!found) {
        process.stderr.write(`error: no key matches ${fmtKey(key)}\n`)
        process.exit(1)
      }
      store.setEnabled(key, false)
      process.stdout.write(`revoked ${fmtKey(key)} (${found.name})\n`)
      break
    }

    case 'enable': {
      const key = rest[0]
      if (!key) {
        process.stderr.write('error: enable needs a key\n')
        process.exit(1)
      }
      const found = store.get(key)
      if (!found) {
        process.stderr.write(`error: no key matches ${fmtKey(key)}\n`)
        process.exit(1)
      }
      store.setEnabled(key, true)
      process.stdout.write(`enabled ${fmtKey(key)} (${found.name})\n`)
      break
    }

    case 'show': {
      const key = rest[0]
      if (!key) {
        process.stderr.write('error: show needs a key\n')
        process.exit(1)
      }
      const found = store.get(key)
      if (!found) {
        process.stderr.write(`error: no key matches ${fmtKey(key)}\n`)
        process.exit(1)
      }
      process.stdout.write(
        `${JSON.stringify(
          {
            key: fmtKey(found.key),
            name: found.name,
            enabled: found.enabled,
            maxDripsPerWindow: found.maxDripsPerWindow,
            windowSec: found.windowSec,
            createdAt: new Date(found.createdUnix * 1000).toISOString(),
            notes: found.notes,
            fil: store.windowFor(found.key, 'fil'),
            usdfc: store.windowFor(found.key, 'usdfc'),
          },
          null,
          2,
        )}\n`,
      )
      break
    }

    default:
      help()
  }

  db.close()
}

main()

// SPDX-License-Identifier: MIT
//
// Persistent API-key store backed by SQLite. Keys are opaque random
// strings issued out-of-band by the operator (see `pnpm run keygen`).
// Callers present the key as `X-API-Key: <key>` or
// `Authorization: Bearer <key>` on POST /api/drip/fil and POST
// /api/drip/usdfc to:
//
//   - bypass Cloudflare Turnstile (intended for CLI / CI / automated
//     test integration where there is no browser to solve a captcha)
//   - apply a per-key rate-limit window distinct from the global
//     per-IP and per-address windows
//
// Per-address limits still apply when an API key is used; callers
// cannot drain the faucet to a single address by rotating keys. The
// per-key window is in addition to (not instead of) the per-address
// window.
//
// Schema:
//   api_keys
//     key                  TEXT PRIMARY KEY     -- the opaque key value
//     name                 TEXT NOT NULL        -- human label
//     enabled              INTEGER NOT NULL     -- 1 = active, 0 = revoked
//     created_unix         INTEGER NOT NULL
//     max_drips_per_window INTEGER NOT NULL     -- e.g. 50
//     window_sec           INTEGER NOT NULL     -- e.g. 86400
//     notes                TEXT                 -- free-form (issuer contact, expected use)
//
//   api_key_drips
//     key                  TEXT NOT NULL
//     asset                TEXT NOT NULL        -- 'fil' | 'usdfc'
//     window_start_unix    INTEGER NOT NULL
//     count                INTEGER NOT NULL
//     PRIMARY KEY (key, asset)
//
// Each (key, asset) window opens with the first drip and stays open
// until `window_sec` have elapsed since `window_start_unix`. The
// schema mirrors `address_drips` / `ip_drips` for consistency.

import type Database from 'better-sqlite3'
import type { Asset } from './stats-store.js'

export interface ApiKey {
  key: string
  name: string
  enabled: boolean
  createdUnix: number
  maxDripsPerWindow: number
  windowSec: number
  notes: string | null
}

export interface ApiKeyWindow {
  windowStartUnix: number
  count: number
}

export class ApiKeyStore {
  private db: Database.Database

  constructor(db: Database.Database) {
    this.db = db
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS api_keys (
        key                  TEXT PRIMARY KEY,
        name                 TEXT NOT NULL,
        enabled              INTEGER NOT NULL DEFAULT 1,
        created_unix         INTEGER NOT NULL,
        max_drips_per_window INTEGER NOT NULL,
        window_sec           INTEGER NOT NULL,
        notes                TEXT
      );
      CREATE TABLE IF NOT EXISTS api_key_drips (
        key                  TEXT NOT NULL,
        asset                TEXT NOT NULL,
        window_start_unix    INTEGER NOT NULL,
        count                INTEGER NOT NULL,
        PRIMARY KEY (key, asset)
      );
    `)
  }

  get(key: string): ApiKey | null {
    const row = this.db
      .prepare(
        `SELECT key, name, enabled, created_unix, max_drips_per_window,
                window_sec, notes
         FROM api_keys WHERE key = ?`,
      )
      .get(key) as
      | {
          key: string
          name: string
          enabled: number
          created_unix: number
          max_drips_per_window: number
          window_sec: number
          notes: string | null
        }
      | undefined
    if (!row) return null
    return {
      key: row.key,
      name: row.name,
      enabled: row.enabled === 1,
      createdUnix: row.created_unix,
      maxDripsPerWindow: row.max_drips_per_window,
      windowSec: row.window_sec,
      notes: row.notes,
    }
  }

  list(): ApiKey[] {
    const rows = this.db
      .prepare(
        `SELECT key, name, enabled, created_unix, max_drips_per_window,
                window_sec, notes
         FROM api_keys ORDER BY created_unix ASC`,
      )
      .all() as Array<{
      key: string
      name: string
      enabled: number
      created_unix: number
      max_drips_per_window: number
      window_sec: number
      notes: string | null
    }>
    return rows.map((row) => ({
      key: row.key,
      name: row.name,
      enabled: row.enabled === 1,
      createdUnix: row.created_unix,
      maxDripsPerWindow: row.max_drips_per_window,
      windowSec: row.window_sec,
      notes: row.notes,
    }))
  }

  create(input: {
    key: string
    name: string
    maxDripsPerWindow: number
    windowSec: number
    notes?: string | null
  }): void {
    this.db
      .prepare(
        `INSERT INTO api_keys
         (key, name, enabled, created_unix, max_drips_per_window, window_sec, notes)
         VALUES (?, ?, 1, ?, ?, ?, ?)`,
      )
      .run(
        input.key,
        input.name,
        Math.floor(Date.now() / 1000),
        input.maxDripsPerWindow,
        input.windowSec,
        input.notes ?? null,
      )
  }

  setEnabled(key: string, enabled: boolean): void {
    this.db
      .prepare(`UPDATE api_keys SET enabled = ? WHERE key = ?`)
      .run(enabled ? 1 : 0, key)
  }

  windowFor(key: string, asset: Asset): ApiKeyWindow | null {
    const row = this.db
      .prepare(
        `SELECT window_start_unix, count FROM api_key_drips
         WHERE key = ? AND asset = ?`,
      )
      .get(key, asset) as
      | { window_start_unix: number; count: number }
      | undefined
    if (!row) return null
    return {
      windowStartUnix: row.window_start_unix,
      count: row.count,
    }
  }

  recordDrip(key: string, asset: Asset, now: number, windowSec: number): void {
    const existing = this.windowFor(key, asset)
    if (existing && now - existing.windowStartUnix <= windowSec) {
      this.db
        .prepare(
          `UPDATE api_key_drips
           SET count = count + 1
           WHERE key = ? AND asset = ?`,
        )
        .run(key, asset)
    } else {
      this.db
        .prepare(
          `INSERT INTO api_key_drips (key, asset, window_start_unix, count)
           VALUES (?, ?, ?, 1)
           ON CONFLICT(key, asset) DO UPDATE SET
             window_start_unix = excluded.window_start_unix,
             count = 1`,
        )
        .run(key, asset, now)
    }
  }
}

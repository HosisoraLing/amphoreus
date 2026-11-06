/** SQLite connection and nested transactions shared by Amphoreus stores. */
import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** Opens the existing database without migrating or deleting unrelated tables. Domain stores own their schemas. */
export class Store {
  readonly db: DatabaseSync
  private depth = 0
  constructor(path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
    this.db = new DatabaseSync(path)
    try {
      chmodSync(path, 0o600)
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000')
    } catch (error) { this.db.close(); throw error }
  }
  close(): void { this.db.close() }
  /** A failed inner transaction rolls back only its own changes. */
  atomic<T>(operation: () => T): T {
    const name = `amphoreus_atomic_${this.depth++}`
    this.db.exec(`SAVEPOINT ${name}`)
    try { const value = operation(); this.db.exec(`RELEASE ${name}`); return value }
    catch (error) { this.db.exec(`ROLLBACK TO ${name}`); this.db.exec(`RELEASE ${name}`); throw error }
    finally { this.depth-- }
  }
}

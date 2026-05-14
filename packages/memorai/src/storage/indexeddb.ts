/* eslint-disable unicorn/prefer-add-event-listener --
   IndexedDB uses the `onerror`/`onsuccess` pattern as its standard API.
   `addEventListener` on IDBRequest is supported but unconventional.
*/
import type { MemoryNode, QueryOpts, StorageAdapter } from '../types.js'

/**
 * Browser IndexedDB storage adapter.
 * Stores MemoryNodes as JSON in an object store named 'memories'.
 * Uses a single DB with object store keyed by node.id.
 *
 * IndexedDB operations are wrapped in Promises for async/await ergonomics.
 */
export class IndexedDBAdapter implements StorageAdapter {
  private db: IDBDatabase | null = null
  private readonly dbName: string
  private readonly storeName = 'memories'
  private readonly version = 1

  constructor(opts: { dbName?: string } = {}) {
    this.dbName = opts.dbName ?? 'memorai'
  }

  private getDb(): Promise<IDBDatabase> {
    if (this.db) return Promise.resolve(this.db)

    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version)

      request.onerror = () =>
        reject(request.error ?? new Error('IndexedDB open failed'))
      request.onsuccess = () => {
        this.db = request.result
        resolve(request.result)
      }

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result
        if (!db.objectStoreNames.contains(this.storeName)) {
          const store = db.createObjectStore(this.storeName, { keyPath: 'id' })
          // Indexes for efficient queries
          store.createIndex('timestamp', 'timestamp', { unique: false })
          store.createIndex('salience', 'payload.salienceScore', {
            unique: false,
          })
          store.createIndex('level', 'hierarchy.level', { unique: false })
          store.createIndex('parentId', 'hierarchy.parentId', {
            unique: false,
          })
          store.createIndex('agentRole', 'meta.agentRole', { unique: false })
        }
      }
    })
  }

  private async withStore(
    mode: IDBTransactionMode,
    fn: (store: IDBObjectStore) => IDBRequest,
  ): Promise<unknown> {
    const db = await this.getDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, mode)
      const store = tx.objectStore(this.storeName)
      const req = fn(store)
      req.onerror = () =>
        reject(req.error ?? new Error('IndexedDB operation failed'))
      req.onsuccess = () => resolve(req.result)
    })
  }

  async put(node: MemoryNode): Promise<void> {
    await this.withStore('readwrite', (store) => store.put(node))
  }

  async get(id: string): Promise<MemoryNode | null> {
    const result = await this.withStore('readonly', (store) => store.get(id))
    return (result as MemoryNode | undefined) ?? null
  }

  async delete(id: string): Promise<void> {
    await this.withStore('readwrite', (store) => store.delete(id))
  }

  async batchPut(nodes: MemoryNode[]): Promise<void> {
    const db = await this.getDb()
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readwrite')
      const store = tx.objectStore(this.storeName)
      for (const node of nodes) {
        store.put(node)
      }
      tx.oncomplete = () => resolve()
      tx.onerror = () =>
        reject(tx.error ?? new Error('IndexedDB batch put failed'))
    })
  }

  async queryByTimeRange(
    start: number,
    end: number,
    opts?: QueryOpts,
  ): Promise<MemoryNode[]> {
    const db = await this.getDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly')
      const store = tx.objectStore(this.storeName)
      const index = store.index('timestamp')
      const range = IDBKeyRange.bound(start, end)
      const request = index.openCursor(range)

      const results: MemoryNode[] = []
      request.onsuccess = () => {
        const cursor = request.result
        if (cursor) {
          results.push(cursor.value as MemoryNode)
          cursor.continue()
        } else {
          resolve(this.applyOpts(results, opts))
        }
      }
      request.onerror = () =>
        reject(request.error ?? new Error('IndexedDB time range query failed'))
    })
  }

  async queryByTags(tags: string[], opts?: QueryOpts): Promise<MemoryNode[]> {
    // IndexedDB doesn't support array-contains natively; scan all
    const all = await this.listAll()
    const tagSet = new Set(tags.map((t) => t.toLowerCase()))
    const filtered = all.filter((n) =>
      n.payload.tags.some((t) => tagSet.has(t.toLowerCase())),
    )
    return this.applyOpts(filtered, opts)
  }

  async queryBySalience(
    minScore: number,
    opts?: QueryOpts,
  ): Promise<MemoryNode[]> {
    const db = await this.getDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly')
      const store = tx.objectStore(this.storeName)
      const index = store.index('salience')
      const range = IDBKeyRange.lowerBound(minScore)
      const request = index.openCursor(range)

      const results: MemoryNode[] = []
      request.onsuccess = () => {
        const cursor = request.result
        if (cursor) {
          results.push(cursor.value as MemoryNode)
          cursor.continue()
        } else {
          resolve(this.applyOpts(results, opts))
        }
      }
      request.onerror = () =>
        reject(request.error ?? new Error('IndexedDB salience query failed'))
    })
  }

  async getChildren(parentId: string): Promise<MemoryNode[]> {
    const db = await this.getDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly')
      const store = tx.objectStore(this.storeName)
      const index = store.index('parentId')
      const request = index.openCursor(parentId)

      const results: MemoryNode[] = []
      request.onsuccess = () => {
        const cursor = request.result
        if (cursor) {
          results.push(cursor.value as MemoryNode)
          cursor.continue()
        } else {
          resolve(results)
        }
      }
      request.onerror = () =>
        reject(request.error ?? new Error('IndexedDB getChildren failed'))
    })
  }

  async getParent(childId: string): Promise<MemoryNode | null> {
    const child = await this.get(childId)
    if (!child?.hierarchy.parentId) return null
    return this.get(child.hierarchy.parentId)
  }

  async listAll(opts?: QueryOpts): Promise<MemoryNode[]> {
    const db = await this.getDb()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(this.storeName, 'readonly')
      const store = tx.objectStore(this.storeName)
      const request = store.openCursor()

      const results: MemoryNode[] = []
      request.onsuccess = () => {
        const cursor = request.result
        if (cursor) {
          results.push(cursor.value as MemoryNode)
          cursor.continue()
        } else {
          resolve(this.applyOpts(results, opts))
        }
      }
      request.onerror = () =>
        reject(request.error ?? new Error('IndexedDB listAll failed'))
    })
  }

  close(): Promise<void> {
    if (this.db) {
      this.db.close()
      this.db = null
    }
    return Promise.resolve()
  }

  // ─── Helpers ───

  private applyOpts(nodes: MemoryNode[], opts?: QueryOpts): MemoryNode[] {
    let results = nodes

    if (opts?.level) {
      results = results.filter((n) => n.hierarchy.level === opts.level)
    }

    if (opts?.orderBy) {
      const dir = opts.order === 'asc' ? 1 : -1
      results.sort((a, b) => {
        const key = opts.orderBy!
        let av: number
        let bv: number
        if (key === 'timestamp') {
          av = a.timestamp
          bv = b.timestamp
        } else if (key === 'salience') {
          av = a.payload.salienceScore
          bv = b.payload.salienceScore
        } else {
          av = a.meta.lastAccessed ?? 0
          bv = b.meta.lastAccessed ?? 0
        }
        return (av - bv) * dir
      })
    }

    if (opts?.offset !== undefined || opts?.limit !== undefined) {
      const offset = opts.offset ?? 0
      const limit = opts.limit ?? results.length
      results = results.slice(offset, offset + limit)
    }

    return results
  }
}

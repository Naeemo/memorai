import type { MemoryNode, QueryOpts, StorageAdapter } from "../types.js";
import { BM25Index } from "../bm25.js";
import { composeIndexableText } from "../extraction/shared.js";

/**
 * Minimal interface that any SQLite library must satisfy.
 *
 * Compatible with:
 *   - better-sqlite3 (Node.js)
 *   - bun:sqlite (Bun)
 *   - @db/sqlite (Deno)
 */
export interface SQLiteDatabase {
  prepare: (sql: string) => SQLiteStatement;
  close: () => void;
}

export interface SQLiteStatement {
  run: (params?: Record<string, unknown> | unknown[]) => { changes: number };
  get: (params?: Record<string, unknown> | unknown[]) => Record<string, unknown> | null;
  all: (params?: Record<string, unknown> | unknown[]) => Record<string, unknown>[];
}

/**
 * SQLite storage adapter.
 *
 * Works with any SQLite library that satisfies the `SQLiteDatabase`
 * interface.  MemoryNode fields are stored as a JSON blob; only indexed
 * scalar fields have dedicated columns.
 *
 * Schema:
 *   memories(id, json, timestamp, salience, level, parentId, agentRole,
 *            userId, actor, target)
 *   tags(nodeId, tag)
 */
export class SQLiteAdapter implements StorageAdapter {
  private readonly insertStmt: SQLiteStatement;
  private readonly deleteStmt: SQLiteStatement;
  private readonly getStmt: SQLiteStatement;
  private readonly listAllStmt: SQLiteStatement;
  private readonly byTimeRangeStmt: SQLiteStatement;
  private readonly byTagsStmt: SQLiteStatement;
  private readonly bySalienceStmt: SQLiteStatement;
  private readonly byUserIdStmt: SQLiteStatement;
  private readonly byActorStmt: SQLiteStatement;
  private readonly byTargetStmt: SQLiteStatement;
  private readonly childrenStmt: SQLiteStatement;
  private readonly parentStmt: SQLiteStatement;
  // In-memory BM25 index mirrors persisted nodes; rebuilt on construction.
  private bm25 = new BM25Index();

  constructor(private readonly db: SQLiteDatabase) {
    this.initSchema();
    this.insertStmt = db.prepare(
      `INSERT INTO memories (id, json, timestamp, salience, level, parentId, agentRole, userId, actor, target)
       VALUES (:id, :json, :timestamp, :salience, :level, :parentId, :agentRole, :userId, :actor, :target)
       ON CONFLICT(id) DO UPDATE SET
         json=excluded.json, timestamp=excluded.timestamp,
         salience=excluded.salience, level=excluded.level,
         parentId=excluded.parentId, agentRole=excluded.agentRole,
         userId=excluded.userId, actor=excluded.actor, target=excluded.target`,
    );
    this.deleteStmt = db.prepare(`DELETE FROM memories WHERE id=?`);
    this.getStmt = db.prepare(`SELECT json FROM memories WHERE id=?`);
    this.listAllStmt = db.prepare(`SELECT json FROM memories ORDER BY timestamp DESC`);
    this.byTimeRangeStmt = db.prepare(
      `SELECT json FROM memories WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp DESC`,
    );
    this.byTagsStmt = db.prepare(
      `SELECT m.json FROM memories m
       INNER JOIN tags t ON m.id = t.nodeId
       WHERE t.tag IN (SELECT value FROM json_each(?))
       GROUP BY m.id HAVING COUNT(DISTINCT t.tag) >= ?`,
    );
    this.bySalienceStmt = db.prepare(
      `SELECT json FROM memories WHERE salience >= ? ORDER BY salience DESC, timestamp DESC`,
    );
    this.byUserIdStmt = db.prepare(
      `SELECT json FROM memories WHERE userId = ? ORDER BY timestamp DESC`,
    );
    this.byActorStmt = db.prepare(
      `SELECT json FROM memories WHERE actor = ? ORDER BY timestamp DESC`,
    );
    this.byTargetStmt = db.prepare(
      `SELECT json FROM memories WHERE target = ? ORDER BY timestamp DESC`,
    );
    this.childrenStmt = db.prepare(
      `SELECT json FROM memories WHERE parentId = ? ORDER BY timestamp DESC`,
    );
    this.parentStmt = db.prepare(
      `SELECT json FROM memories WHERE id = (SELECT parentId FROM memories WHERE id = ?)`,
    );

    // Rebuild in-memory BM25 from any pre-existing rows on construction.
    const all = this.listAllStmt.all() as Array<{ json: string }>;
    for (const row of all) {
      const node = this.parse(row.json);
      this.bm25.put(node.id, this.indexableText(node));
    }
  }

  private initSchema(): void {
    this.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      json TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      salience REAL NOT NULL,
      level TEXT NOT NULL,
      parentId TEXT,
      agentRole TEXT,
      userId TEXT,
      actor TEXT,
      target TEXT
    )`,
      )
      .run();

    // Idempotent column adds for in-place upgrades from older schemas.
    for (const col of ["userId", "actor", "target"]) {
      try {
        this.db.prepare(`ALTER TABLE memories ADD COLUMN ${col} TEXT`).run();
      } catch {
        // Column already exists — ignore.
      }
    }

    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_timestamp ON memories(timestamp)`).run();
    this.db
      .prepare(`CREATE INDEX IF NOT EXISTS idx_salience ON memories(salience DESC, timestamp DESC)`)
      .run();
    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_level ON memories(level)`).run();
    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_parent ON memories(parentId)`).run();
    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_agent ON memories(agentRole)`).run();
    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_user ON memories(userId)`).run();
    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_actor ON memories(actor)`).run();
    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_target ON memories(target)`).run();

    this.db
      .prepare(
        `CREATE TABLE IF NOT EXISTS tags (
      nodeId TEXT NOT NULL,
      tag TEXT NOT NULL,
      PRIMARY KEY (nodeId, tag),
      FOREIGN KEY (nodeId) REFERENCES memories(id) ON DELETE CASCADE
    )`,
      )
      .run();

    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_tag ON tags(tag)`).run();
  }

  put(node: MemoryNode): Promise<void> {
    const json = JSON.stringify(node);
    this.insertStmt.run({
      id: node.id,
      json,
      timestamp: node.timestamp,
      salience: node.annotations.salienceScore,
      level: node.level,
      parentId: node.parentId ?? null,
      agentRole: node.meta.agentRole,
      userId: node.userId ?? null,
      actor: node.actor ?? null,
      target: node.target ?? null,
    });
    this.syncTags(node);
    this.bm25.put(node.id, this.indexableText(node));
    return Promise.resolve();
  }

  get(id: string): Promise<MemoryNode | null> {
    const row = this.getStmt.get([id]);
    return Promise.resolve(row ? this.parse(row.json as string) : null);
  }

  delete(id: string): Promise<void> {
    this.deleteStmt.run([id]);
    this.bm25.remove(id);
    return Promise.resolve();
  }

  async batchPut(nodes: MemoryNode[]): Promise<void> {
    for (const node of nodes) {
      await this.put(node);
    }
  }

  queryByTimeRange(start: number, end: number, opts?: QueryOpts): Promise<MemoryNode[]> {
    const rows = this.byTimeRangeStmt.all([start, end]) as Array<{ json: string }>;
    return Promise.resolve(
      this.applyOpts(
        rows.map((r) => this.parse(r.json)),
        opts,
      ),
    );
  }

  queryByTags(tags: string[], opts?: QueryOpts): Promise<MemoryNode[]> {
    const jsonTags = JSON.stringify(tags);
    const rows = this.byTagsStmt.all([jsonTags, tags.length]) as Array<{ json: string }>;
    return Promise.resolve(
      this.applyOpts(
        rows.map((r) => this.parse(r.json)),
        opts,
      ),
    );
  }

  queryBySalience(minScore: number, opts?: QueryOpts): Promise<MemoryNode[]> {
    const rows = this.bySalienceStmt.all([minScore]) as Array<{ json: string }>;
    return Promise.resolve(
      this.applyOpts(
        rows.map((r) => this.parse(r.json)),
        opts,
      ),
    );
  }

  queryByUserId(userId: string, opts?: QueryOpts): Promise<MemoryNode[]> {
    const rows = this.byUserIdStmt.all([userId]) as Array<{ json: string }>;
    return Promise.resolve(
      this.applyOpts(
        rows.map((r) => this.parse(r.json)),
        opts,
      ),
    );
  }

  queryByActor(actor: string, opts?: QueryOpts): Promise<MemoryNode[]> {
    const rows = this.byActorStmt.all([actor]) as Array<{ json: string }>;
    return Promise.resolve(
      this.applyOpts(
        rows.map((r) => this.parse(r.json)),
        opts,
      ),
    );
  }

  queryByTarget(target: string, opts?: QueryOpts): Promise<MemoryNode[]> {
    const rows = this.byTargetStmt.all([target]) as Array<{ json: string }>;
    return Promise.resolve(
      this.applyOpts(
        rows.map((r) => this.parse(r.json)),
        opts,
      ),
    );
  }

  async queryByText(text: string, opts?: QueryOpts & { limit?: number }): Promise<MemoryNode[]> {
    const limit = opts?.limit ?? 50;
    const hits = this.bm25.search(text, Math.max(limit, 50));
    const nodes: MemoryNode[] = [];
    for (const h of hits) {
      const n = await this.get(h.docId);
      if (n) nodes.push(n);
    }
    return this.applyOpts(nodes, opts);
  }

  getChildren(parentId: string): Promise<MemoryNode[]> {
    const rows = this.childrenStmt.all([parentId]) as Array<{ json: string }>;
    return Promise.resolve(rows.map((r) => this.parse(r.json)));
  }

  getParent(childId: string): Promise<MemoryNode | null> {
    const row = this.parentStmt.get([childId]) as { json: string } | null;
    return Promise.resolve(row ? this.parse(row.json) : null);
  }

  listAll(opts?: QueryOpts): Promise<MemoryNode[]> {
    const rows = this.listAllStmt.all() as Array<{ json: string }>;
    return Promise.resolve(
      this.applyOpts(
        rows.map((r) => this.parse(r.json)),
        opts,
      ),
    );
  }

  close(): Promise<void> {
    this.db.close();
    this.bm25.clear();
    return Promise.resolve();
  }

  // ─── Helpers ───

  private syncTags(node: MemoryNode): void {
    const deleteTags = this.db.prepare(`DELETE FROM tags WHERE nodeId = ?`);
    deleteTags.run([node.id]);
    const insertTag = this.db.prepare(`INSERT OR IGNORE INTO tags (nodeId, tag) VALUES (?, ?)`);
    for (const tag of node.annotations.tags) {
      insertTag.run([node.id, tag]);
    }
  }

  private indexableText(node: MemoryNode): string {
    return composeIndexableText(node.raw, node.annotations);
  }

  private parse(json: string): MemoryNode {
    return JSON.parse(json) as MemoryNode;
  }

  private applyOpts(nodes: MemoryNode[], opts?: QueryOpts): MemoryNode[] {
    let results = nodes;

    if (opts?.level) {
      results = results.filter((n) => n.level === opts.level);
    }

    if (opts?.orderBy) {
      const dir = opts.order === "asc" ? 1 : -1;
      results.sort((a, b) => {
        const key = opts.orderBy!;
        let av: number;
        let bv: number;
        if (key === "timestamp") {
          av = a.timestamp;
          bv = b.timestamp;
        } else if (key === "salience") {
          av = a.annotations.salienceScore;
          bv = b.annotations.salienceScore;
        } else {
          av = a.meta.lastAccessed ?? 0;
          bv = b.meta.lastAccessed ?? 0;
        }
        return (av - bv) * dir;
      });
    }

    if (opts?.offset !== undefined || opts?.limit !== undefined) {
      const offset = opts.offset ?? 0;
      const limit = opts.limit ?? results.length;
      results = results.slice(offset, offset + limit);
    }

    return results;
  }
}

import { generateId } from "../utils.js";
import {
  canonicalName,
  edgePassesFilter,
  type EdgeFilter,
  type EntityGraph,
  type GraphEdge,
  type GraphEntity,
  type GraphPath,
  type UpsertEdgeInput,
} from "./types.js";
import type { SQLiteDatabase, SQLiteStatement } from "../storage/sqlite.js";

/**
 * SQLite-backed `EntityGraph` for Node.js / server environments.
 *
 * Persists entities and edges to two tables with indexes on the query
 * axes (subject, object, predicate, userId). Path search uses BFS in
 * application code over edge rows pulled from the DB.
 *
 * Compatible with any library satisfying the `SQLiteDatabase` interface
 * (better-sqlite3, bun:sqlite, @db/sqlite).
 */
export class SQLiteEntityGraph implements EntityGraph {
  private readonly insertEntityStmt: SQLiteStatement;
  private readonly getEntityStmt: SQLiteStatement;
  private readonly listEntitiesStmt: SQLiteStatement;
  private readonly insertEdgeStmt: SQLiteStatement;
  private readonly getEdgeStmt: SQLiteStatement;
  private readonly deleteEdgeStmt: SQLiteStatement;
  private readonly invalidateEdgesStmt: SQLiteStatement;
  private readonly neighborsSubjectStmt: SQLiteStatement;
  private readonly neighborsObjectStmt: SQLiteStatement;
  private readonly queryEdgesStmt: SQLiteStatement;
  private readonly countStmt: SQLiteStatement;

  constructor(private readonly db: SQLiteDatabase) {
    this.initSchema();
    this.insertEntityStmt = db.prepare(
      `INSERT INTO graph_entities (name, attributes, firstSeenAt, lastSeenAt, userId)
       VALUES (:name, :attributes, :firstSeenAt, :lastSeenAt, :userId)
       ON CONFLICT(name) DO UPDATE SET
         attributes = CASE WHEN excluded.attributes IS NOT NULL
           THEN json_patch(graph_entities.attributes, excluded.attributes)
           ELSE graph_entities.attributes END,
         lastSeenAt = excluded.lastSeenAt,
         userId = COALESCE(graph_entities.userId, excluded.userId)`,
    );
    this.getEntityStmt = db.prepare(
      `SELECT name, attributes, firstSeenAt, lastSeenAt, userId
       FROM graph_entities WHERE name = ?`,
    );
    this.listEntitiesStmt = db.prepare(
      `SELECT name, attributes, firstSeenAt, lastSeenAt, userId
       FROM graph_entities
       WHERE (?1 IS NULL OR userId = ?1)
       ORDER BY lastSeenAt DESC
       LIMIT ?2 OFFSET ?3`,
    );
    this.insertEdgeStmt = db.prepare(
      `INSERT INTO graph_edges
       (id, subject, predicate, object, validAt, invalidatedAt, confidence, sourceNodeId, sourceEventId, userId)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.getEdgeStmt = db.prepare(
      `SELECT id, subject, predicate, object, validAt, invalidatedAt, confidence, sourceNodeId, sourceEventId, userId
       FROM graph_edges WHERE id = ?`,
    );
    this.deleteEdgeStmt = db.prepare(`DELETE FROM graph_edges WHERE id = ?`);
    this.invalidateEdgesStmt = db.prepare(
      `UPDATE graph_edges SET invalidatedAt = ?4
       WHERE subject = ?1 AND predicate = ?2
         AND (?3 IS NULL OR userId = ?3)
         AND invalidatedAt IS NULL`,
    );
    this.neighborsSubjectStmt = db.prepare(
      `SELECT id FROM graph_edges WHERE subject = ?1 AND (?2 IS NULL OR userId = ?2)`,
    );
    this.neighborsObjectStmt = db.prepare(
      `SELECT id FROM graph_edges WHERE object = ?1 AND (?2 IS NULL OR userId = ?2)`,
    );
    this.queryEdgesStmt = db.prepare(
      `SELECT id, subject, predicate, object, validAt, invalidatedAt, confidence, sourceNodeId, sourceEventId, userId
       FROM graph_edges
       WHERE (?1 IS NULL OR subject = ?1)
         AND (?2 IS NULL OR predicate = ?2)
         AND (?3 IS NULL OR object = ?3)
         AND (?4 IS NULL OR userId = ?4)
       ORDER BY validAt DESC`,
    );
    this.countStmt = db.prepare(
      `SELECT (SELECT COUNT(*) FROM graph_entities) AS entities, (SELECT COUNT(*) FROM graph_edges) AS edges`,
    );
  }

  private initSchema(): void {
    this.db.prepare(`CREATE TABLE IF NOT EXISTS graph_entities (
      name TEXT PRIMARY KEY,
      attributes TEXT,
      firstSeenAt INTEGER NOT NULL,
      lastSeenAt INTEGER NOT NULL,
      userId TEXT
    )`).run();
    this.db.prepare(`CREATE TABLE IF NOT EXISTS graph_edges (
      id TEXT PRIMARY KEY,
      subject TEXT NOT NULL,
      predicate TEXT NOT NULL,
      object TEXT NOT NULL,
      validAt INTEGER NOT NULL,
      invalidatedAt INTEGER,
      confidence REAL,
      sourceNodeId TEXT,
      sourceEventId TEXT,
      userId TEXT
    )`).run();
    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_edges_subject ON graph_edges(subject)`).run();
    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_edges_object ON graph_edges(object)`).run();
    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_edges_predicate ON graph_edges(predicate)`).run();
    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_edges_userId ON graph_edges(userId)`).run();
    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_edges_subject_predicate ON graph_edges(subject, predicate)`).run();
    this.db.prepare(`CREATE INDEX IF NOT EXISTS idx_entities_userId ON graph_entities(userId)`).run();
  }

  // ─── Entities ───

  async upsertEntity(
    name: string,
    attributes?: Record<string, unknown>,
    opts: { now?: number; userId?: string } = {},
  ): Promise<GraphEntity> {
    const canonical = canonicalName(name);
    if (!canonical) throw new Error("SQLiteEntityGraph.upsertEntity: name cannot be empty");
    const now = opts.now ?? Date.now();
    this.insertEntityStmt.run({
      name: canonical,
      attributes: attributes ? JSON.stringify(attributes) : null,
      firstSeenAt: now,
      lastSeenAt: now,
      userId: opts.userId ?? null,
    });
    return (await this.getEntity(canonical))!;
  }

  async getEntity(name: string, opts: { userId?: string } = {}): Promise<GraphEntity | null> {
    const row = this.getEntityStmt.get([canonicalName(name)]) as unknown as RawEntityRow | null;
    if (!row) return null;
    const e = rowToEntity(row);
    if (opts.userId !== undefined && e.userId !== opts.userId) return null;
    return e;
  }

  async listEntities(
    opts: { userId?: string; limit?: number; offset?: number } = {},
  ): Promise<GraphEntity[]> {
    const rows = this.listEntitiesStmt.all([
      opts.userId ?? null,
      opts.limit ?? 1000,
      opts.offset ?? 0,
    ]) as unknown as RawEntityRow[];
    return rows.map(rowToEntity);
  }

  // ─── Edges ───

  async upsertEdge(input: UpsertEdgeInput): Promise<GraphEdge> {
    const subject = canonicalName(input.subject);
    const predicate = canonicalName(input.predicate);
    const object = canonicalName(input.object);
    if (!subject || !predicate || !object) {
      throw new Error("SQLiteEntityGraph.upsertEdge: subject/predicate/object cannot be empty");
    }
    const validAt = input.validAt ?? Date.now();

    await this.upsertEntity(subject, undefined, { now: validAt, userId: input.userId });
    await this.upsertEntity(object, undefined, { now: validAt, userId: input.userId });

    if (input.invalidatesOlder) {
      this.invalidateEdgesStmt.run([subject, predicate, input.userId ?? null, validAt]);
    }

    const edge: GraphEdge = {
      id: generateId(),
      subject,
      predicate,
      object,
      validAt,
      invalidatedAt: input.invalidatedAt,
      confidence: input.confidence,
      sourceNodeId: input.sourceNodeId,
      sourceEventId: input.sourceEventId,
      userId: input.userId,
    };
    this.insertEdgeStmt.run([
      edge.id,
      edge.subject,
      edge.predicate,
      edge.object,
      edge.validAt,
      edge.invalidatedAt ?? null,
      edge.confidence ?? null,
      edge.sourceNodeId ?? null,
      edge.sourceEventId ?? null,
      edge.userId ?? null,
    ]);
    return edge;
  }

  async upsertEdges(inputs: UpsertEdgeInput[]): Promise<GraphEdge[]> {
    const out: GraphEdge[] = [];
    for (const i of inputs) out.push(await this.upsertEdge(i));
    return out;
  }

  async getEdge(id: string): Promise<GraphEdge | null> {
    const row = this.getEdgeStmt.get([id]) as unknown as RawEdgeRow | null;
    return row ? rowToEdge(row) : null;
  }

  async deleteEdge(id: string): Promise<void> {
    this.deleteEdgeStmt.run([id]);
  }

  // ─── Queries ───

  async queryNeighbors(
    entity: string,
    opts: EdgeFilter & { limit?: number } = {},
  ): Promise<GraphEdge[]> {
    const canonical = canonicalName(entity);
    const ids = new Set<string>();
    const subjRows = this.neighborsSubjectStmt.all([canonical, opts.userId ?? null]) as Array<{
      id: string;
    }>;
    for (const r of subjRows) ids.add(r.id);
    const objRows = this.neighborsObjectStmt.all([canonical, opts.userId ?? null]) as Array<{
      id: string;
    }>;
    for (const r of objRows) ids.add(r.id);

    const out: GraphEdge[] = [];
    for (const id of ids) {
      const edge = await this.getEdge(id);
      if (!edge) continue;
      if (!edgePassesFilter(edge, opts)) continue;
      out.push(edge);
    }
    out.sort((a, b) => b.validAt - a.validAt);
    return opts.limit !== undefined ? out.slice(0, opts.limit) : out;
  }

  async queryEdges(filter: EdgeFilter, opts: { limit?: number } = {}): Promise<GraphEdge[]> {
    const rows = this.queryEdgesStmt.all([
      filter.subject ? canonicalName(filter.subject) : null,
      filter.predicate ? canonicalName(filter.predicate) : null,
      filter.object ? canonicalName(filter.object) : null,
      filter.userId ?? null,
    ]) as unknown as RawEdgeRow[];
    const out: GraphEdge[] = [];
    for (const row of rows) {
      const edge = rowToEdge(row);
      if (!edgePassesFilter(edge, filter)) continue;
      out.push(edge);
    }
    if (opts.limit !== undefined) return out.slice(0, opts.limit);
    return out;
  }

  async queryPaths(
    from: string,
    to: string,
    opts: { maxDepth?: number; limit?: number; userId?: string } = {},
  ): Promise<GraphPath[]> {
    const start = canonicalName(from);
    const goal = canonicalName(to);
    if (!start || !goal || start === goal) return [];
    const maxDepth = opts.maxDepth ?? 4;
    const limit = opts.limit ?? 5;

    const paths: GraphPath[] = [];
    type Frontier = { node: string; edges: GraphEdge[]; entities: string[] };
    const queue: Frontier[] = [{ node: start, edges: [], entities: [start] }];

    while (queue.length > 0 && paths.length < limit) {
      const cur = queue.shift()!;
      if (cur.entities.length - 1 >= maxDepth) continue;

      const neighborEdges = await this.queryNeighbors(cur.node, {
        userId: opts.userId,
        excludeInvalidated: true,
      });

      for (const e of neighborEdges) {
        const other = e.subject === cur.node ? e.object : e.subject;
        if (cur.entities.includes(other) && other !== goal) continue;
        const nextEntities = [...cur.entities, other];
        const nextEdges = [...cur.edges, e];
        if (other === goal) {
          paths.push({ edges: nextEdges, entities: nextEntities });
          if (paths.length >= limit) break;
          continue;
        }
        if (nextEntities.length - 1 < maxDepth) {
          queue.push({ node: other, edges: nextEdges, entities: nextEntities });
        }
      }
    }

    paths.sort((a, b) => a.edges.length - b.edges.length);
    return paths.slice(0, limit);
  }

  async queryPathsWeighted(
    from: string,
    to: string,
    opts: { maxDepth?: number; limit?: number; userId?: string } = {},
  ): Promise<GraphPath[]> {
    const start = canonicalName(from);
    const goal = canonicalName(to);
    if (!start || !goal || start === goal) return [];
    const maxDepth = opts.maxDepth ?? 4;
    const limit = opts.limit ?? 5;

    type ScoredFrontier = {
      node: string;
      edges: GraphEdge[];
      entities: string[];
      score: number;
    };

    const heap: ScoredFrontier[] = [{ node: start, edges: [], entities: [start], score: 1 }];
    const paths: GraphPath[] = [];

    while (heap.length > 0 && paths.length < limit) {
      let bestIdx = 0;
      for (let i = 1; i < heap.length; i++) {
        if (heap[i].score > heap[bestIdx].score) bestIdx = i;
      }
      const cur = heap.splice(bestIdx, 1)[0];
      if (cur.entities.length - 1 >= maxDepth) continue;

      const neighborEdges = await this.queryNeighbors(cur.node, {
        userId: opts.userId,
        excludeInvalidated: true,
      });

      for (const e of neighborEdges) {
        const other = e.subject === cur.node ? e.object : e.subject;
        if (cur.entities.includes(other) && other !== goal) continue;
        const edgeConfidence = e.confidence ?? 0.5;
        const nextScore = cur.score * edgeConfidence;
        const nextEdges = [...cur.edges, e];
        const nextEntities = [...cur.entities, other];
        if (other === goal) {
          paths.push({ edges: nextEdges, entities: nextEntities });
          if (paths.length >= limit) break;
          continue;
        }
        if (nextEntities.length - 1 < maxDepth) {
          heap.push({ node: other, edges: nextEdges, entities: nextEntities, score: nextScore });
        }
      }
    }

    paths.sort((a, b) => {
      const scoreA = Math.pow(pathScore(a), 1 / a.edges.length);
      const scoreB = Math.pow(pathScore(b), 1 / b.edges.length);
      return scoreB - scoreA;
    });
    return paths.slice(0, limit);
  }

  async size(): Promise<{ entities: number; edges: number }> {
    const row = this.countStmt.get() as { entities: number; edges: number } | null;
    return row ?? { entities: 0, edges: 0 };
  }

  async clear(): Promise<void> {
    this.db.prepare(`DELETE FROM graph_edges`).run();
    this.db.prepare(`DELETE FROM graph_entities`).run();
  }
}

// ─── helpers ───

interface RawEntityRow {
  name: string;
  attributes: string | null;
  firstSeenAt: number;
  lastSeenAt: number;
  userId: string | null;
}

interface RawEdgeRow {
  id: string;
  subject: string;
  predicate: string;
  object: string;
  validAt: number;
  invalidatedAt: number | null;
  confidence: number | null;
  sourceNodeId: string | null;
  sourceEventId: string | null;
  userId: string | null;
}

function rowToEntity(row: RawEntityRow): GraphEntity {
  return {
    name: row.name,
    attributes: row.attributes ? JSON.parse(row.attributes) : undefined,
    firstSeenAt: row.firstSeenAt,
    lastSeenAt: row.lastSeenAt,
    userId: row.userId ?? undefined,
  };
}

function rowToEdge(row: RawEdgeRow): GraphEdge {
  return {
    id: row.id,
    subject: row.subject,
    predicate: row.predicate,
    object: row.object,
    validAt: row.validAt,
    invalidatedAt: row.invalidatedAt ?? undefined,
    confidence: row.confidence ?? undefined,
    sourceNodeId: row.sourceNodeId ?? undefined,
    sourceEventId: row.sourceEventId ?? undefined,
    userId: row.userId ?? undefined,
  };
}

function pathScore(path: GraphPath): number {
  let score = 1;
  for (const e of path.edges) {
    score *= e.confidence ?? 0.5;
  }
  return score;
}

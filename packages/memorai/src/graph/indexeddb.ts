/* eslint-disable unicorn/prefer-add-event-listener */
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

/**
 * IndexedDB-backed `EntityGraph` for browser environments.
 *
 * Uses two object stores:
 *   - `entities` keyed by canonical name
 *   - `edges` keyed by generated id, with indexes on subject, object,
 *     predicate, and userId for fast lookups.
 *
 * Query semantics (neighbor scan, BFS path search, best-first weighted
 * paths) mirror `InMemoryEntityGraph` exactly.
 */
export class IndexedDBEntityGraph implements EntityGraph {
  private db: IDBDatabase | null = null;
  private readonly dbName: string;
  private readonly version = 1;

  constructor(opts: { dbName?: string } = {}) {
    this.dbName = opts.dbName ?? "memorai-graph";
  }

  private getDb(): Promise<IDBDatabase> {
    if (this.db) return Promise.resolve(this.db);
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(this.dbName, this.version);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
      request.onsuccess = () => {
        this.db = request.result;
        resolve(request.result);
      };
      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains("entities")) {
          db.createObjectStore("entities", { keyPath: "name" });
        }
        if (!db.objectStoreNames.contains("edges")) {
          const edgeStore = db.createObjectStore("edges", { keyPath: "id" });
          edgeStore.createIndex("subject", "subject", { unique: false });
          edgeStore.createIndex("object", "object", { unique: false });
          edgeStore.createIndex("predicate", "predicate", { unique: false });
          edgeStore.createIndex("userId", "userId", { unique: false });
        }
      };
    });
  }

  private promisifyRequest<T>(req: IDBRequest<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error("IDB request failed"));
    });
  }

  // ─── Entities ───

  async upsertEntity(
    name: string,
    attributes?: Record<string, unknown>,
    opts: { now?: number; userId?: string } = {},
  ): Promise<GraphEntity> {
    const canonical = canonicalName(name);
    if (!canonical) throw new Error("IndexedDBEntityGraph.upsertEntity: name cannot be empty");
    const now = opts.now ?? Date.now();

    const db = await this.getDb();
    const tx = db.transaction(["entities"], "readwrite");
    const store = tx.objectStore("entities");
    const existing = await this.promisifyRequest(store.get(canonical));

    let entity: GraphEntity;
    if (existing) {
      const e = existing as GraphEntity;
      e.lastSeenAt = now;
      if (attributes) {
        e.attributes = { ...e.attributes, ...attributes };
      }
      if (opts.userId !== undefined && e.userId === undefined) {
        e.userId = opts.userId;
      }
      await this.promisifyRequest(store.put(e));
      entity = e;
    } else {
      entity = {
        name: canonical,
        attributes,
        firstSeenAt: now,
        lastSeenAt: now,
        userId: opts.userId,
      };
      await this.promisifyRequest(store.add(entity));
    }
    return entity;
  }

  async getEntity(name: string, opts: { userId?: string } = {}): Promise<GraphEntity | null> {
    const db = await this.getDb();
    const tx = db.transaction(["entities"], "readonly");
    const result = await this.promisifyRequest(tx.objectStore("entities").get(canonicalName(name)));
    if (!result) return null;
    const e = result as GraphEntity;
    if (opts.userId !== undefined && e.userId !== opts.userId) return null;
    return e;
  }

  async listEntities(
    opts: { userId?: string; limit?: number; offset?: number } = {},
  ): Promise<GraphEntity[]> {
    const db = await this.getDb();
    const tx = db.transaction(["entities"], "readonly");
    const store = tx.objectStore("entities");
    const request = store.openCursor();
    const out: GraphEntity[] = [];
    return new Promise((resolve, reject) => {
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          out.sort((a, b) => b.lastSeenAt - a.lastSeenAt);
          const offset = opts.offset ?? 0;
          const limit = opts.limit ?? out.length;
          resolve(out.slice(offset, offset + limit));
          return;
        }
        const e = cursor.value as GraphEntity;
        if (opts.userId === undefined || e.userId === opts.userId) {
          out.push(e);
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error ?? new Error("listEntities failed"));
    });
  }

  // ─── Edges ───

  async upsertEdge(input: UpsertEdgeInput): Promise<GraphEdge> {
    const subject = canonicalName(input.subject);
    const predicate = canonicalName(input.predicate);
    const object = canonicalName(input.object);
    if (!subject || !predicate || !object) {
      throw new Error("IndexedDBEntityGraph.upsertEdge: subject/predicate/object cannot be empty");
    }
    const validAt = input.validAt ?? Date.now();

    await this.upsertEntity(subject, undefined, { now: validAt, userId: input.userId });
    await this.upsertEntity(object, undefined, { now: validAt, userId: input.userId });

    if (input.invalidatesOlder) {
      await this.invalidateOlder(subject, predicate, input.userId, validAt);
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

    const db = await this.getDb();
    const tx = db.transaction(["edges"], "readwrite");
    await this.promisifyRequest(tx.objectStore("edges").put(edge));
    return edge;
  }

  private async invalidateOlder(
    subject: string,
    predicate: string,
    userId: string | undefined,
    validAt: number,
  ): Promise<void> {
    const db = await this.getDb();
    const tx = db.transaction(["edges"], "readwrite");
    const index = tx.objectStore("edges").index("subject");
    const request = index.openCursor(IDBKeyRange.only(subject));
    return new Promise((resolve, reject) => {
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve();
          return;
        }
        const e = cursor.value as GraphEdge;
        if (
          e.predicate === predicate &&
          e.invalidatedAt === undefined &&
          (userId === undefined ? e.userId === undefined : e.userId === userId)
        ) {
          e.invalidatedAt = validAt;
          cursor.update(e);
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error ?? new Error("invalidateOlder failed"));
    });
  }

  async upsertEdges(inputs: UpsertEdgeInput[]): Promise<GraphEdge[]> {
    const out: GraphEdge[] = [];
    for (const i of inputs) out.push(await this.upsertEdge(i));
    return out;
  }

  async getEdge(id: string): Promise<GraphEdge | null> {
    const db = await this.getDb();
    const tx = db.transaction(["edges"], "readonly");
    const result = await this.promisifyRequest(tx.objectStore("edges").get(id));
    return result ? (result as GraphEdge) : null;
  }

  async deleteEdge(id: string): Promise<void> {
    const db = await this.getDb();
    const tx = db.transaction(["edges"], "readwrite");
    await this.promisifyRequest(tx.objectStore("edges").delete(id));
  }

  // ─── Queries ───

  async queryNeighbors(
    entity: string,
    opts: EdgeFilter & { limit?: number } = {},
  ): Promise<GraphEdge[]> {
    const canonical = canonicalName(entity);
    const [subjectEdges, objectEdges] = await Promise.all([
      this.getEdgesByIndex("subject", canonical),
      this.getEdgesByIndex("object", canonical),
    ]);
    const seen = new Set<string>();
    const out: GraphEdge[] = [];
    for (const e of [...subjectEdges, ...objectEdges]) {
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      if (!edgePassesFilter(e, opts)) continue;
      out.push(e);
    }
    out.sort((a, b) => b.validAt - a.validAt);
    return opts.limit !== undefined ? out.slice(0, opts.limit) : out;
  }

  private async getEdgesByIndex(indexName: string, value: string): Promise<GraphEdge[]> {
    const db = await this.getDb();
    const tx = db.transaction(["edges"], "readonly");
    const index = tx.objectStore("edges").index(indexName);
    const request = index.openCursor(IDBKeyRange.only(value));
    const out: GraphEdge[] = [];
    return new Promise((resolve, reject) => {
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          resolve(out);
          return;
        }
        out.push(cursor.value as GraphEdge);
        cursor.continue();
      };
      request.onerror = () => reject(request.error ?? new Error("getEdgesByIndex failed"));
    });
  }

  async queryEdges(filter: EdgeFilter, opts: { limit?: number } = {}): Promise<GraphEdge[]> {
    const db = await this.getDb();
    const tx = db.transaction(["edges"], "readonly");
    const request = tx.objectStore("edges").openCursor();
    const out: GraphEdge[] = [];
    return new Promise((resolve, reject) => {
      request.onsuccess = () => {
        const cursor = request.result;
        if (!cursor) {
          out.sort((a, b) => b.validAt - a.validAt);
          resolve(opts.limit !== undefined ? out.slice(0, opts.limit) : out);
          return;
        }
        const edge = cursor.value as GraphEdge;
        if (edgePassesFilter(edge, filter)) {
          out.push(edge);
        }
        cursor.continue();
      };
      request.onerror = () => reject(request.error ?? new Error("queryEdges failed"));
    });
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
    const db = await this.getDb();
    const entityTx = db.transaction(["entities"], "readonly");
    const edgeTx = db.transaction(["edges"], "readonly");
    const [entityCount, edgeCount] = await Promise.all([
      this.promisifyRequest(entityTx.objectStore("entities").count()),
      this.promisifyRequest(edgeTx.objectStore("edges").count()),
    ]);
    return { entities: entityCount, edges: edgeCount };
  }

  async clear(): Promise<void> {
    const db = await this.getDb();
    await this.promisifyRequest(db.transaction(["edges"], "readwrite").objectStore("edges").clear());
    await this.promisifyRequest(
      db.transaction(["entities"], "readwrite").objectStore("entities").clear(),
    );
  }
}

function pathScore(path: GraphPath): number {
  let score = 1;
  for (const e of path.edges) {
    score *= e.confidence ?? 0.5;
  }
  return score;
}

/**
 * Example: Node.js Server with Memorai
 *
 * A simple HTTP server that exposes a memory API.
 * Multiple agents can read/write to the same SQLite-backed memory store.
 */

import { createServer } from 'node:http'
import process from 'node:process'
import Database from 'better-sqlite3'
import { Memorai, OllamaEmbeddingService, SQLiteAdapter } from 'memorai'

// ─── 1. Initialize shared memory ───

const db = new Database('./server-memory.db')
const storage = new SQLiteAdapter(db)
const embedding = new OllamaEmbeddingService({
  baseURL: 'http://localhost:11434',
  model: 'nomic-embed-text',
})

const memory = new Memorai({
  storage,
  embedding,
  evolution: {
    autoEvolveIntervalMs: 5 * 60 * 1000, // evolve every 5 minutes
  },
})

// ─── 2. HTTP API ───

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
  const send = (status: number, data: unknown) => {
    res.writeHead(status, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(data))
  }

  try {
    // POST /write — store a memory
    if (req.method === 'POST' && url.pathname === '/write') {
      const body = await readBody(req)
      const node = await memory.write({
        payload: {
          summary: body.summary,
          description: body.description,
          tags: body.tags ?? [],
          salienceScore: body.salience ?? 0.5,
          modality: body.modality ?? ['text'],
        },
        meta: { agentRole: body.agentRole ?? 'default' },
      })
      return send(200, { id: node.id })
    }

    // GET /retrieve — search memories
    if (req.method === 'GET' && url.pathname === '/retrieve') {
      const query = url.searchParams.get('q') ?? ''
      const strategy = (url.searchParams.get('strategy') ?? 'factual') as
        | 'factual'
        | 'temporal'
      const topK = Number(url.searchParams.get('topK') ?? 5)
      const result = await memory.retrieve({
        strategy,
        text: query,
        topK,
      })
      return send(200, result)
    }

    // GET /today — summarize today's activity
    if (req.method === 'GET' && url.pathname === '/today') {
      const today = new Date()
      today.setHours(0, 0, 0, 0)
      const result = await memory.retrieve({
        strategy: 'temporal',
        timeRange: { start: today.getTime(), end: Date.now() },
        traversalOrder: 'forward',
        topK: 50,
      })
      return send(200, {
        count: result.nodes.length,
        events: result.nodes.map((n) => ({
          time: new Date(n.timestamp).toISOString(),
          summary: n.payload.summary,
          level: n.hierarchy.level,
        })),
      })
    }

    // POST /evolve — trigger manual evolution
    if (req.method === 'POST' && url.pathname === '/evolve') {
      await memory.evolve()
      return send(200, { evolved: true })
    }

    return send(404, { error: 'Not found' })
  } catch (error) {
    send(500, { error: String(error) })
  }
})

// ─── Helpers ───

function readBody(
  req: import('node:http').IncomingMessage,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => {
      try {
        resolve(JSON.parse(data))
      } catch {
        reject(new Error('Invalid JSON'))
      }
    })
  })
}

// ─── Start ───

server.listen(3000, () => {
  console.log('Memory server running at http://localhost:3000')
  console.log('Endpoints:')
  console.log('  POST /write     — store a memory')
  console.log('  GET  /retrieve?q=... — search memories')
  console.log("  GET  /today     — today's timeline")
  console.log('  POST /evolve    — trigger HME')
})

// Graceful shutdown
process.on('SIGINT', async () => {
  await memory.close()
  server.close()
  process.exit(0)
})

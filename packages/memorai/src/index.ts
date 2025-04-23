interface MemoryPiece {
  content: string
  id: string
  time: Date
}

export class Memory {
  private readonly pieces = new Map<string, MemoryPiece>()
  private readonly vectorMap = new Map<string, number[]>()

  constructor(
    public readonly user: string,
    public readonly agent: string,
    private readonly completer: (prompt: string) => Promise<string>,
    private readonly embedder: (input: string) => Promise<number[]>,
  ) {
    console.info('Memory init', user, agent)
  }

  public async add(
    message: string,
    time: Date = new Date(),
  ): Promise<MemoryPiece[]> {
    const facts = await this.digest(message)
    const newPieces: MemoryPiece[] = []
    for (const fact of facts) {
      const id = crypto.randomUUID()
      const embeddings = await this.embedder(fact)
      this.vectorMap.set(id, embeddings)
      this.pieces.set(id, {
        id,
        time,
        content: fact,
      })
      newPieces.push({
        id,
        time,
        content: fact,
      })
    }
    return newPieces
  }

  public async search(query: string): Promise<MemoryPiece[]> {
    console.info('Memory.search()', query)
    const queryEmbeddings = await this.embedder(query)
    const queryMagnitude = Math.sqrt(
      queryEmbeddings.reduce((acc, val) => acc + val * val, 0),
    )
    // loop through all pieces, calculate vector relevance
    const scores = Array.from(this.vectorMap.entries()).map(([id, vector]) => {
      const dotProduct = vector.reduce(
        (acc, val, i) => acc + val * queryEmbeddings[i],
        0,
      )
      const magnitude = Math.sqrt(
        vector.reduce((acc, val) => acc + val * val, 0),
      )
      const score = dotProduct / (magnitude * queryMagnitude || 1) // Avoid division by zero
      return {
        id,
        score,
      }
    })
    // sort by score
    scores.sort((a, b) => b.score - a.score)
    // get top 5
    const maxScore = Math.max(...scores.map((s) => s.score))
    const dynamicThreshold = maxScore * 0.8
    const absoluteThreshold = 0.5
    const threshold = Math.max(dynamicThreshold, absoluteThreshold) // Use the higher of the two
    const filteredScores = scores.filter((s) => s.score >= threshold)
    const topIds = filteredScores.map((score) => score.id)
    const topPieces = topIds.map((id) => this.pieces.get(id)!).filter(Boolean)
    console.info('calculate relativity with query', topPieces, query)
    return topPieces
  }

  public list(pagination?: { page: number; size: number }): MemoryPiece[] {
    console.info('Memory.list()', pagination)
    return Array.from(this.pieces.values())
  }

  public remove(): void {
    console.info('Memory.remove()')
  }

  private async digest(message: string): Promise<string[]> {
    const prompt = `You are a memory assistant and a master psychologist. Your job is to extract concrete facts from the message with pure logic.
    The facts should be in the form of a list, with each fact on a new line. There could be multiple or zero message in the user's message.
    The message is:
    ${message}`
    // Extract facts from the message with a LLM completion call
    const factStr = await this.completer(prompt)
    const facts = factStr.split('\n').filter((part) => part.trim().length > 0)
    console.info('Memory digest() for facts', message, facts)
    return facts
  }
}

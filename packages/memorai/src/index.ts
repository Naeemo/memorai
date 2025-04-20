interface MemoryPiece {
  content: string
  id: string
  time: Date
}

export class Memory {
  private readonly pieces: MemoryPiece[] = []

  constructor(
    public readonly user: string,
    public readonly agent: string,
  ) {
    console.info('Memory init', user, agent)
  }

  public add(message: string, time: Date = new Date()): MemoryPiece[] {
    const facts = this.digest(message)
    const pieces = facts.map((fact) => ({
      time,
      content: fact,
      id: crypto.randomUUID(),
    }))
    this.pieces.push(...pieces)
    return pieces
  }

  public search(query: string): MemoryPiece[] {
    console.info('Memory.search()', query)
    return this.pieces.filter((piece) => {
      // todo relativity computation
      console.info('calculate relativity with query', piece, query)
      return true
    })
  }

  public list(pagination?: { page: number; size: number }): MemoryPiece[] {
    console.info('Memory.list()', pagination)
    return this.pieces
  }

  public remove(): void {
    console.info('Memory.remove()')
  }

  private digest(message: string): string[] {
    // todo
    console.info('Memory digest() for facts', message)
    return []
  }
}

export class Memory {
  public add(): void {
    console.info('add()')
  }

  public update(): void {
    console.info('Memory.update()')
  }

  public remove(): void {
    console.info('Memory.remove()')
  }

  public search(query: string): void {
    console.info('Memory.search()', query)
  }
}

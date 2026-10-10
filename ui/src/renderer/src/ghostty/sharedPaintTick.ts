/** Batches paint requests from many surfaces onto one timer tick, so they all land in
 * the same animation frame and the compositor produces one frame per tick. */
export class SharedPaintTick {
  private readonly due = new Map<object, () => void>()
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly intervalMs: () => number) {}

  schedule(owner: object, paint: () => void): void {
    this.due.set(owner, paint)
    if (this.timer === null) this.timer = setTimeout(() => this.flush(), this.intervalMs())
  }

  cancel(owner: object): void {
    this.due.delete(owner)
  }

  private flush(): void {
    this.timer = null
    const due = [...this.due.values()]
    this.due.clear()
    for (const paint of due) paint()
  }
}

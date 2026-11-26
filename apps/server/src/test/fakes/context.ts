import type { Clock } from '../../kernel/lib/clock.js';

export class FakeClock implements Clock {
  constructor(public t = Date.UTC(2026, 10, 24, 10, 0, 0)) {}
  now(): number {
    return this.t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

/**
 * Structure-of-arrays particle storage.
 *
 * One typed array per attribute rather than one object per particle: the spec's budget is 20 000
 * concurrent particles stepped every frame, and per-particle objects would spend the frame in the
 * allocator. Slots are handed out from a free list so allocation is O(1) and slot indices stay stable
 * for as long as a particle lives.
 */
export class ParticlePool {

  readonly capacity: number;

  readonly position: Float32Array;
  readonly velocity: Float32Array;
  readonly age: Float32Array;
  readonly lifespan: Float32Array;
  readonly seed: Float32Array;
  readonly spin: Float32Array;
  readonly spinSpeed: Float32Array;

  private live: Uint8Array;
  private freeList: Int32Array;
  private freeCount: number;

  constructor(capacity: number) {
    this.capacity = capacity;

    this.position = new Float32Array(capacity * 3);
    this.velocity = new Float32Array(capacity * 3);
    this.age = new Float32Array(capacity);
    this.lifespan = new Float32Array(capacity);
    this.seed = new Float32Array(capacity);
    this.spin = new Float32Array(capacity);
    this.spinSpeed = new Float32Array(capacity);

    this.live = new Uint8Array(capacity);
    this.freeList = new Int32Array(capacity);
    this.freeCount = capacity;

    // Seeded in reverse so the first allocations come back as 0, 1, 2..., which makes both debugging
    // and the tests far easier to read than an arbitrary order.
    for (let index = 0; index < capacity; index++) {
      this.freeList[index] = capacity - 1 - index;
    }
  }

  get liveCount() {
    return this.capacity - this.freeCount;
  }

  allocate(): number {
    if (this.freeCount === 0) {
      return -1;
    }

    const slot = this.freeList[--this.freeCount];
    this.live[slot] = 1;

    return slot;
  }

  free(slot: number) {
    // Guarded because a double free would push the same slot twice and hand it out to two particles.
    if (this.live[slot] !== 1) {
      return;
    }

    this.live[slot] = 0;
    this.freeList[this.freeCount++] = slot;
  }

  forEachLive(visit: (slot: number) => void) {
    for (let slot = 0; slot < this.capacity; slot++) {
      if (this.live[slot] === 1) {
        visit(slot);
      }
    }
  }

  reset() {
    // Only `live` and the free list are cleared. Per-particle attributes (position, velocity,
    // age, lifespan, spin, spinSpeed, ...) are deliberately left holding whatever the previous
    // occupant wrote: `spawnParticle` fully overwrites every one of them on allocation, so a
    // freshly allocated slot never reads stale data. Zeroing 20 000 particles' worth of arrays on
    // every reset would be wasted work for state nothing ever reads before it is overwritten.
    this.live.fill(0);
    this.freeCount = this.capacity;

    for (let index = 0; index < this.capacity; index++) {
      this.freeList[index] = this.capacity - 1 - index;
    }
  }

}

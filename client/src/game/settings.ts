export default {
  world: {
    render: {
      radius: 1
    }
  },
  texture: {
    unloadInterval: 5000
  },
  m2: {
    unloadInterval: 5000
  },
  doodad: {
    // Proportion of pending doodads to load or unload in a given tick.
    loadFactor: 1 / 40,
    // Minimum number of pending doodads to load or unload in a given tick.
    loadMin: 2,
    // Number of milliseconds to wait before loading another portion of doodads.
    loadInterval: 100
  },
  wmo: {
    group: {
      loadInterval: 100,
      unloadInterval: 5000,
      loadFactor: 1 / 10,
      loadMin: 2
    },
    doodad: {
      loadInterval: 100,
      loadFactor: 1 / 20,
      loadMin: 2
    },
    root: {
      unloadInterval: 5000,
    },
    loadInterval: 100,
    loadFactor: 1 / 10,
    loadMin: 2,
    unloadDelay: 30000
  },
}
const DEFAULT_VIEWER_OPTIONS = {
  preserveArcRegions: true,
  arcTessellationQuality: "normal",
};

const ARC_TESSELLATION_QUALITIES = new Set(["low", "normal", "high"]);

function createMemoryStorage() {
  const values = new Map();

  return {
    getItem(key) {
      return values.has(key) ? values.get(key) : null;
    },
    setItem(key, value) {
      values.set(key, String(value));
    },
  };
}

function getDefaultStorage() {
  try {
    return globalThis.localStorage ?? createMemoryStorage();
  } catch {
    return createMemoryStorage();
  }
}

export class ViewerOptionsStore {
  constructor(
    storage = getDefaultStorage(),
    storageKey = "wasm-gerber-viewer.options",
  ) {
    this.storage = storage ?? createMemoryStorage();
    this.storageKey = storageKey;
    this.options = this.load();
  }

  getDefaults() {
    return { ...DEFAULT_VIEWER_OPTIONS };
  }

  load() {
    try {
      const stored = JSON.parse(this.storage.getItem(this.storageKey) || "{}");
      return {
        ...this.getDefaults(),
        preserveArcRegions:
          typeof stored.preserveArcRegions === "boolean"
            ? stored.preserveArcRegions
            : DEFAULT_VIEWER_OPTIONS.preserveArcRegions,
        arcTessellationQuality: ARC_TESSELLATION_QUALITIES.has(
          stored.arcTessellationQuality,
        )
          ? stored.arcTessellationQuality
          : DEFAULT_VIEWER_OPTIONS.arcTessellationQuality,
      };
    } catch {
      return this.getDefaults();
    }
  }

  save() {
    try {
      this.storage.setItem(this.storageKey, JSON.stringify(this.options));
    } catch {
      // Keep the in-memory option state even when browser storage is blocked.
    }
  }

  get(key) {
    return this.options[key];
  }

  set(key, value) {
    this.options = {
      ...this.options,
      [key]: value,
    };
    this.save();
    return this.getAll();
  }

  getAll() {
    return { ...this.options };
  }
}

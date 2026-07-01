const DEFAULT_LAYER_FILTERS = {
  top: [
    "top front -f #TOP",
    ".gtl .gto .gts .gtp .gpt",
    ".cmp .plc .stc .crc",
    ".top .smt .sst .spt .tsm .tsk .plt .pastetop",
    "f.cu f_cu f.mask f_mask f.silks f_silks f.paste f_paste",
    "mt.pho st.pho pt.pho",
  ].join("\n"),
  bottom: [
    "bottom back -b #BOT",
    ".gbl .gbo .gbs .gbp .gpb",
    ".sol .pls .sts .crs",
    ".bot .smb .ssb .spb .bsm .bsk .plb .pastebot",
    "b.cu b_cu b.mask b_mask b.silks b_silks b.paste b_paste",
    "mb.pho sb.pho pb.pho",
  ].join("\n"),
};

const PREVIOUS_LAYER_FILTER_DEFAULTS = {
  top: [
    "top front -f .gtl .gto .gts .gtp .gpt .cmp .plc .stc .crc .top .smt .sst .spt .tsm .tsk .plt .pastetop f.cu f_cu f.mask f_mask f.silks f_silks f.paste f_paste mt.pho st.pho pt.pho #TOP",
    "top -f .gtl .gto .gts .gtp #TOP",
    "top .gtl .gto .gts .gtp #TOP",
  ],
  bottom: [
    "bottom back -b .gbl .gbo .gbs .gbp .gpb .sol .pls .sts .crs .bot .smb .ssb .spb .bsm .bsk .plb .pastebot b.cu b_cu b.mask b_mask b.silks b_silks b.paste b_paste mb.pho sb.pho pb.pho #BOT",
    "bottom -b .gbl .gbo .gbs .gbp #BOT",
    "bottom .gbl .gbo .gbs .gbp #BOT",
  ],
  front: ["front .gtl .gto .gts .gtp #TOP"],
  back: ["back .gbl .gbo .gbs .gbp #BOT"],
};

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

export class LayerFilterStore {
  constructor(
    storage = getDefaultStorage(),
    storageKey = "wasm-gerber-viewer.layerFilters",
  ) {
    this.storage = storage ?? createMemoryStorage();
    this.storageKey = storageKey;
    this.filters = this.load();
  }

  getDefaults() {
    return { ...DEFAULT_LAYER_FILTERS };
  }

  load() {
    try {
      const stored = JSON.parse(this.storage.getItem(this.storageKey) || "{}");
      return {
        top: this.normalizeStoredValue(stored, "top", "front"),
        bottom: this.normalizeStoredValue(stored, "bottom", "back"),
      };
    } catch {
      return this.getDefaults();
    }
  }

  reload() {
    this.filters = this.load();
    return this.getAll();
  }

  save() {
    try {
      this.storage.setItem(this.storageKey, JSON.stringify(this.filters));
    } catch {
      // Keep the in-memory filter state even when browser storage is blocked.
    }
  }

  set(filters) {
    this.filters = {
      top: filters.top,
      bottom: filters.bottom,
    };
  }

  update(kind, value) {
    this.filters[kind] = value;
  }

  get(kind) {
    return this.filters[kind] ?? "";
  }

  getAll() {
    return { ...this.filters };
  }

  getTokens(kind) {
    return this.get(kind)
      .split(/[\s,;|]+/)
      .map((token) => token.trim())
      .filter(Boolean);
  }

  matches(layer, kind) {
    const tokens = this.getTokens(kind);
    if (tokens.length === 0) return false;
    const layerName = layer.name;
    const lowerLayerName = layerName.toLowerCase();

    return tokens.some((token) => {
      if (token.startsWith("#") && token.length > 1) {
        return layerName.includes(token.slice(1));
      }

      return lowerLayerName.includes(token.toLowerCase());
    });
  }

  normalizeStoredValue(stored, key, legacyKey) {
    const currentDefault = DEFAULT_LAYER_FILTERS[key];
    const previousDefaultValues = PREVIOUS_LAYER_FILTER_DEFAULTS[key];
    const legacyDefaultValues = PREVIOUS_LAYER_FILTER_DEFAULTS[legacyKey] ?? [];

    if (typeof stored[key] === "string") {
      return previousDefaultValues.includes(stored[key])
        ? currentDefault
        : stored[key];
    }

    if (typeof stored[legacyKey] === "string") {
      return legacyDefaultValues.includes(stored[legacyKey])
        ? currentDefault
        : stored[legacyKey];
    }

    return currentDefault;
  }
}

function clampColorChannel(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  return Math.min(1, Math.max(0, number));
}

function rgbToHex(rgb) {
  const r = Math.round(rgb[0] * 255)
    .toString(16)
    .padStart(2, "0");
  const g = Math.round(rgb[1] * 255)
    .toString(16)
    .padStart(2, "0");
  const b = Math.round(rgb[2] * 255)
    .toString(16)
    .padStart(2, "0");
  return `#${r}${g}${b}`;
}

function hexToRgb(hexColor) {
  const match = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hexColor);
  if (!match) return null;
  return [
    parseInt(match[1], 16) / 255,
    parseInt(match[2], 16) / 255,
    parseInt(match[3], 16) / 255,
  ];
}

function rgbToRgbaString(rgb, alpha = 1) {
  const r = Math.round(clampColorChannel(rgb[0]) * 255);
  const g = Math.round(clampColorChannel(rgb[1]) * 255);
  const b = Math.round(clampColorChannel(rgb[2]) * 255);
  return `rgba(${r}, ${g}, ${b}, ${clampAlpha(alpha)})`;
}

function clampAlpha(alpha) {
  const value = Number(alpha);
  if (!Number.isFinite(value)) return 1;
  return Math.min(1, Math.max(0, value));
}

function stopLayerControlEvent(event) {
  event.stopPropagation();
}

function updateColorButton(button, rgb, alpha = 1) {
  const r = Math.round(clampColorChannel(rgb[0]) * 255);
  const g = Math.round(clampColorChannel(rgb[1]) * 255);
  const b = Math.round(clampColorChannel(rgb[2]) * 255);
  button.style.setProperty("--layer-color", rgbToHex(rgb));
  button.style.setProperty("--layer-color-rgb", `${r} ${g} ${b}`);
  button.style.setProperty("--layer-alpha", String(clampAlpha(alpha)));
}

function updateColorButtonAlphaOverride(button, hasOverride) {
  button.classList.toggle("has-alpha-override", Boolean(hasOverride));
}

function getColorPickerButtonLabel(layer) {
  return `${layer.name} color`;
}

function getPickrRoot(pickr) {
  return pickr?.getRoot?.() ?? null;
}

function getPickrRootElement(pickr) {
  const root = getPickrRoot(pickr);
  return root?.app ?? root?.root ?? root?.interaction?.app ?? null;
}

function getPickrFocusTarget(pickr) {
  const root = getPickrRoot(pickr);
  return (
    root?.palette?.palette ??
    root?.interaction?.result ??
    root?.hue?.slider ??
    root?.opacity?.slider ??
    root?.interaction?.save ??
    null
  );
}

let colorPickerDialogId = 0;

function configurePickrAccessibility({ button, layer, pickr }) {
  const root = getPickrRootElement(pickr);
  if (!root) return;

  if (!root.id) {
    colorPickerDialogId += 1;
    root.id = `layer-color-picker-dialog-${colorPickerDialogId}`;
  }
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", `${layer.name} color picker`);
  button.setAttribute("aria-label", getColorPickerButtonLabel(layer));
  button.setAttribute("aria-haspopup", "dialog");
  button.setAttribute("aria-controls", root.id);
  button.setAttribute("aria-expanded", "false");
}

function focusPickrDialog(pickr) {
  const root = pickr?.getRoot?.();
  const target = getPickrFocusTarget(pickr);
  if (!target?.focus || !root?.app?.classList.contains("visible")) return;
  target.focus({ preventScroll: true });
}

function destroyContainerPickrs(container) {
  for (const pickr of container._layerPickrs ?? []) {
    try {
      pickr.destroyAndRemove();
    } catch (error) {
      console.warn("[Layer] Failed to destroy color picker:", error);
    }
  }
  container._layerPickrs = [];
}

function attachNativeColorFallback({
  button,
  layer,
  getGlobalAlpha,
  lockOpacity,
  onColorChange,
}) {
  button.title = `${button.title} (basic picker)`;
  button.addEventListener("click", () => {
    const input = document.createElement("input");
    input.type = "color";
    input.value = rgbToHex(layer.color);
    input.style.position = "fixed";
    input.style.left = "-9999px";
    input.style.top = "0";

    const cleanup = () => {
      input.remove();
    };
    input.addEventListener("change", () => {
      const rgb = hexToRgb(input.value);
      if (!rgb) {
        cleanup();
        return;
      }
      const alpha = lockOpacity ? 1 : layer.alpha ?? getGlobalAlpha();
      updateColorButton(button, rgb, alpha);
      onColorChange(layer.id, input.value);
      cleanup();
    });
    input.addEventListener("blur", cleanup, { once: true });

    document.body.appendChild(input);
    input.click();
  });

  return {
    destroyAndRemove() {},
    syncGlobalAlpha() {
      if (lockOpacity || layer.alpha !== null && layer.alpha !== undefined) return;
      updateColorButton(button, layer.color, getGlobalAlpha());
    },
  };
}

function createPickrInstance({
  button,
  layer,
  getGlobalAlpha,
  lockOpacity,
  onColorChange,
}) {
  const PickrConstructor = globalThis.Pickr;
  if (!PickrConstructor?.create) {
    return attachNativeColorFallback({
      button,
      layer,
      getGlobalAlpha,
      lockOpacity,
      onColorChange,
    });
  }

  const getEffectiveAlpha = () =>
    lockOpacity
      ? 1
      : clampAlpha(
          layer.alpha === null || layer.alpha === undefined
            ? getGlobalAlpha()
            : layer.alpha,
        );
  const state = {
    useGlobalAlpha: layer.alpha === null || layer.alpha === undefined,
    lastAlpha: getEffectiveAlpha(),
    checkbox: null,
    root: null,
  };
  const pickr = PickrConstructor.create({
    el: button,
    theme: "monolith",
    useAsButton: true,
    default: rgbToRgbaString(layer.color, getEffectiveAlpha()),
    defaultRepresentation: "RGBA",
    outputPrecision: 3,
    lockOpacity,
    comparison: true,
    padding: 8,
    position: "bottom-start",
    appClass: "layer-color-pickr",
    components: {
      preview: true,
      opacity: !lockOpacity,
      hue: true,
      interaction: {
        rgba: false,
        input: true,
        cancel: false,
        clear: false,
        save: true,
      },
    },
  });
  configurePickrAccessibility({ button, layer, pickr });

  if (!lockOpacity) {
    attachAlphaOverrideControl({
      pickr,
      layer,
      getGlobalAlpha,
      state,
    });
  }

  pickr.on("show", () => {
    state.useGlobalAlpha = layer.alpha === null || layer.alpha === undefined;
    state.lastAlpha = getEffectiveAlpha();
    syncAlphaOverrideControl(state);
    pickr.setColor(rgbToRgbaString(layer.color, getEffectiveAlpha()), true);
    button.setAttribute("aria-expanded", "true");
    requestAnimationFrame(() => focusPickrDialog(pickr));
  });
  pickr.on("hide", () => {
    button.setAttribute("aria-expanded", "false");
  });
  pickr.on("change", (color) => {
    if (lockOpacity || !state.useGlobalAlpha) return;

    const alpha = clampAlpha(color.toRGBA()[3]);
    if (Math.abs(alpha - state.lastAlpha) > 0.0001) {
      state.useGlobalAlpha = false;
      syncAlphaOverrideControl(state);
    }
    state.lastAlpha = alpha;
  });
  pickr.on("save", (color) => {
    if (!color) return;
    const rgba = color.toRGBA();
    const rgb = [rgba[0] / 255, rgba[1] / 255, rgba[2] / 255];
    const alpha = lockOpacity
      ? undefined
      : state.useGlobalAlpha
        ? null
        : clampAlpha(rgba[3]);
    updateColorButton(button, rgb, lockOpacity ? 1 : alpha ?? getGlobalAlpha());
    updateColorButtonAlphaOverride(
      button,
      alpha !== null && alpha !== undefined,
    );
    onColorChange(layer.id, rgb, alpha);
    pickr.hide();
  });

  return {
    destroyAndRemove: () => pickr.destroyAndRemove(),
    syncGlobalAlpha() {
      if (lockOpacity || layer.alpha !== null && layer.alpha !== undefined) return;

      const alpha = getEffectiveAlpha();
      updateColorButton(button, layer.color, alpha);
      if (!pickr.isOpen?.()) return;

      state.lastAlpha = alpha;
      if (!state.useGlobalAlpha) return;

      const rgba = pickr.getColor().toRGBA();
      const rgb = [rgba[0] / 255, rgba[1] / 255, rgba[2] / 255];
      pickr.setColor(rgbToRgbaString(rgb, alpha), true);
    },
  };
}

function attachAlphaOverrideControl({
  pickr,
  layer,
  getGlobalAlpha,
  state,
}) {
  const root = getPickrRootElement(pickr);
  if (!root) return;

  const row = document.createElement("label");
  row.className = "pcr-layer-alpha-override";
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  state.root = root;
  state.checkbox = checkbox;
  const text = document.createElement("span");
  text.textContent = "Use Global Alpha";
  row.append(checkbox, text);
  row.addEventListener("click", stopLayerControlEvent);
  checkbox.addEventListener("change", () => {
    state.useGlobalAlpha = checkbox.checked;
    syncAlphaOverrideControl(state);
    const rgba = pickr.getColor().toRGBA();
    const rgb = [rgba[0] / 255, rgba[1] / 255, rgba[2] / 255];
    const nextAlpha = state.useGlobalAlpha ? getGlobalAlpha() : clampAlpha(rgba[3]);
    state.lastAlpha = nextAlpha;
    pickr.setColor(
      rgbToRgbaString(rgb, nextAlpha),
      true,
    );
  });

  syncAlphaOverrideControl(state);
  root.appendChild(row);
}

function syncAlphaOverrideControl(state) {
  if (state.checkbox) {
    state.checkbox.checked = state.useGlobalAlpha;
  }
  if (state.root) {
    state.root.classList.toggle("pcr-alpha-inherited", state.useGlobalAlpha);
  }
}

function createEmptyLayerItem(onOpenFiles) {
  const item = document.createElement("li");
  item.className = "layer-item layer-empty-item";
  item.style.gridTemplateColumns = "1fr";
  item.setAttribute("role", "button");
  item.setAttribute("aria-label", "Open files");
  item.setAttribute("aria-disabled", "false");
  item.tabIndex = 0;
  item.title = "Open files";
  item.addEventListener("click", onOpenFiles);
  item.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onOpenFiles();
  });

  const label = document.createElement("label");
  label.className = "layer-label";
  const title = document.createElement("strong");
  const detail = document.createElement("span");
  title.textContent = "No layers";
  detail.textContent = "Ready";
  label.append(title, detail);
  item.appendChild(label);
  return item;
}

function createLayerItem({
  layer,
  index,
  formatBounds,
  onDragStart,
  onDragEnd,
  onColorChange,
  onAlphaOverrideChange,
  onVisibilityChange,
  onToggleVisibility,
  onContextMenu,
  getGlobalAlpha,
}) {
  const item = document.createElement("li");
  item.className = "layer-item gerber-layer-item";
  if (layer.inverted) {
    item.classList.add("layer-item-inverted");
  }
  item.dataset.layerId = layer.id;
  item.dataset.layerIndex = String(index);
  item.draggable = true;
  item.addEventListener("dragstart", (event) => onDragStart(event, layer.id));
  item.addEventListener("dragend", onDragEnd);
  item.addEventListener("contextmenu", (event) => {
    openLayerContextMenu(event, layer, onContextMenu);
  });

  const colorPicker = document.createElement("button");
  colorPicker.type = "button";
  colorPicker.className = "layer-color-picker";
  colorPicker.setAttribute("aria-label", getColorPickerButtonLabel(layer));
  colorPicker.title = "Layer color";
  updateColorButton(colorPicker, layer.color, layer.alpha ?? getGlobalAlpha());
  updateColorButtonAlphaOverride(
    colorPicker,
    layer.alpha !== null && layer.alpha !== undefined,
  );
  for (const eventName of ["click", "mousedown", "pointerdown", "touchstart"]) {
    colorPicker.addEventListener(eventName, stopLayerControlEvent);
  }
  colorPicker.addEventListener("dragstart", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "layer-checkbox";
  checkbox.checked = layer.visible;
  checkbox.setAttribute(
    "aria-label",
    `${layer.name} visibility${layer.inverted ? " (inverted)" : ""}`,
  );
  checkbox.addEventListener("change", () => {
    onVisibilityChange(layer, checkbox.checked);
  });

  const label = document.createElement("label");
  label.className = "layer-label";
  const layerName = document.createElement("strong");
  const layerMeta = document.createElement("span");
  layerName.textContent = layer.name;
  layerMeta.textContent = formatBounds(layer);
  label.append(layerName, layerMeta);
  label.addEventListener("click", () => {
    checkbox.checked = !checkbox.checked;
    onToggleVisibility(layer);
  });

  const menuBtn = document.createElement("button");
  menuBtn.type = "button";
  menuBtn.className = "icon-button layer-menu-btn";
  menuBtn.setAttribute("aria-label", "Layer actions");
  menuBtn.title = "Layer actions";
  const menuIcon = document.createElement("i");
  menuIcon.setAttribute("data-lucide", "more-vertical");
  menuBtn.appendChild(menuIcon);
  menuBtn.addEventListener("click", (event) => {
    openLayerMenuFromButton(event, layer, onContextMenu);
  });

  item.append(colorPicker, checkbox, label, menuBtn);
  return {
    item,
    colorPicker,
    layer,
    lockOpacity: false,
  };
}

function createGroupHeader(title) {
  const item = document.createElement("li");
  item.className = "layer-group-heading";
  item.textContent = title;
  return item;
}

function createDrillItem({
  layer,
  formatBounds,
  onColorChange,
  onVisibilityChange,
  onToggleVisibility,
  onContextMenu,
}) {
  const item = document.createElement("li");
  item.className = "layer-item drill-layer-item";
  item.dataset.layerId = layer.id;
  item.addEventListener("contextmenu", (event) => {
    openLayerContextMenu(event, layer, onContextMenu);
  });

  const colorPicker = document.createElement("button");
  colorPicker.type = "button";
  colorPicker.className = "layer-color-picker";
  colorPicker.setAttribute("aria-label", getColorPickerButtonLabel(layer));
  colorPicker.title = "Layer color";
  updateColorButton(colorPicker, layer.color, 1);
  for (const eventName of ["click", "mousedown", "pointerdown", "touchstart"]) {
    colorPicker.addEventListener(eventName, stopLayerControlEvent);
  }
  colorPicker.addEventListener("dragstart", (event) => {
    event.preventDefault();
    event.stopPropagation();
  });

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "layer-checkbox";
  checkbox.checked = layer.visible;
  checkbox.setAttribute("aria-label", `${layer.name} visibility`);
  checkbox.addEventListener("change", () => {
    onVisibilityChange(layer, checkbox.checked);
  });

  const label = document.createElement("label");
  label.className = "layer-label";
  const layerName = document.createElement("strong");
  const layerMeta = document.createElement("span");
  layerName.textContent = layer.name;
  layerMeta.textContent = formatBounds(layer);
  label.append(layerName, layerMeta);
  label.addEventListener("click", () => {
    checkbox.checked = !checkbox.checked;
    onToggleVisibility(layer);
  });

  const menuBtn = document.createElement("button");
  menuBtn.type = "button";
  menuBtn.className = "icon-button layer-menu-btn";
  menuBtn.setAttribute("aria-label", "Layer actions");
  menuBtn.title = "Layer actions";
  const menuIcon = document.createElement("i");
  menuIcon.setAttribute("data-lucide", "more-vertical");
  menuBtn.appendChild(menuIcon);
  menuBtn.addEventListener("click", (event) => {
    openLayerMenuFromButton(event, layer, onContextMenu);
  });

  item.append(colorPicker, checkbox, label, menuBtn);
  return {
    item,
    colorPicker,
    layer,
    lockOpacity: true,
  };
}

function openLayerContextMenu(event, layer, onContextMenu) {
  if (!onContextMenu) return;

  event.preventDefault();
  event.stopPropagation();
  onContextMenu({
    layerId: layer.id,
    clientX: event.clientX,
    clientY: event.clientY,
  });
}

function openLayerMenuFromButton(event, layer, onContextMenu) {
  if (!onContextMenu) return;

  event.preventDefault();
  event.stopPropagation();
  const rect = event.currentTarget.getBoundingClientRect();
  onContextMenu({
    layerId: layer.id,
    clientX: rect.right,
    clientY: rect.bottom + 4,
  });
}

export function renderLayerList({
  container,
  layers,
  formatBounds,
  onDragStart,
  onDragEnd,
  onColorChange,
  onAlphaOverrideChange,
  onVisibilityChange,
  onToggleVisibility,
  onContextMenu,
  onOpenFiles,
  getGlobalAlpha,
}) {
  destroyContainerPickrs(container);
  container.replaceChildren();
  const pickrTargets = [];

  if (layers.length === 0) {
    container.appendChild(createEmptyLayerItem(onOpenFiles));
    return;
  }

  const gerberLayers = layers.filter((layer) => layer.kind !== "drill");
  const drillLayers = layers.filter((layer) => layer.kind === "drill");

  if (gerberLayers.length > 0) {
    container.appendChild(createGroupHeader("Gerber Layers"));
  }
  for (const [index, layer] of gerberLayers.entries()) {
    const target = createLayerItem({
      layer,
      index,
      formatBounds,
      onDragStart,
      onDragEnd,
      onColorChange,
      onAlphaOverrideChange,
      onVisibilityChange,
      onToggleVisibility,
      onContextMenu,
      getGlobalAlpha,
    });
    container.appendChild(target.item);
    pickrTargets.push(target);
  }

  if (drillLayers.length > 0) {
    container.appendChild(createGroupHeader("Drills"));
  }
  for (const layer of drillLayers) {
    const target = createDrillItem({
      layer,
      formatBounds,
      onColorChange,
      onVisibilityChange,
      onToggleVisibility,
      onContextMenu,
    });
    container.appendChild(target.item);
    pickrTargets.push(target);
  }

  container._layerPickrs = pickrTargets
    .map((target) =>
      createPickrInstance({
        button: target.colorPicker,
        layer: target.layer,
        getGlobalAlpha,
        lockOpacity: target.lockOpacity,
        onAlphaOverrideChange,
        onColorChange,
      }),
    )
    .filter(Boolean);
}

export function refreshLayerListInheritedAlpha(container) {
  for (const controller of container._layerPickrs ?? []) {
    controller.syncGlobalAlpha?.();
  }
}

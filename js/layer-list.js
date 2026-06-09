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
  onVisibilityChange,
  onToggleVisibility,
  onDelete,
}) {
  const item = document.createElement("li");
  item.className = "layer-item";
  item.dataset.layerId = layer.id;
  item.dataset.layerIndex = String(index);
  item.draggable = true;
  item.addEventListener("dragstart", (event) => onDragStart(event, layer.id));
  item.addEventListener("dragend", onDragEnd);

  const colorPicker = document.createElement("input");
  colorPicker.type = "color";
  colorPicker.className = "layer-color-picker";
  colorPicker.value = rgbToHex(layer.color);
  colorPicker.addEventListener("change", (event) => {
    onColorChange(layer.id, event.target.value);
  });

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "layer-checkbox";
  checkbox.checked = layer.visible;
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

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "icon-button layer-delete-btn";
  deleteBtn.setAttribute("aria-label", "Delete layer");
  deleteBtn.title = "Delete layer";
  const deleteIcon = document.createElement("i");
  deleteIcon.setAttribute("data-lucide", "trash-2");
  deleteBtn.appendChild(deleteIcon);
  deleteBtn.addEventListener("click", () => {
    onDelete(layer.id);
  });

  item.append(colorPicker, checkbox, label, deleteBtn);
  return item;
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
  onDelete,
}) {
  const item = document.createElement("li");
  item.className = "layer-item drill-layer-item";
  item.dataset.layerId = layer.id;

  const colorPicker = document.createElement("input");
  colorPicker.type = "color";
  colorPicker.className = "layer-color-picker";
  colorPicker.value = rgbToHex(layer.color);
  colorPicker.addEventListener("change", (event) => {
    onColorChange(layer.id, event.target.value);
  });

  const checkbox = document.createElement("input");
  checkbox.type = "checkbox";
  checkbox.className = "layer-checkbox";
  checkbox.checked = layer.visible;
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

  const deleteBtn = document.createElement("button");
  deleteBtn.type = "button";
  deleteBtn.className = "icon-button layer-delete-btn";
  deleteBtn.setAttribute("aria-label", "Delete drill layer");
  deleteBtn.title = "Delete drill layer";
  const deleteIcon = document.createElement("i");
  deleteIcon.setAttribute("data-lucide", "trash-2");
  deleteBtn.appendChild(deleteIcon);
  deleteBtn.addEventListener("click", () => {
    onDelete(layer.id);
  });

  item.append(colorPicker, checkbox, label, deleteBtn);
  return item;
}

export function renderLayerList({
  container,
  layers,
  formatBounds,
  onDragStart,
  onDragEnd,
  onColorChange,
  onVisibilityChange,
  onToggleVisibility,
  onDelete,
  onOpenFiles,
}) {
  container.replaceChildren();

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
    container.appendChild(
      createLayerItem({
        layer,
        index,
        formatBounds,
        onDragStart,
        onDragEnd,
        onColorChange,
        onVisibilityChange,
        onToggleVisibility,
        onDelete,
      }),
    );
  }

  if (drillLayers.length > 0) {
    container.appendChild(createGroupHeader("Drills"));
  }
  for (const layer of drillLayers) {
    container.appendChild(
      createDrillItem({
        layer,
        formatBounds,
        onColorChange,
        onVisibilityChange,
        onToggleVisibility,
        onDelete,
      }),
    );
  }
}

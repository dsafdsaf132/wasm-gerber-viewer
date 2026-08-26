import {
  COMPOSITE_LAYER_KIND,
  createCompositeLayerPresetBitset,
  MAX_COMPOSITE_SOURCES,
  MIN_COMPOSITE_SOURCES,
  reconcileCompositeSources,
} from "../layers/composite-layers.js";

export class CompositeLayerDialog {
  constructor({ getGerberLayers, refreshIcons = () => {} }) {
    this.getGerberLayers = getGerberLayers;
    this.refreshIcons = refreshIcons;
    this.dialog = this.createDialog();
    document.body.appendChild(this.dialog);
  }

  openCreate(defaultName) {
    return this.open({
      title: "Create Composite Layer",
      submitLabel: "Create",
      name: defaultName,
      defaultName,
      sourceIds: [],
      initialPreset: "union",
      isEdit: false,
    });
  }

  openEdit(layer) {
    return this.open({
      title: "Edit Composite Layer",
      submitLabel: "Apply",
      name: layer.name,
      sourceIds: layer.sourceIds,
      initialPreset: null,
      isEdit: true,
      draftLayer: {
        kind: COMPOSITE_LAYER_KIND,
        sourceIds: layer.sourceIds,
        slotSourceIds: layer.slotSourceIds,
        visibleBitset: layer.visibleBitset,
      },
    });
  }

  openRename(name) {
    return this.open({
      title: "Rename Layer",
      submitLabel: "Rename",
      name,
      sourceIds: null,
      initialPreset: null,
      isEdit: false,
      renameOnly: true,
    });
  }

  open(options) {
    if (this.pendingResolve) {
      this.finish(null);
    }
    this.options = options;
    this.selectedSourceIds = options.sourceIds ? [...options.sourceIds] : null;
    this.draftLayer = options.draftLayer
      ? {
          ...options.draftLayer,
          sourceIds: [...options.draftLayer.sourceIds],
          slotSourceIds: [...options.draftLayer.slotSourceIds],
          visibleBitset: options.draftLayer.visibleBitset.slice(),
        }
      : null;
    this.presetCommand = options.initialPreset;
    this.bitsetDirty = false;
    this.title.textContent = options.title;
    this.submit.textContent = options.submitLabel;
    this.nameInput.value = options.name ?? "";
    this.sourceEditor.hidden = Boolean(options.renameOnly);
    this.searchInput.value = "";
    this.renderSources();
    this.syncSubmitState();
    this.dialog.showModal();
    requestAnimationFrame(() => {
      if (this.dialog.open) this.nameInput.focus({ preventScroll: true });
    });
    return new Promise((resolve) => {
      this.pendingResolve = resolve;
    });
  }

  createDialog() {
    const dialog = document.createElement("dialog");
    dialog.className = "composite-layer-dialog";
    dialog.setAttribute("aria-labelledby", "composite-layer-dialog-title");
    const form = document.createElement("form");
    form.className = "composite-layer-form";
    form.method = "dialog";
    form.innerHTML = `
      <div class="composite-dialog-header">
        <strong id="composite-layer-dialog-title" data-composite-title></strong>
        <button type="button" class="icon-button" data-composite-cancel aria-label="Close"><i data-lucide="x"></i></button>
      </div>
      <label class="composite-field">
        <span>Name</span>
        <input data-composite-name type="text" maxlength="160" autocomplete="off" />
      </label>
      <div data-composite-source-editor class="composite-source-editor">
        <div class="composite-source-heading">
          <strong>Gerber Sources</strong>
          <span data-composite-count role="status" aria-live="polite">0 / ${MAX_COMPOSITE_SOURCES}</span>
        </div>
        <input data-composite-search class="composite-search" type="search" aria-label="Filter Gerber sources" placeholder="Filter sources" autocomplete="off" />
        <div class="composite-source-columns">
          <div data-composite-available class="composite-source-list" aria-label="Available sources"></div>
          <ol data-composite-selected class="composite-selected-list" aria-label="Selected source order"></ol>
        </div>
        <div class="composite-preset-row" role="group" aria-label="Composite preset">
          <button type="button" class="chip-button" data-composite-preset="union">Union</button>
          <button type="button" class="chip-button" data-composite-preset="intersection">Intersection</button>
          <button type="button" class="chip-button" data-composite-preset="difference">Difference</button>
        </div>
        <button type="button" class="chip-button" data-composite-custom aria-label="Apply changes and select visible areas">Custom</button>
        <small class="composite-difference-note">Difference uses the first selected source as the base.</small>
      </div>
      <div class="composite-dialog-actions">
        <button type="button" class="chip-button" data-composite-dismiss>Cancel</button>
        <button type="submit" class="tool-button primary" data-composite-submit>Apply</button>
      </div>`;
    dialog.appendChild(form);
    this.form = form;
    this.title = form.querySelector("[data-composite-title]");
    this.nameInput = form.querySelector("[data-composite-name]");
    this.sourceEditor = form.querySelector("[data-composite-source-editor]");
    this.searchInput = form.querySelector("[data-composite-search]");
    this.availableList = form.querySelector("[data-composite-available]");
    this.selectedList = form.querySelector("[data-composite-selected]");
    this.count = form.querySelector("[data-composite-count]");
    this.submit = form.querySelector("[data-composite-submit]");
    this.custom = form.querySelector("[data-composite-custom]");

    for (const target of form.querySelectorAll("[data-composite-cancel], [data-composite-dismiss]")) {
      target.addEventListener("click", () => this.finish(null));
    }
    this.searchInput.addEventListener("input", () => this.renderSources());
    this.nameInput.addEventListener("input", () => this.syncSubmitState());
    for (const button of form.querySelectorAll("[data-composite-preset]")) {
      button.addEventListener("click", () => {
        this.presetCommand = button.dataset.compositePreset;
        if (this.draftLayer) {
          this.draftLayer.visibleBitset = createCompositeLayerPresetBitset(
            this.draftLayer,
            this.presetCommand,
          );
          this.bitsetDirty = true;
        }
        this.syncPresetButtons();
      });
    }
    this.custom.addEventListener("click", () => {
      if (this.custom.disabled) return;
      if (!this.options.isEdit) this.presetCommand = "none";
      this.finish(this.buildResult({ enterSelection: true }));
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      if (this.submit.disabled) return;
      const name = this.nameInput.value.trim();
      if (this.options.renameOnly) {
        this.finish(name);
        return;
      }
      this.finish(this.buildResult());
    });
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      this.finish(null);
    });
    dialog.addEventListener("keydown", (event) => {
      if (event.key !== "Tab") return;
      const focusable = Array.from(
        dialog.querySelectorAll(
          'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((element) => !element.closest("[hidden]"));
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }

      const first = focusable[0];
      const last = focusable.at(-1);
      if (
        !dialog.contains(document.activeElement) ||
        (event.shiftKey && document.activeElement === first) ||
        (!event.shiftKey && document.activeElement === last)
      ) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus({ preventScroll: true });
      }
    });
    return dialog;
  }

  buildResult({ enterSelection = false } = {}) {
    const name = this.nameInput.value.trim();
    return {
      name: name || this.options.defaultName,
      sourceIds: [...this.selectedSourceIds],
      ...(this.draftLayer
        ? {
            slotSourceIds: [...this.draftLayer.slotSourceIds],
            visibleBitset: this.draftLayer.visibleBitset,
            bitsetDirty: this.bitsetDirty,
          }
        : { presetCommand: this.presetCommand }),
      enterSelection,
    };
  }

  finish(result) {
    if (this.dialog.open) this.dialog.close();
    const resolve = this.pendingResolve;
    this.pendingResolve = null;
    // Source choice listeners close over their layer records (including the
    // original Gerber source text), while edit drafts can own two-megabyte
    // bitsets. The dialog lives for the entire Viewer session, so detach those
    // rows and references as soon as a create/edit/rename operation finishes.
    this.availableList.replaceChildren();
    this.selectedList.replaceChildren();
    this.options = null;
    this.selectedSourceIds = null;
    this.draftLayer = null;
    this.presetCommand = null;
    this.bitsetDirty = false;
    resolve?.(result);
  }

  renderSources() {
    if (!this.selectedSourceIds) return;
    const activeElement = document.activeElement;
    const focusedSourceControl =
      activeElement instanceof HTMLElement &&
      (this.availableList.contains(activeElement) ||
        this.selectedList.contains(activeElement))
        ? {
            sourceId: activeElement.dataset.compositeSourceId ?? null,
            control: activeElement.dataset.compositeSourceControl ?? null,
          }
        : null;
    const availableScrollTop = this.availableList.scrollTop;
    const selectedScrollTop = this.selectedList.scrollTop;
    const sources = this.getGerberLayers();
    const sourceById = new Map(sources.map((source) => [source.id, source]));
    const nameCounts = new Map();
    for (const source of sources) {
      const key = source.name.trim().toLowerCase();
      nameCounts.set(key, (nameCounts.get(key) ?? 0) + 1);
    }
    const displayLabel = (source) => {
      const duplicate = (nameCounts.get(source.name.trim().toLowerCase()) ?? 0) > 1;
      if (!duplicate) return source.name;
      const provenance = String(source.sourceName ?? "")
        .split(/[\\/]/)
        .filter(Boolean)
        .at(-1);
      return `${source.name} — ${provenance || "source"} (${source.id})`;
    };
    const query = this.searchInput.value.trim().toLowerCase();
    this.availableList.replaceChildren();
    for (const source of sources) {
      const sourceLabel = displayLabel(source);
      const searchable = `${sourceLabel} ${source.sourceName ?? ""} ${source.id}`.toLowerCase();
      if (query && !searchable.includes(query)) continue;
      const label = document.createElement("label");
      label.className = "composite-source-choice";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.dataset.compositeSourceId = source.id;
      input.dataset.compositeSourceControl = "choice";
      input.checked = this.selectedSourceIds.includes(source.id);
      input.disabled =
        (!input.checked && this.selectedSourceIds.length >= MAX_COMPOSITE_SOURCES) ||
        (this.options.isEdit &&
          input.checked &&
          this.selectedSourceIds.length <= MIN_COMPOSITE_SOURCES);
      input.addEventListener("change", () => {
        const nextSourceIds = input.checked
          ? [...this.selectedSourceIds, source.id]
          : this.selectedSourceIds.filter((id) => id !== source.id);
        if (this.draftLayer) {
          const reconciled = reconcileCompositeSources(
            this.draftLayer,
            nextSourceIds,
            { takeBitsetOwnership: true },
          );
          Object.assign(this.draftLayer, reconciled);
          this.selectedSourceIds = [...this.draftLayer.sourceIds];
          this.presetCommand = null;
          this.bitsetDirty = true;
        } else {
          this.selectedSourceIds = nextSourceIds;
        }
        this.renderSources();
      });
      const text = document.createElement("span");
      text.textContent = sourceLabel;
      text.title = sourceLabel;
      label.append(input, text);
      this.availableList.appendChild(label);
    }

    this.selectedList.replaceChildren();
    for (const [index, sourceId] of this.selectedSourceIds.entries()) {
      const source = sourceById.get(sourceId);
      if (!source) continue;
      const item = document.createElement("li");
      const name = document.createElement("span");
      const sourceLabel = displayLabel(source);
      name.textContent = sourceLabel;
      name.title = sourceLabel;
      const controls = document.createElement("span");
      controls.className = "composite-order-controls";
      controls.append(
        this.createMoveButton(
          "chevron-up",
          `Move ${sourceLabel} up`,
          sourceId,
          "move-up",
          index,
          index - 1,
        ),
        this.createMoveButton(
          "chevron-down",
          `Move ${sourceLabel} down`,
          sourceId,
          "move-down",
          index,
          index + 1,
        ),
      );
      item.append(name, controls);
      this.selectedList.appendChild(item);
    }
    this.count.textContent = `${this.selectedSourceIds.length} / ${MAX_COMPOSITE_SOURCES}`;
    this.syncPresetButtons();
    this.syncSubmitState();
    this.refreshIcons();
    this.availableList.scrollTop = availableScrollTop;
    this.selectedList.scrollTop = selectedScrollTop;
    if (focusedSourceControl?.sourceId && focusedSourceControl.control) {
      const sourceControls = [
        ...this.availableList.querySelectorAll("[data-composite-source-id]"),
        ...this.selectedList.querySelectorAll("[data-composite-source-id]"),
      ].filter(
        (element) =>
          element.dataset.compositeSourceId === focusedSourceControl.sourceId,
      );
      const replacement = sourceControls.find(
        (element) =>
          element.dataset.compositeSourceControl === focusedSourceControl.control &&
          !element.disabled,
      ) ?? sourceControls.find((element) => !element.disabled);
      replacement?.focus({ preventScroll: true });
    }
  }

  createMoveButton(iconName, label, sourceId, control, from, to) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "icon-button compact";
    button.setAttribute("aria-label", label);
    button.dataset.compositeSourceId = sourceId;
    button.dataset.compositeSourceControl = control;
    button.disabled = to < 0 || to >= this.selectedSourceIds.length;
    const icon = document.createElement("i");
    icon.setAttribute("data-lucide", iconName);
    button.appendChild(icon);
    button.addEventListener("click", () => {
      [this.selectedSourceIds[from], this.selectedSourceIds[to]] = [
        this.selectedSourceIds[to],
        this.selectedSourceIds[from],
      ];
      if (this.draftLayer) {
        this.draftLayer.sourceIds = [...this.selectedSourceIds];
        this.presetCommand = null;
      }
      this.renderSources();
    });
    return button;
  }

  syncPresetButtons() {
    for (const button of this.form.querySelectorAll("[data-composite-preset]")) {
      const active = button.dataset.compositePreset === this.presetCommand;
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    }
  }

  syncSubmitState() {
    const validName =
      (!this.options?.isEdit && !this.options?.renameOnly) ||
      this.nameInput.value.trim().length > 0;
    const validSources =
      this.options?.renameOnly ||
      (this.selectedSourceIds?.length >= MIN_COMPOSITE_SOURCES &&
        this.selectedSourceIds.length <= MAX_COMPOSITE_SOURCES);
    const disabled = !validName || !validSources;
    this.submit.disabled = disabled;
    this.custom.disabled = disabled;
  }
}

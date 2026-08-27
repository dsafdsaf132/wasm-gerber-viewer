export class RenameLayerDialog {
  constructor({ refreshIcons = () => {} } = {}) {
    this.refreshIcons = refreshIcons;
    this.dialog = this.createDialog();
    document.body.appendChild(this.dialog);
  }

  open(name) {
    if (this.pendingResolve) {
      this.finish(null);
    }
    this.nameInput.value = name ?? "";
    this.syncSubmitState();
    this.dialog.showModal();
    this.refreshIcons();
    requestAnimationFrame(() => {
      if (!this.dialog.open) return;
      this.nameInput.focus({ preventScroll: true });
      this.nameInput.select();
    });
    return new Promise((resolve) => {
      this.pendingResolve = resolve;
    });
  }

  createDialog() {
    const dialog = document.createElement("dialog");
    dialog.className = "rename-layer-dialog";
    dialog.setAttribute("aria-labelledby", "rename-layer-dialog-title");

    const form = document.createElement("form");
    form.className = "rename-layer-form";
    form.method = "dialog";
    form.innerHTML = `
      <div class="rename-layer-header">
        <strong id="rename-layer-dialog-title">Rename Layer</strong>
        <button type="button" class="icon-button" data-rename-cancel aria-label="Close"><i data-lucide="x"></i></button>
      </div>
      <label class="rename-layer-field">
        <span>Name</span>
        <input data-rename-name type="text" maxlength="160" autocomplete="off" />
      </label>
      <div class="rename-layer-actions">
        <button type="button" class="chip-button" data-rename-dismiss>Cancel</button>
        <button type="submit" class="tool-button primary" data-rename-submit>Rename</button>
      </div>`;
    dialog.appendChild(form);

    this.form = form;
    this.nameInput = form.querySelector("[data-rename-name]");
    this.submit = form.querySelector("[data-rename-submit]");

    for (const target of form.querySelectorAll("[data-rename-cancel], [data-rename-dismiss]")) {
      target.addEventListener("click", () => this.finish(null));
    }
    this.nameInput.addEventListener("input", () => this.syncSubmitState());
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const name = this.nameInput.value.trim();
      if (!name) return;
      this.finish(name);
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

  syncSubmitState() {
    this.submit.disabled = this.nameInput.value.trim().length === 0;
  }

  finish(result) {
    if (this.dialog.open) this.dialog.close();
    const resolve = this.pendingResolve;
    this.pendingResolve = null;
    this.nameInput.value = "";
    this.syncSubmitState();
    resolve?.(result);
  }
}

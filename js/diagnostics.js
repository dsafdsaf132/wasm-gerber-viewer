export class DiagnosticsLog {
  constructor({ container, maxEntries = 30 }) {
    this.container = container;
    this.maxEntries = maxEntries;
    this.entries = [];
  }

  get count() {
    return this.entries.length;
  }

  add(level, title, detail = "") {
    if (level === "info") {
      return;
    }

    this.entries.unshift({
      level,
      title,
      detail,
      time: new Date().toLocaleTimeString(),
    });
    this.entries = this.entries.slice(0, this.maxEntries);
  }

  clear() {
    this.entries = [];
  }

  render() {
    this.container.replaceChildren();

    if (this.entries.length === 0) {
      this.container.appendChild(this.createItem("No diagnostics", "Ready"));
      return;
    }

    for (const diagnostic of this.entries) {
      const detail =
        `${diagnostic.time} · ${diagnostic.level}` +
        (diagnostic.detail ? ` · ${diagnostic.detail}` : "");
      this.container.appendChild(this.createItem(diagnostic.title, detail));
    }
  }

  createItem(titleText, detailText) {
    const item = document.createElement("li");
    const title = document.createElement("strong");
    const detail = document.createElement("span");
    title.textContent = titleText;
    detail.textContent = detailText;
    item.append(title, detail);
    return item;
  }
}

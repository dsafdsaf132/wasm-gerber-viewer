export class NotificationCenter {
  constructor({
    notification,
    titleElement,
    messageElement,
    durationMs,
    onNotify,
  }) {
    this.notification = notification;
    this.titleElement = titleElement;
    this.messageElement = messageElement;
    this.durationMs = durationMs;
    this.onNotify = onNotify;
    this.timeout = null;
  }

  show(title, variant, renderMessage, duration = this.durationMs) {
    if (this.timeout !== null) {
      clearTimeout(this.timeout);
    }

    this.notification.classList.remove("danger", "show");
    if (variant === "danger") {
      this.notification.classList.add("danger");
    }

    this.titleElement.textContent = title;
    this.messageElement.replaceChildren();
    renderMessage(this.messageElement);
    this.onNotify?.(variant, title, this.messageElement.textContent.trim());

    requestAnimationFrame(() => {
      this.notification.classList.add("show");
    });

    this.timeout = setTimeout(() => {
      this.hide();
    }, duration);
  }

  showError(message) {
    this.show("Error", "danger", (messageElement) => {
      messageElement.textContent = message;
    });
  }

  showFileSizeWarning(oversizedFiles) {
    this.show("Warning", "warning", (messageElement) => {
      const list = document.createElement("ul");
      list.className = "mb-0 mt-2 ps-3";

      oversizedFiles.forEach((file) => {
        const item = document.createElement("li");
        const fileName = document.createElement("strong");
        fileName.textContent = file.name;

        item.appendChild(fileName);
        item.append(
          document.createTextNode(`: ${file.size} (limit: ${file.limit})`),
        );
        list.appendChild(item);
      });

      messageElement.appendChild(list);
    });
  }

  hide() {
    if (this.timeout !== null) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }

    this.notification.classList.remove("show");
    this.titleElement.textContent = "Notice";
  }
}

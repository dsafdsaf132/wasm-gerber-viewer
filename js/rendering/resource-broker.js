export class RendererResourceBroker {
  constructor() {
    this.tail = Promise.resolve();
  }

  run(operation) {
    if (typeof operation !== "function") {
      return Promise.reject(new TypeError("Renderer resource operation must be a function"));
    }
    const result = this.tail.then(operation, operation);
    this.tail = result.catch(() => undefined);
    return result;
  }
}

import test from "node:test";
import assert from "node:assert/strict";
import { RendererResourceBroker } from "../js/rendering/resource-broker.js";

test("renderer resource broker preserves command order", async () => {
  const broker = new RendererResourceBroker();
  const events = [];
  const first = broker.run(async () => {
    await Promise.resolve();
    events.push("first");
  });
  const second = broker.run(() => events.push("second"));
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first", "second"]);
});

test("renderer resource broker continues after a failed command", async () => {
  const broker = new RendererResourceBroker();
  await assert.rejects(broker.run(() => Promise.reject(new Error("failed"))));
  assert.equal(await broker.run(() => "recovered"), "recovered");
});

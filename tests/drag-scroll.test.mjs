import assert from "node:assert/strict";
import test from "node:test";
import { enableDragScroll } from "../js/ui/drag-scroll.js";

function fixture() {
  const document = new EventTarget();
  document.defaultView = new EventTarget();
  const element = new EventTarget();
  Object.assign(element, {
    ownerDocument: document,
    scrollLeft: 0,
    scrollWidth: 600,
    clientWidth: 200,
    captured: null,
    setPointerCapture(id) { this.captured = id; },
    hasPointerCapture(id) { return this.captured === id; },
    releasePointerCapture() { this.captured = null; },
    classList: new Set(),
  });
  element.classList.remove = element.classList.delete;
  const dispose = enableDragScroll(element);
  const dispatch = (target, type, values = {}) => {
    const event = Object.assign(new Event(type, { cancelable: true }), {
      pointerId: 1, pointerType: "mouse", button: 0, clientX: 100,
      detail: 1, ...values,
    });
    target.dispatchEvent(event);
    return event;
  };
  return { document, element, dispose, dispatch };
}

test("dragging over buttons scrolls and suppresses the release click, but not the next click", () => {
  const { document, element, dispose, dispatch } = fixture();
  dispatch(element, "pointerdown");
  dispatch(document, "pointermove", { clientX: 60 });
  assert.equal(element.scrollLeft, 40);
  assert.equal(element.captured, 1);
  dispatch(document, "pointerup");
  assert.equal(element.captured, null);
  assert.equal(dispatch(element, "click").defaultPrevented, true);
  dispatch(element, "pointerdown");
  dispatch(document, "pointerup");
  assert.equal(dispatch(element, "click").defaultPrevented, false);
  dispose();
});

test("small pointer motion and touch preserve normal activation and native scrolling", () => {
  const { document, element, dispose, dispatch } = fixture();
  dispatch(element, "pointerdown");
  dispatch(document, "pointermove", { clientX: 97 });
  dispatch(document, "pointerup");
  assert.equal(dispatch(element, "click").defaultPrevented, false);
  dispatch(element, "pointerdown", { pointerType: "touch" });
  dispatch(document, "pointermove", { clientX: 40, pointerType: "touch" });
  assert.equal(element.scrollLeft, 0);
  assert.equal(element.captured, null);
  dispose();
});

test("keyboard activation remains available after a drag", () => {
  const { document, element, dispose, dispatch } = fixture();
  dispatch(element, "pointerdown");
  dispatch(document, "pointermove", { clientX: 50 });
  dispatch(document, "pointerup");
  assert.equal(dispatch(element, "click", { detail: 0 }).defaultPrevented, false);
  dispose();
});

test("cancel, blur and disposal release capture and stop tracking movement", () => {
  for (const end of ["pointercancel", "blur", "dispose"]) {
    const { document, element, dispose, dispatch } = fixture();
    dispatch(element, "pointerdown");
    dispatch(document, "pointermove", { clientX: 50 });
    if (end === "dispose") dispose();
    else dispatch(end === "blur" ? document.defaultView : document, end);
    assert.equal(element.captured, null);
    dispatch(document, "pointermove", { clientX: 10 });
    assert.equal(element.scrollLeft, 50);
    assert.equal(element.classList.has("is-dragging"), false);
    dispose();
  }
});

test("wheel scrolling respects delta units and leaves pinch zoom to the browser", () => {
  const { element, dispose, dispatch } = fixture();
  const wheel = dispatch(element, "wheel", { deltaX: 0, deltaY: 2, deltaMode: 1 });
  assert.equal(element.scrollLeft, 32);
  assert.equal(wheel.defaultPrevented, true);
  assert.equal(dispatch(element, "wheel", {
    deltaX: 0, deltaY: 10, ctrlKey: true,
  }).defaultPrevented, false);
  assert.equal(element.scrollLeft, 32);
  dispose();
});

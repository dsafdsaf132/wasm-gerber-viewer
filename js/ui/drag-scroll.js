// Touch uses native scrolling; mouse/pen dragging also works over buttons.
// Return a disposer for toolbars that are removed when a mode ends.
export function enableDragScroll(element) {
  const controller = new AbortController();
  const { signal } = controller;
  const document = element.ownerDocument;
  let gesture = null;
  let suppressClick = false;

  const finish = () => {
    if (!gesture) return;
    const { pointerId } = gesture;
    gesture = null;
    element.classList.remove("is-dragging");
    if (element.hasPointerCapture(pointerId)) {
      element.releasePointerCapture(pointerId);
    }
  };

  element.addEventListener("pointerdown", (event) => {
    finish();
    suppressClick = false;
    if (event.pointerType === "touch" || event.button !== 0 ||
        element.scrollWidth <= element.clientWidth) return;
    gesture = {
      pointerId: event.pointerId,
      x: event.clientX,
      scrollLeft: element.scrollLeft,
      dragging: false,
    };
  }, { signal });

  document.addEventListener("pointermove", (event) => {
    if (!gesture || event.pointerId !== gesture.pointerId) return;
    const delta = event.clientX - gesture.x;
    if (!gesture.dragging) {
      if (Math.abs(delta) < 6) return;
      gesture.dragging = true;
      suppressClick = true;
      element.setPointerCapture(event.pointerId);
      element.classList.add("is-dragging");
    }
    event.preventDefault();
    element.scrollLeft = gesture.scrollLeft - delta;
  }, { signal, passive: false });

  for (const type of ["pointerup", "pointercancel"]) {
    document.addEventListener(type, (event) => {
      if (event.pointerId === gesture?.pointerId) finish();
    }, { signal });
  }
  element.addEventListener("lostpointercapture", finish, { signal });
  document.defaultView?.addEventListener("blur", finish, { signal });
  element.addEventListener("click", (event) => {
    // Keyboard activation has detail 0 and must remain available after a drag.
    if (!suppressClick || event.detail === 0) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    suppressClick = false;
  }, { capture: true, signal });
  element.addEventListener("dragstart", (event) => event.preventDefault(), { signal });
  element.addEventListener("wheel", (event) => {
    // Keep wheel gestures over the toolbar from zooming the canvas below it.
    event.stopPropagation();
    if (event.ctrlKey || event.metaKey || event.deltaX ||
        element.scrollWidth <= element.clientWidth) return;
    const scale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? element.clientWidth : 1;
    element.scrollLeft += event.deltaY * scale;
    event.preventDefault();
  }, { signal, passive: false });

  return () => {
    finish();
    controller.abort();
  };
}

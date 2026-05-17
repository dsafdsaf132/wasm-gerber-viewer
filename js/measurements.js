const SVG_NS = "http://www.w3.org/2000/svg";
const MM_PER_INCH = 25.4;
const MILS_PER_INCH = 1000;
const MIL_THRESHOLD_INCHES = 1;

export function formatMeasurementLength(length, unit) {
  if (unit === "inch") {
    const formatted = formatImperialLength(length);
    return `${formatted.value} ${formatted.unit}`;
  }

  const decimals = length >= 10 ? 2 : 3;
  return `${length.toFixed(decimals)} mm`;
}

export function formatDimensionPair(widthMm, heightMm, unit) {
  if (unit === "inch") {
    return `${(widthMm / MM_PER_INCH).toFixed(4)} x ${(
      heightMm / MM_PER_INCH
    ).toFixed(4)} in`;
  }

  return `${widthMm.toFixed(3)} x ${heightMm.toFixed(3)} mm`;
}

function formatImperialLength(lengthMm) {
  const inches = lengthMm / MM_PER_INCH;
  if (Math.abs(inches) < MIL_THRESHOLD_INCHES) {
    const mils = inches * MILS_PER_INCH;
    return {
      value: mils.toFixed(3),
      unit: "mil",
    };
  }

  return {
    value: inches.toFixed(4),
    unit: "in",
  };
}

export function drawMeasurementsOnContext(
  context,
  { measurements, rulerStartPoint, rulerHoverPoint, worldToCanvasPoint, unit },
) {
  for (const measurement of measurements) {
    drawMeasurementOnContext({
      context,
      start: measurement.start,
      end: measurement.end,
      isPreview: false,
      worldToCanvasPoint,
      unit,
    });
  }

  if (rulerStartPoint && rulerHoverPoint) {
    drawMeasurementOnContext({
      context,
      start: rulerStartPoint,
      end: rulerHoverPoint,
      isPreview: true,
      worldToCanvasPoint,
      unit,
    });
  } else if (rulerStartPoint) {
    drawMeasurementPointOnContext(context, rulerStartPoint, worldToCanvasPoint);
  }
}

export function renderMeasurements({
  overlay,
  rect,
  measurements,
  rulerStartPoint,
  rulerHoverPoint,
  worldToCanvasPoint,
  unit,
}) {
  overlay.replaceChildren();

  if (rect.width === 0 || rect.height === 0) {
    return;
  }

  overlay.setAttribute("viewBox", `0 0 ${rect.width} ${rect.height}`);

  for (const measurement of measurements) {
    drawSvgMeasurement({
      overlay,
      start: measurement.start,
      end: measurement.end,
      isPreview: false,
      worldToCanvasPoint,
      unit,
    });
  }

  if (rulerStartPoint) {
    drawSvgMeasurementPoint(overlay, rulerStartPoint, worldToCanvasPoint);
    if (rulerHoverPoint) {
      drawSvgMeasurement({
        overlay,
        start: rulerStartPoint,
        end: rulerHoverPoint,
        isPreview: true,
        worldToCanvasPoint,
        unit,
      });
    }
  }
}

function drawMeasurementOnContext({
  context,
  start,
  end,
  isPreview,
  worldToCanvasPoint,
  unit,
}) {
  const startPoint = worldToCanvasPoint(start);
  const endPoint = worldToCanvasPoint(end);
  if (!startPoint || !endPoint) return;

  context.save();
  context.globalAlpha = isPreview ? 0.7 : 1;
  context.lineCap = "round";
  context.lineJoin = "round";
  context.strokeStyle = "#000";
  context.lineWidth = 4;
  context.beginPath();
  context.moveTo(startPoint.x, startPoint.y);
  context.lineTo(endPoint.x, endPoint.y);
  context.stroke();
  context.strokeStyle = "#fff";
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(startPoint.x, startPoint.y);
  context.lineTo(endPoint.x, endPoint.y);
  context.stroke();
  context.restore();

  drawMeasurementPointOnContext(context, start, worldToCanvasPoint);
  drawMeasurementPointOnContext(context, end, worldToCanvasPoint);
  drawContextLabel(context, start, end, startPoint, endPoint, unit);
}

function drawMeasurementPointOnContext(context, point, worldToCanvasPoint) {
  const canvasPoint = worldToCanvasPoint(point);
  if (!canvasPoint) return;

  context.save();
  context.fillStyle = "#fff";
  context.strokeStyle = "#000";
  context.lineWidth = 1;
  context.beginPath();
  context.arc(canvasPoint.x, canvasPoint.y, 4, 0, Math.PI * 2);
  context.fill();
  context.stroke();
  context.restore();
}

function drawContextLabel(context, start, end, startPoint, endPoint, unit) {
  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  const x = (startPoint.x + endPoint.x) / 2;
  const y = (startPoint.y + endPoint.y) / 2 - 8;

  context.save();
  context.font = "700 12px Inter, ui-sans-serif, system-ui, sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.lineWidth = 4;
  context.strokeStyle = "#000";
  context.fillStyle = "#fff";
  context.strokeText(formatMeasurementLength(distance, unit), x, y);
  context.fillText(formatMeasurementLength(distance, unit), x, y);
  context.restore();
}

function drawSvgMeasurement({
  overlay,
  start,
  end,
  isPreview,
  worldToCanvasPoint,
  unit,
}) {
  const startPoint = worldToCanvasPoint(start);
  const endPoint = worldToCanvasPoint(end);
  if (!startPoint || !endPoint) return;

  const outline = createMeasurementLine(
    startPoint,
    endPoint,
    "measurement-line-outline",
  );
  const line = createMeasurementLine(startPoint, endPoint, "measurement-line");
  if (isPreview) {
    outline.setAttribute("opacity", "0.7");
    line.setAttribute("opacity", "0.7");
  }
  overlay.append(outline, line);

  drawSvgMeasurementPoint(overlay, start, worldToCanvasPoint);
  drawSvgMeasurementPoint(overlay, end, worldToCanvasPoint);

  const distance = Math.hypot(end.x - start.x, end.y - start.y);
  const label = createSvgElement("text");
  label.textContent = formatMeasurementLength(distance, unit);
  label.setAttribute("x", (startPoint.x + endPoint.x) / 2);
  label.setAttribute("y", (startPoint.y + endPoint.y) / 2 - 8);
  label.setAttribute("text-anchor", "middle");
  overlay.appendChild(label);
}

function createMeasurementLine(startPoint, endPoint, className) {
  const line = createSvgElement("line");
  line.setAttribute("class", className);
  line.setAttribute("x1", startPoint.x);
  line.setAttribute("y1", startPoint.y);
  line.setAttribute("x2", endPoint.x);
  line.setAttribute("y2", endPoint.y);
  return line;
}

function drawSvgMeasurementPoint(overlay, point, worldToCanvasPoint) {
  const canvasPoint = worldToCanvasPoint(point);
  if (!canvasPoint) return;

  const circle = createSvgElement("circle");
  circle.setAttribute("cx", canvasPoint.x);
  circle.setAttribute("cy", canvasPoint.y);
  circle.setAttribute("r", "4");
  overlay.appendChild(circle);
}

function createSvgElement(tagName) {
  return document.createElementNS(SVG_NS, tagName);
}

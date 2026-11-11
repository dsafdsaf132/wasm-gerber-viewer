export function needsLayerFormatDetection(path) {
  return /\.(?:drl|drd)$/i.test(String(path ?? ""));
}

export function detectLayerFormat(content) {
  const text = String(content ?? "").slice(0, 8192).toUpperCase();
  let position = 0;
  while (position < text.length) {
    position = skipWhitespace(text, position);
    if (position >= text.length) break;
    const character = text[position];
    if (character === ";") {
      position = skipLineComment(text, position);
    } else if (character === "*") {
      position++;
    } else if (text.startsWith("G04", position) || text.startsWith("G4", position)) {
      const end = text.indexOf("*", position);
      if (end < 0) break;
      position = end + 1;
    } else if (character === "%") {
      const end = text.indexOf("%", position + 1);
      if (end >= 0 && isGerberParameterBlock(text, position + 1, end)) {
        return "gerber";
      }
      position++;
    } else {
      while (position < text.length && text[position] !== "*") {
        position = text[position] === ";"
          ? skipLineComment(text, position)
          : position + 1;
      }
    }
  }
  return looksLikeDrillContent(text) ? "drill" : null;
}

function isGerberParameterBlock(text, start, end) {
  let position = skipWhitespace(text, start);
  let recognized = false;
  while (position < end) {
    const terminator = text.indexOf("*", position);
    if (terminator < 0 || terminator >= end) return false;
    const command = text.slice(position, terminator).replace(/\s/g, "");
    if (command.startsWith("AM") && /^AM[A-Z_$][A-Z0-9_.$]*$/.test(command)) {
      return text.slice(start, end).trimEnd().endsWith("*");
    }
    recognized ||= (
      (command.startsWith("FS") && /^FS[LT][AI]X\d{2}Y\d{2}$/.test(command)) ||
      command === "MOIN" || command === "MOMM" ||
      (command.startsWith("AD") && /^ADD[1-9]\d+[A-Z_$][A-Z0-9_.$]*(?:,[+\-\d.X]+)?$/.test(command)) ||
      command === "LPD" || command === "LPC"
    );
    position = skipWhitespace(text, terminator + 1);
  }
  return recognized;
}

function skipWhitespace(text, position) {
  while (position < text.length && (text.charCodeAt(position) <= 32 || text.charCodeAt(position) === 0xFEFF)) {
    position++;
  }
  return position;
}

function skipLineComment(text, position) {
  while (position < text.length && text[position] !== "\r" && text[position] !== "\n") {
    position++;
  }
  return position;
}

export function looksLikeDrillContent(content) {
  const lines = String(content ?? "")
    .split(/\r?\n/, 80)
    .map((line) => line.trim().toUpperCase());
  if (lines.some((line) => line === "M48")) return true;
  const hasToolDeclaration = lines.some((line) => /^T\d+C[+\-.\d]+/.test(line));
  const hasDrillCommand = lines.some((line) =>
    /^(METRIC|INCH|M71|M72|G05|G90|G91|ICI,ON|ICI,OFF)\b/.test(line),
  );
  return hasToolDeclaration && hasDrillCommand;
}

import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { resolve } from "node:path";

const targetPath = resolve(process.env.GERBER_TEST_SHRINK_PATH);
const originalOpen = fs.promises.open.bind(fs.promises);
const originalTruncate = fs.promises.truncate.bind(fs.promises);

fs.promises.open = async function openWithShrink(path, ...args) {
  const handle = await originalOpen(path, ...args);
  if (resolve(String(path)) !== targetPath) return handle;

  let initialStatRead = false;
  return new Proxy(handle, {
    get(fileHandle, property) {
      if (property === "stat") {
        return async function statWithShrink(...statArgs) {
          const stats = await fileHandle.stat(...statArgs);
          if (!initialStatRead) {
            initialStatRead = true;
            await originalTruncate(targetPath, Math.max(0, stats.size - 1));
          }
          return stats;
        };
      }
      const value = fileHandle[property];
      return typeof value === "function" ? value.bind(fileHandle) : value;
    },
  });
};

syncBuiltinESMExports();

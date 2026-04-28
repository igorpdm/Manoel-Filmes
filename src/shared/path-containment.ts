import { resolve, sep } from "path";

export function isPathInsideDirectory(directory: string, targetPath: string): boolean {
  const root = resolve(directory);
  const target = resolve(targetPath);

  return target === root || target.startsWith(root + sep);
}

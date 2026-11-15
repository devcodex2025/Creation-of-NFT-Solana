import { existsSync } from "node:fs";
import * as path from "node:path";

function findRepoRoot(start: string): string {
  let dir = path.resolve(start);
  for (;;) {
    if (existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

// TypeScript runners can report a virtual __dirname, so anchor the project to
// the working directory instead.
export const repoRoot = findRepoRoot(process.cwd());

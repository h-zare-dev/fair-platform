import { lstat, realpath } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fail } from './errors.js';
import { object } from './json.js';

/** Resolve symlinks and reject all Git worktrees, including linked worktrees with a .git file. */
export async function outsideWorktree(
  path: string,
  output = false,
): Promise<string> {
  try {
    const absolute = resolve(path);
    const canonical = output
      ? resolve(await realpath(dirname(absolute)), absolute.split('/').at(-1)!)
      : await realpath(absolute);
    let parent = dirname(canonical);
    for (;;) {
      try {
        const marker = await lstat(resolve(parent, '.git'));
        // A directory is a Git marker only when it contains HEAD. Some sandbox mounts
        // contain an empty .git directory that Git itself does not recognize.
        if (marker.isDirectory()) await lstat(resolve(parent, '.git', 'HEAD'));
        fail('UNSAFE_PATH');
      } catch (error) {
        if (!(object(error) && error.code === 'ENOENT')) throw error;
      }
      const next = dirname(parent);
      if (next === parent) break;
      parent = next;
    }
    return canonical;
  } catch {
    return fail('UNSAFE_PATH');
  }
}

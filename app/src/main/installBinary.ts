import { copyFile, chmod, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

/**
 * Install an executable at `dest`, replacing whatever is there.
 *
 * NOT `copyFile` straight onto `dest`: writing into a binary that is currently
 * executing fails with ETXTBSY, and `~/.local/bin/amber` is exactly that — the
 * running daemon's image. Measured: a packaged launch whose install step ran
 * while the daemon was up died at startup with `ETXTBSY: text file is busy`.
 *
 * Writing a temp file beside the target and renaming over it swaps the
 * DIRECTORY ENTRY instead, so the running process keeps its old inode (it stays
 * alive on it until it exits) and the next exec picks up the new one. The
 * rename is atomic, so a crash mid-install can never leave a half-written
 * binary at the stable path.
 */
export async function installBinary(src: string, dest: string): Promise<void> {
  // Same directory as `dest`: rename() cannot cross filesystems, and the OS
  // temp dir is routinely a different mount.
  const tmp = join(dirname(dest), `.${basename(dest)}.new-${process.pid}`)
  try {
    await copyFile(src, tmp)
    await chmod(tmp, 0o755)
    await rename(tmp, dest)
  } catch (e) {
    await rm(tmp, { force: true }).catch(() => {})
    throw e
  }
}

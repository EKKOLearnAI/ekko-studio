import { basename, dirname } from 'node:path'
import { lstat, mkdir, open, readdir, rename, rmdir, stat, unlink } from 'node:fs/promises'

export async function statIfPresent(path: string) {
  try {
    return await stat(path)
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    throw error
  }
}

export function fileContent(content: unknown): Buffer {
  if (typeof content !== 'string') {
    throw Object.assign(new Error('File content must be a string'), { status: 400, code: 'invalid_content' })
  }
  return Buffer.from(content, 'utf8')
}

// Reserve the destination exclusively before replacing our own empty entry.
export async function renameWithoutOverwrite(source: string, destination: string): Promise<void> {
  const entry = await lstat(source)
  if (source === destination) return
  if (dirname(source) === dirname(destination) && basename(source).toLowerCase() === basename(destination).toLowerCase()) {
    // On case-insensitive volumes, two spellings may address the same directory entry.
    const names = await readdir(dirname(source))
    if (names.includes(basename(source)) && !names.includes(basename(destination))) {
      const target = await lstat(destination).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
      })
      if (target && target.dev === entry.dev && target.ino === entry.ino) {
        await rename(source, destination)
        return
      }
    }
  }
  if (entry.isDirectory()) {
    if (process.platform === 'win32') {
      // Windows rename itself refuses to replace an existing directory.
      try {
        await rename(source, destination)
      } catch (error) {
        const target = await lstat(destination).catch(() => null)
        if (target) throw Object.assign(new Error('Destination already exists'), { code: 'EEXIST' })
        throw error
      }
      return
    }
    await mkdir(destination)
  } else {
    const reservation = await open(destination, 'wx')
    await reservation.close()
  }
  try {
    await rename(source, destination)
  } catch (error) {
    if (entry.isDirectory()) await rmdir(destination)
    else await unlink(destination)
    throw error
  }
}

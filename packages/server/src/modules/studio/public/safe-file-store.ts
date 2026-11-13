import { copyFile, mkdir, readFile, rename, rm, writeFile } from 'fs/promises'
import { dirname, resolve } from 'path'
import { randomUUID } from 'crypto'
import YAML, { type DumpOptions } from 'js-yaml'

type TextUpdater<T = void> = (current: string) => string | { content: string; result: T } | Promise<string | { content: string; result: T }>
type YamlUpdateResult<T> = { data: Record<string, any>; result: T; write?: boolean }
type YamlUpdater<T = void> = (current: Record<string, any>) => Record<string, any> | YamlUpdateResult<T> | Promise<Record<string, any> | YamlUpdateResult<T>>

export interface SafeWriteOptions {
  backup?: boolean
  backupPath?: string
}

export interface SafeYamlOptions extends SafeWriteOptions {
  dumpOptions?: DumpOptions
}

export type MultiTextUpdate = Record<string, string | undefined>

type MultiTextUpdater<T = void> = (
  current: Readonly<Record<string, string | undefined>>,
) => MultiTextUpdate | { files: MultiTextUpdate; result: T } | Promise<MultiTextUpdate | { files: MultiTextUpdate; result: T }>

function isTextUpdateResult<T>(value: unknown): value is { content: string; result: T } {
  return !!value && typeof value === 'object' && Object.hasOwn(value as Record<string, unknown>, 'content')
}

function isYamlUpdateResult<T>(value: unknown): value is YamlUpdateResult<T> {
  return !!value && typeof value === 'object' && Object.hasOwn(value as Record<string, unknown>, 'data')
}

function isMultiTextUpdateResult<T>(value: unknown): value is { files: MultiTextUpdate; result: T } {
  return !!value && typeof value === 'object' && Object.hasOwn(value as Record<string, unknown>, 'files')
}

function shouldUseFallbackBackup(err: any): boolean {
  return ['EACCES', 'EPERM', 'EEXIST'].includes(err?.code)
}

export class SafeFileStore {
  private queues = new Map<string, Promise<unknown>>()

  private normalizePath(filePath: string): string {
    return resolve(filePath)
  }

  private async withLock<T>(filePath: string, task: () => Promise<T>): Promise<T> {
    const key = this.normalizePath(filePath)
    const previous = this.queues.get(key) || Promise.resolve()
    let release!: () => void
    const current = new Promise<void>(resolve => { release = resolve })
    const next = previous.then(() => current, () => current)
    this.queues.set(key, next)

    await previous.catch(() => undefined)
    try {
      return await task()
    } finally {
      release()
      if (this.queues.get(key) === next) this.queues.delete(key)
    }
  }

  async readText(filePath: string): Promise<string> {
    return readFile(this.normalizePath(filePath), 'utf-8')
  }

  async writeText(filePath: string, content: string, options: SafeWriteOptions = {}): Promise<void> {
    await this.withLock(filePath, () => this.writeTextUnlocked(filePath, content, options))
  }

  async updateText<T = void>(filePath: string, updater: TextUpdater<T>, options: SafeWriteOptions = {}): Promise<T | undefined> {
    return this.withLock(filePath, async () => {
      let current = ''
      try {
        current = await this.readText(filePath)
      } catch (err: any) {
        if (err?.code !== 'ENOENT') throw err
      }

      const updated = await updater(current)
      const content = isTextUpdateResult<T>(updated) ? updated.content : updated
      await this.writeTextUnlocked(filePath, content, options)
      return isTextUpdateResult<T>(updated) ? updated.result : undefined
    })
  }

  /**
   * Update several text files under one in-process lock boundary. Paths are
   * locked in sorted order to avoid deadlocks. If one write fails, previously
   * written files are restored from their snapshots before the error escapes.
   */
  async updateTexts<T = void>(
    filePaths: string[],
    updater: MultiTextUpdater<T>,
    options: SafeWriteOptions = { backup: true },
  ): Promise<T | undefined> {
    const paths = [...new Set(filePaths.map(path => this.normalizePath(path)))].sort()
    const withLocks = async (index: number, task: () => Promise<T | undefined>): Promise<T | undefined> => {
      if (index >= paths.length) return task()
      return this.withLock(paths[index], () => withLocks(index + 1, task))
    }

    return withLocks(0, async () => {
      const current: MultiTextUpdate = {}
      for (const path of paths) {
        try {
          current[path] = await readFile(path, 'utf-8')
        } catch (err: any) {
          if (err?.code !== 'ENOENT') throw err
          current[path] = undefined
        }
      }

      const updated = await updater(Object.freeze({ ...current }))
      const files = isMultiTextUpdateResult<T>(updated) ? updated.files : updated
      for (const path of Object.keys(files)) {
        if (!paths.includes(this.normalizePath(path))) {
          throw new Error(`Multi-file update attempted an unlocked path: ${path}`)
        }
      }

      const written: string[] = []
      try {
        for (const path of paths) {
          if (!Object.hasOwn(files, path)) continue
          const next = files[path]
          if (next === undefined) {
            await rm(path, { force: true })
          } else {
            await this.writeTextUnlocked(path, next, options)
          }
          written.push(path)
        }
      } catch (error) {
        for (const path of written.reverse()) {
          const original = current[path]
          if (original === undefined) await rm(path, { force: true }).catch(() => undefined)
          else await this.writeTextUnlocked(path, original, {}).catch(() => undefined)
        }
        throw error
      }
      return isMultiTextUpdateResult<T>(updated) ? updated.result : undefined
    })
  }

  async readYaml(filePath: string): Promise<Record<string, any>> {
    try {
      const raw = await this.readText(filePath)
      return (YAML.load(raw, { json: true }) as Record<string, any>) || {}
    } catch (err: any) {
      if (err?.code === 'ENOENT') return {}
      throw err
    }
  }

  async writeYaml(filePath: string, data: Record<string, any>, options: SafeYamlOptions = {}): Promise<void> {
    const yamlStr = YAML.dump(data, {
      lineWidth: -1,
      noRefs: true,
      quotingType: '"',
      ...(options.dumpOptions || {}),
    })
    await this.writeText(filePath, yamlStr, options)
  }

  async updateYaml<T = void>(filePath: string, updater: YamlUpdater<T>, options: SafeYamlOptions = {}): Promise<T | undefined> {
    return this.withLock(filePath, async () => {
      let raw = ''
      try {
        raw = await this.readText(filePath)
      } catch (err: any) {
        if (err?.code !== 'ENOENT') throw err
      }
      const current = raw ? ((YAML.load(raw, { json: true }) as Record<string, any>) || {}) : {}
      const updated = await updater(current)
      const data = isYamlUpdateResult<T>(updated) ? updated.data : updated
      if (isYamlUpdateResult<T>(updated) && updated.write === false) {
        return updated.result
      }
      const yamlStr = YAML.dump(data, {
        lineWidth: -1,
        noRefs: true,
        quotingType: '"',
        ...(options.dumpOptions || {}),
      })
      await this.writeTextUnlocked(filePath, yamlStr, options)
      return isYamlUpdateResult<T>(updated) ? updated.result : undefined
    })
  }

  private async writeTextUnlocked(filePath: string, content: string, options: SafeWriteOptions): Promise<void> {
    const target = this.normalizePath(filePath)
    const dir = dirname(target)
    const temp = `${target}.tmp.${process.pid}.${Date.now()}.${randomUUID()}`

    await mkdir(dir, { recursive: true })
    if (options.backup) {
      try {
        await copyFile(target, options.backupPath || `${target}.bak`)
      } catch (err: any) {
        if (err?.code === 'ENOENT') {
          // Continue without a backup when the target does not exist yet.
        } else if (!options.backupPath && shouldUseFallbackBackup(err)) {
          await copyFile(target, `${target}.bak.${Date.now()}.${randomUUID()}`)
        } else {
          throw err
        }
      }
    }

    try {
      await writeFile(temp, content, 'utf-8')
      await rename(temp, target)
    } catch (err) {
      await rm(temp, { force: true }).catch(() => undefined)
      throw err
    }
  }
}

export const safeFileStore = new SafeFileStore()

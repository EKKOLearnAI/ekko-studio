import { homedir } from 'node:os'
import { join, win32 } from 'node:path'

/**
 * Cursor CLI 官方安装脚本写入的目录。
 * Windows 安装脚本会把目录写入用户级 PATH，但已经启动的 Studio 进程拿不到更新后的
 * PATH，因此检测和启动时需要显式补上这些目录。
 */
export function cursorCliBinPaths(env: NodeJS.ProcessEnv = process.env): string[] {
  if (process.platform === 'win32') {
    return [
      env.LOCALAPPDATA && win32.join(env.LOCALAPPDATA, 'cursor-agent'),
      env.USERPROFILE && win32.join(env.USERPROFILE, '.local', 'bin'),
    ].filter((path): path is string => Boolean(path))
  }
  return [join(homedir(), '.local', 'bin')]
}

import { execFile, execFileSync } from 'child_process'
import { existsSync, readFileSync, realpathSync } from 'fs'
import { readdir, readFile } from 'fs/promises'
import { homedir } from 'os'
import { basename, delimiter, dirname, isAbsolute, join, resolve } from 'path'
import { promisify } from 'util'
import { getHermesBin } from '../runtime/path'
import { getHermesBaseDir, getProfileDir } from '../profiles/profile'

const execFileAsync = promisify(execFile)
const SUBSYSTEMS = new Set(['memory', 'skills'])
const PENDING_ID_RE = /^[A-Za-z0-9_-]{1,80}$/
const WRITE_GATE_REQUIRED_FILES = [
  join('tools', 'write_approval.py'),
  join('hermes_cli', 'write_approval_commands.py'),
]
const WRITE_GATE_IMPORT_CHECK = 'import tools.write_approval; import hermes_cli.write_approval_commands'

export type WriteGateSubsystem = 'memory' | 'skills'

export interface PendingWriteRecord {
  id: string
  subsystem: WriteGateSubsystem
  action: string
  summary: string
  origin: string
  created_at: number | null
  payload: Record<string, any>
}

export interface PendingWritesResponse {
  records: PendingWriteRecord[]
  counts: Record<WriteGateSubsystem, number>
  supported: boolean
}

export interface PendingWriteReviewNote {
  type: 'patchOldStringMissing' | 'currentReadFailed' | 'deleteSkill' | 'removeFile'
  targetLabel?: string
  skillName?: string
}

export interface PendingWriteReview {
  subsystem: WriteGateSubsystem
  targetLabel: string
  language: string
  current: string
  proposed: string
  diff: string
  requestedOldString?: string
  payloadText?: string
  notes: PendingWriteReviewNote[]
}

export interface PendingWriteActionResult {
  success: boolean
  output: string
}

interface PythonActionResult {
  output: string
  success?: boolean
}

const pendingWriteActionQueues = new Map<string, Promise<unknown>>()

const PYTHON_HELPER = String.raw`
import json
import os
import sys

agent_root, subsystem, action, pending_id = sys.argv[1:5]
if agent_root and agent_root not in sys.path:
    sys.path.insert(0, agent_root)

from tools import write_approval as wa
from hermes_cli.write_approval_commands import handle_pending_subcommand

if subsystem == "memory":
    wa_subsystem = wa.MEMORY
elif subsystem == "skills":
    wa_subsystem = wa.SKILLS
else:
    raise SystemExit(f"invalid subsystem: {subsystem}")

if action == "diff":
    rec = wa.get_pending(wa_subsystem, pending_id)
    if not rec:
        raise SystemExit(f"No pending {subsystem} write with id '{pending_id}'.")
    if subsystem == "skills":
        import difflib
        from pathlib import Path

        def language_for(path):
            suffix = Path(path or "").suffix.lower()
            return {
                ".md": "markdown",
                ".markdown": "markdown",
                ".py": "python",
                ".ts": "typescript",
                ".tsx": "tsx",
                ".js": "javascript",
                ".jsx": "jsx",
                ".json": "json",
                ".yaml": "yaml",
                ".yml": "yaml",
                ".sh": "bash",
            }.get(suffix, "")

        def skill_review(record):
            payload = record.get("payload", {})
            action_name = payload.get("action", "")
            name = payload.get("name", "")
            notes = []
            target_label = "SKILL.md"
            current = ""
            proposed = ""
            requested_old_string = ""

            try:
                from tools.skill_manager_tool import _find_skill
                found = _find_skill(name)
            except Exception:
                found = None

            base = found["path"] if found else None
            if action_name == "create":
                proposed = payload.get("content") or ""
            elif action_name == "delete":
                if base:
                    p = base / "SKILL.md"
                    if p.exists():
                        try:
                            current = p.read_text(encoding="utf-8")
                        except Exception:
                            notes.append({"type": "currentReadFailed", "targetLabel": "SKILL.md"})
                notes.append({"type": "deleteSkill", "skillName": name})
            else:
                if action_name in {"patch", "write_file", "remove_file"}:
                    target_label = payload.get("file_path") or "SKILL.md"
                p = (base / target_label) if base else None
                if p and p.exists():
                    try:
                        current = p.read_text(encoding="utf-8")
                    except Exception:
                        notes.append({"type": "currentReadFailed", "targetLabel": target_label})

                if action_name == "edit":
                    proposed = payload.get("content") or ""
                elif action_name == "patch":
                    old_s = payload.get("old_string") or ""
                    new_s = payload.get("new_string") or ""
                    replace_all = bool(payload.get("replace_all"))
                    if current and old_s and old_s in current:
                        proposed = current.replace(old_s, new_s) if replace_all else current.replace(old_s, new_s, 1)
                    else:
                        proposed = current
                        notes.append({"type": "patchOldStringMissing", "targetLabel": target_label})
                        requested_old_string = old_s
                elif action_name == "write_file":
                    proposed = payload.get("file_content") or ""
                elif action_name == "remove_file":
                    proposed = ""
                    notes.append({"type": "removeFile", "targetLabel": target_label, "skillName": name})
                else:
                    proposed = current

            diff = "".join(difflib.unified_diff(
                current.splitlines(keepends=True),
                proposed.splitlines(keepends=True),
                fromfile=f"a/{target_label}",
                tofile=f"b/{target_label}",
            ))

            return {
                "subsystem": "skills",
                "targetLabel": target_label,
                "language": language_for(target_label),
                "current": current,
                "proposed": proposed,
                "diff": diff,
                "requestedOldString": requested_old_string,
                "notes": notes,
            }

        output = json.dumps(skill_review(rec), ensure_ascii=False)
    else:
        payload_text = json.dumps(rec.get("payload", {}), ensure_ascii=False, indent=2)
        output = json.dumps({
            "subsystem": "memory",
            "targetLabel": "memory",
            "language": "json",
            "current": "",
            "proposed": payload_text,
            "diff": payload_text,
            "payloadText": payload_text,
            "notes": [],
        }, ensure_ascii=False)
elif action in {"approve", "reject"}:
    pending_before = wa.get_pending(wa_subsystem, pending_id)
    memory_store = None
    if subsystem == "memory" and action == "approve":
        from tools.memory_tool import MemoryStore
        memory_store = MemoryStore()
        memory_store.load_from_disk()
    output = handle_pending_subcommand(
        wa_subsystem,
        [action, pending_id],
        memory_store=memory_store,
    )
    success = pending_before is not None and wa.get_pending(wa_subsystem, pending_id) is None
else:
    raise SystemExit(f"invalid action: {action}")

result = {"output": output}
if action in {"approve", "reject"}:
    result["success"] = success
print(json.dumps(result, ensure_ascii=False))
`

function assertSubsystem(value: string): asserts value is WriteGateSubsystem {
  if (!SUBSYSTEMS.has(value)) throw new Error('Invalid write gate subsystem')
}

function assertPendingId(value: string): void {
  if (!PENDING_ID_RE.test(value)) throw new Error('Invalid pending write id')
}

function pendingDir(profile: string, subsystem: WriteGateSubsystem): string {
  return join(getProfileDir(profile || 'default'), 'pending', subsystem)
}

function hasWriteGateSupportFiles(agentRoot: string): boolean {
  return WRITE_GATE_REQUIRED_FILES.every(relativePath => existsSync(join(agentRoot, relativePath)))
}

function normalizeRecord(raw: any, subsystem: WriteGateSubsystem, fallbackId: string): PendingWriteRecord | null {
  const id = typeof raw?.id === 'string' && raw.id.trim() ? raw.id.trim() : fallbackId
  if (!PENDING_ID_RE.test(id)) return null
  return {
    id,
    subsystem,
    action: typeof raw?.action === 'string' ? raw.action : '',
    summary: typeof raw?.summary === 'string' ? raw.summary : '',
    origin: typeof raw?.origin === 'string' ? raw.origin : 'foreground',
    created_at: typeof raw?.created_at === 'number' && Number.isFinite(raw.created_at) ? raw.created_at : null,
    payload: raw?.payload && typeof raw.payload === 'object' && !Array.isArray(raw.payload) ? raw.payload : {},
  }
}

async function listPendingFor(profile: string, subsystem: WriteGateSubsystem): Promise<PendingWriteRecord[]> {
  const dir = pendingDir(profile, subsystem)
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return []
  }

  const records: PendingWriteRecord[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const fallbackId = entry.slice(0, -'.json'.length)
    if (!PENDING_ID_RE.test(fallbackId)) continue
    try {
      const raw = JSON.parse(await readFile(join(dir, entry), 'utf-8'))
      const record = normalizeRecord(raw, subsystem, fallbackId)
      if (record) records.push(record)
    } catch {
      // Skip unreadable records, matching Hermes Agent's pending list behavior.
    }
  }
  return records.sort((a, b) => (a.created_at || 0) - (b.created_at || 0))
}

export async function listPendingWrites(profile: string): Promise<PendingWritesResponse> {
  const [memory, skills] = await Promise.all([
    listPendingFor(profile, 'memory'),
    listPendingFor(profile, 'skills'),
  ])
  return {
    records: [...memory, ...skills].sort((a, b) => (a.created_at || 0) - (b.created_at || 0)),
    counts: {
      memory: memory.length,
      skills: skills.length,
    },
    supported: isWriteGateSupported(),
  }
}

export function isWriteGateSupported(): boolean {
  return Boolean(tryResolveAgentRoot()) || hasWriteGatePythonImports()
}

function pathCandidates(command: string): string[] {
  if (isAbsolute(command) || command.includes('/')) return [command]
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';')
    : ['']
  return (process.env.PATH || '')
    .split(delimiter)
    .filter(Boolean)
    .flatMap(dir => extensions.map(ext => join(dir, `${command}${ext}`)))
}

function pythonFromShebang(file: string): string | null {
  try {
    const real = realpathSync(file)
    const firstLine = readFileSync(real, 'utf-8').split(/\r?\n/, 1)[0] || ''
    if (!firstLine.startsWith('#!')) return null
    const command = firstLine.slice(2).trim().split(/\s+/)
    if (command[0]?.endsWith('/env') && command[1]) return command[1]
    return command[0] || null
  } catch {
    return null
  }
}

function hermesShebangPython(): string | null {
  for (const candidate of pathCandidates(getHermesBin())) {
    if (!existsSync(candidate)) continue
    const python = pythonFromShebang(candidate)
    if (python) return python
  }
  return null
}

function agentRootFromPython(python: string | null): string {
  if (!python || !isAbsolute(python)) return ''
  const candidates: string[] = []
  const addCandidate = (pythonPath: string) => {
    const binDir = dirname(pythonPath)
    const venvDir = dirname(binDir)
    if (basename(venvDir) === 'venv') candidates.push(dirname(venvDir))
  }
  addCandidate(python)
  try {
    addCandidate(realpathSync(python))
  } catch {}
  return candidates.find(hasWriteGateSupportFiles) || candidates[0] || ''
}

function agentRootFromHermesBin(): string {
  for (const candidate of pathCandidates(getHermesBin())) {
    if (!existsSync(candidate)) continue
    try {
      const real = realpathSync(candidate)
      const binDir = dirname(real)
      const candidates = [
        resolve(binDir, '..', '..'),
        resolve(binDir, '..'),
      ]
      const root = candidates.find(hasWriteGateSupportFiles)
      if (root) return root
    } catch {}
  }
  return ''
}

function agentRootCandidates(): string[] {
  const shebangPython = hermesShebangPython()
  return [
    process.env.HERMES_AGENT_ROOT?.trim() || '',
    join(getHermesBaseDir(), 'hermes-agent'),
    join(homedir(), '.hermes', 'hermes-agent'),
    agentRootFromHermesBin(),
    agentRootFromPython(shebangPython),
  ].filter(Boolean)
}

function tryResolveAgentRoot(): string {
  for (const candidate of agentRootCandidates()) {
    if (hasWriteGateSupportFiles(candidate)) return resolve(candidate)
  }
  return ''
}

function resolveAgentRoot(): string {
  const agentRoot = tryResolveAgentRoot()
  if (agentRoot) return agentRoot
  throw new Error('Hermes Agent source not found. Set HERMES_AGENT_ROOT to enable write approval actions.')
}

function resolveHermesPython(agentRoot?: string): string {
  const envPython = process.env.HERMES_AGENT_CLI_PYTHON?.trim()
  if (envPython) return envPython

  if (agentRoot) {
    const venvPython = process.platform === 'win32'
      ? join(agentRoot, 'venv', 'Scripts', 'python.exe')
      : join(agentRoot, 'venv', 'bin', 'python3')
    if (existsSync(venvPython)) return venvPython
  }

  const shebangPython = hermesShebangPython()
  if (shebangPython && !/[/\\](?:sh|bash|zsh|fish|cmd|powershell|pwsh)(?:\.exe)?$/i.test(shebangPython)) return shebangPython

  return process.platform === 'win32' ? 'python' : 'python3'
}

function hasWriteGatePythonImports(): boolean {
  const agentRoot = tryResolveAgentRoot()
  const python = resolveHermesPython(agentRoot)
  const pythonPath = [agentRoot, process.env.PYTHONPATH || ''].filter(Boolean).join(delimiter)
  try {
    execFileSync(
      python,
      ['-c', WRITE_GATE_IMPORT_CHECK],
      {
        env: {
          ...process.env,
          ...(pythonPath ? { PYTHONPATH: pythonPath } : {}),
        },
        timeout: 5000,
        stdio: 'ignore',
        windowsHide: true,
      },
    )
    return true
  } catch {
    return false
  }
}

async function runPythonAction(
  profile: string,
  subsystem: WriteGateSubsystem,
  action: 'approve' | 'reject' | 'diff',
  pendingId: string,
): Promise<PythonActionResult> {
  assertSubsystem(subsystem)
  assertPendingId(pendingId)
  if (!isWriteGateSupported()) {
    throw new Error('Hermes Agent write approval is not supported by the installed Hermes Agent version.')
  }
  const agentRoot = tryResolveAgentRoot()
  const python = resolveHermesPython(agentRoot)
  const profileDir = getProfileDir(profile || 'default')
  const pythonPath = [agentRoot, process.env.PYTHONPATH || ''].filter(Boolean).join(delimiter)
  const { stdout } = await execFileAsync(
    python,
    ['-c', PYTHON_HELPER, agentRoot, subsystem, action, pendingId],
    {
      env: {
        ...process.env,
        HERMES_HOME: profileDir,
        PYTHONPATH: pythonPath,
      },
      timeout: 60_000,
      maxBuffer: 10 * 1024 * 1024,
      windowsHide: true,
    },
  )
  const parsed = JSON.parse(String(stdout || '{}'))
  return {
    output: typeof parsed.output === 'string' ? parsed.output : '',
    success: typeof parsed.success === 'boolean' ? parsed.success : undefined,
  }
}

export async function getPendingWriteDiff(profile: string, subsystem: string, pendingId: string): Promise<string> {
  return (await getPendingWriteReview(profile, subsystem, pendingId)).diff
}

export async function getPendingWriteReview(profile: string, subsystem: string, pendingId: string): Promise<PendingWriteReview> {
  assertSubsystem(subsystem)
  const { output } = await runPythonAction(profile, subsystem, 'diff', pendingId)
  try {
    const parsed = JSON.parse(output)
    return normalizePendingWriteReview(parsed, subsystem)
  } catch {
    return {
      subsystem,
      targetLabel: subsystem,
      language: subsystem === 'memory' ? 'json' : '',
      current: '',
      proposed: output,
      diff: output,
      payloadText: subsystem === 'memory' ? output : undefined,
      notes: [],
    }
  }
}

function serializePendingWriteAction<T>(profile: string, action: () => Promise<T>): Promise<T> {
  // Serialize by the resolved state directory so aliases that fall back to
  // the same profile cannot launch competing Python writers.
  const key = getProfileDir(profile || 'default')
  const previous = pendingWriteActionQueues.get(key) || Promise.resolve()
  const current = previous.catch(() => undefined).then(action)
  pendingWriteActionQueues.set(key, current)
  return current.finally(() => {
    if (pendingWriteActionQueues.get(key) === current) {
      pendingWriteActionQueues.delete(key)
    }
  })
}

async function resolvePendingWrite(
  profile: string,
  subsystem: string,
  action: 'approve' | 'reject',
  pendingId: string,
): Promise<PendingWriteActionResult> {
  assertSubsystem(subsystem)
  assertPendingId(pendingId)
  return serializePendingWriteAction(profile, async () => {
    const result = await runPythonAction(profile, subsystem, action, pendingId)
    return {
      success: result.success === true && result.output.trim().length > 0,
      output: result.output,
    }
  })
}

export async function approvePendingWrite(
  profile: string,
  subsystem: string,
  pendingId: string,
): Promise<PendingWriteActionResult> {
  return resolvePendingWrite(profile, subsystem, 'approve', pendingId)
}

export async function rejectPendingWrite(
  profile: string,
  subsystem: string,
  pendingId: string,
): Promise<PendingWriteActionResult> {
  return resolvePendingWrite(profile, subsystem, 'reject', pendingId)
}

function normalizePendingWriteReview(raw: any, subsystem: WriteGateSubsystem): PendingWriteReview {
  const notes = Array.isArray(raw?.notes)
    ? raw.notes
        .filter((note: any) => note && typeof note === 'object' && typeof note.type === 'string')
        .map((note: any) => ({
          type: note.type,
          targetLabel: typeof note.targetLabel === 'string' ? note.targetLabel : undefined,
          skillName: typeof note.skillName === 'string' ? note.skillName : undefined,
        }))
    : []
  return {
    subsystem,
    targetLabel: typeof raw?.targetLabel === 'string' && raw.targetLabel ? raw.targetLabel : subsystem,
    language: typeof raw?.language === 'string' ? raw.language : '',
    current: typeof raw?.current === 'string' ? raw.current : '',
    proposed: typeof raw?.proposed === 'string' ? raw.proposed : '',
    diff: typeof raw?.diff === 'string' ? raw.diff : '',
    requestedOldString: typeof raw?.requestedOldString === 'string' ? raw.requestedOldString : undefined,
    payloadText: typeof raw?.payloadText === 'string' ? raw.payloadText : undefined,
    notes: notes.filter((note: PendingWriteReviewNote) =>
      note.type === 'patchOldStringMissing' ||
      note.type === 'currentReadFailed' ||
      note.type === 'deleteSkill' ||
      note.type === 'removeFile'),
  }
}

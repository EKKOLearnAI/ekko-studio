import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const STUB = join(tmpdir(), 'ekko-studio-shell-relay-v1.exe')
const SOURCE = join(tmpdir(), 'ekko-studio-shell-relay-v1.cs')
const RUNNER = join(tmpdir(), 'ekko-studio-shell-relay-v1.sh')
const COMPILER = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe'
const BASH_CANDIDATES = [
  'C:\\Program Files\\Git\\bin\\bash.exe',
  'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
]

const RUNNER_SCRIPT = `#!/bin/sh
args_file=$1
script=$2
if command -v cygpath >/dev/null 2>&1; then
  args_file=$(cygpath -u "$args_file")
  script=$(cygpath -u "$script")
  if [ -n "$HERMES_HOME" ]; then
    HERMES_HOME=$(cygpath -u "$HERMES_HOME")
    export HERMES_HOME
  fi
fi
set --
while IFS= read -r -d '' arg; do
  set -- "$@" "$arg"
done < "$args_file"
exec "$script" "$@"
`

function bashPath(): string {
  const found = BASH_CANDIDATES.find(candidate => existsSync(candidate))
  if (!found) throw new Error('Git Bash is required to execute POSIX Python fixtures on Windows')
  return found
}

function ensureRelay(): void {
  if (!existsSync(RUNNER)) writeFileSync(RUNNER, RUNNER_SCRIPT)
  if (existsSync(STUB)) return
  const program = `using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;

public class ShellRelay {
  public static int Main(string[] args) {
    string exe = Environment.GetCommandLineArgs()[0];
    string script = Path.Combine(Path.GetDirectoryName(exe), Path.GetFileNameWithoutExtension(exe));
    string argsFile = script + ".args";
    using (var stream = File.Create(argsFile)) {
      foreach (string arg in args) {
        byte[] bytes = Encoding.UTF8.GetBytes(arg);
        stream.Write(bytes, 0, bytes.Length);
        stream.WriteByte(0);
      }
    }

    var start = new ProcessStartInfo();
    start.FileName = "${bashPath().replace(/\\/g, '\\\\')}";
    start.Arguments = "\\"${RUNNER.replace(/\\/g, '\\\\')}\\" \\"" + argsFile + "\\" \\"" + script + "\\"";
    start.UseShellExecute = false;
    start.RedirectStandardOutput = true;
    start.RedirectStandardError = true;
    start.CreateNoWindow = true;
    var process = Process.Start(start);
    Task<string> error = Task.Run(() => process.StandardError.ReadToEnd());
    string output = process.StandardOutput.ReadToEnd();
    error.Wait();
    process.WaitForExit();
    Console.OutputEncoding = Encoding.UTF8;
    Console.Out.Write(output);
    return process.ExitCode;
  }
}
`
  writeFileSync(SOURCE, program)
  execFileSync(COMPILER, ['/nologo', '/t:exe', `/out:${STUB}`, SOURCE], { windowsHide: true })
}

export function materializeShellExecutable(scriptPath: string): string {
  if (process.platform !== 'win32') return scriptPath
  ensureRelay()
  const exePath = /\.exe$/i.test(scriptPath) ? scriptPath : `${scriptPath}.exe`
  copyFileSync(STUB, exePath)
  return exePath
}

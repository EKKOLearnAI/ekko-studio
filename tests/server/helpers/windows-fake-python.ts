import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const STUB = join(tmpdir(), 'ekko-studio-fake-python-v1.exe')
const SOURCE = join(tmpdir(), 'ekko-studio-fake-python-v1.cs')
const COMPILER = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe'

const PROGRAM = `using System;
using System.IO;

public class FakePython {
  public static int Main(string[] args) {
    string capture = Environment.GetEnvironmentVariable("CAPTURE_FILE");
    if (!string.IsNullOrEmpty(capture)) {
      string command = Environment.GetCommandLineArgs()[0];
      string first = args.Length > 0 ? args[0] : "";
      string second;
      string fourth;
      if (first == "-I") {
        second = args.Length > 1 ? args[1] : "";
        fourth = Environment.GetEnvironmentVariable("HERMES_AGENT_ROOT_RESOLVED") ?? "";
      } else {
        string pythonPath = Environment.GetEnvironmentVariable("PYTHONPATH");
        string pythonHome = Environment.GetEnvironmentVariable("PYTHONHOME");
        second = string.IsNullOrEmpty(pythonPath) ? "unset" : pythonPath;
        fourth = string.IsNullOrEmpty(pythonHome) ? "unset" : pythonHome;
      }
      File.WriteAllText(capture, command + "\\n" + first + "\\n" + second + "\\n" + fourth + "\\n");
    }

    string pluginJson = Environment.GetEnvironmentVariable("PLUGIN_JSON");
    if (string.IsNullOrEmpty(pluginJson)) {
      pluginJson = "{\\"plugins\\":[],\\"warnings\\":[],\\"metadata\\":{\\"hermesAgentRoot\\":\\"\\",\\"pythonExecutable\\":\\"\\",\\"cwd\\":\\"\\",\\"projectPluginsEnabled\\":false}}";
    }
    Console.Out.Write(pluginJson);
    Console.Out.Write("\\n");
    return 0;
  }
}
`

function ensureStub(): string {
  if (!existsSync(STUB)) {
    writeFileSync(SOURCE, PROGRAM)
    execFileSync(COMPILER, ['/nologo', '/t:exe', `/out:${STUB}`, SOURCE], { windowsHide: true })
  }
  return STUB
}

export function materializeFakePython(scriptPath: string): string {
  if (process.platform !== 'win32') return scriptPath
  const exePath = /\.exe$/i.test(scriptPath) ? scriptPath : `${scriptPath}.exe`
  copyFileSync(ensureStub(), exePath)
  return exePath
}

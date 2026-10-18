// The root CI installs Web UI dependencies only. Portal protocol tests provide an explicit bus fixture.
export function sessionBus(): never {
  throw new Error('Screenshot Portal tests must provide their D-Bus fixture')
}

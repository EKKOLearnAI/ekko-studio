type CuaSdk = typeof import('@trycua/cua-driver')

// Preserve native import() in standalone CommonJS and the bundled server.
// TypeScript's CommonJS transform would emit require(), which the SDK's
// ESM-only exports do not support. The import specifier is fixed.
const importSdk = new Function('return import("@trycua/cua-driver")') as () => Promise<CuaSdk>

export async function loadComputerUseSdk(): Promise<CuaSdk> {
  try {
    return await importSdk()
  } catch (error) {
    throw new Error(`CUA_SDK_UNAVAILABLE: ${error instanceof Error ? error.message : String(error)}. Cua's native library is installed with Ekko Agent; no separate cua-driver executable is needed. Reinstall the application, or run npm install --include=optional for a source installation. Check that the OS/architecture and system desktop libraries are supported.`)
  }
}

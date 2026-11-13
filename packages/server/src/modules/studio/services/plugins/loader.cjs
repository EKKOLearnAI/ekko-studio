// JavaScript keeps native import intact under ts-node's CommonJS transform.
exports.importPlugin = (specifier) => import(/* @vite-ignore */ specifier)

/**
 * DSH identifies a model choice with the opaque value produced by
 * `JSON.stringify([provider, model])` and rejects anything else with
 * "unknown model option". Global-mode sessions store and re-send the bare model
 * name, so translate it back with the choices the ACP session just advertised
 * instead of forwarding a value DSH cannot resolve.
 */
export function resolveDshModelValue(configOptions: any[] | undefined, requested: string): string {
  const selector = (configOptions || []).find(option => option && (option.id === 'model' || option.category === 'model'))
  const choices: string[] = []
  for (const entry of selector?.options || []) {
    // Selectors either list choices directly or group them per provider.
    for (const choice of Array.isArray(entry?.options) ? entry.options : [entry]) {
      if (typeof choice?.value === 'string') choices.push(choice.value)
    }
  }
  // An explicit provider/model value is already valid; keep it byte-identical.
  if (choices.includes(requested)) return requested
  const named = choices.filter(value => modelName(value) === requested)
  if (named.length === 0) return requested
  if (named.length === 1) return named[0]
  // One model id can be served by several providers; the active one is the choice.
  const current: unknown = selector?.currentValue
  return named.find(value => value === current) || requested
}

/** The model id encoded in a selector value; opaque values carry none. */
function modelName(value: string): string | undefined {
  try {
    const [, name] = JSON.parse(value)
    return typeof name === 'string' ? name : undefined
  } catch { return undefined }
}

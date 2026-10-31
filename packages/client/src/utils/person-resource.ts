/** Pick only an authorized catalog entry; prefer a resource with usable models. */
export function defaultPersonResource(profiles: string[], groups: Array<{ profile: string; models: string[] }>, current = 'default') {
  const allowed = profiles.filter(name => name && !name.startsWith('.'))
  const usable = allowed.filter(name => groups.some(group => group.profile === name && group.models.length > 0))
  return usable.find(name => name === current) || usable.find(name => name === 'default') || usable[0]
    || allowed.find(name => name === current) || allowed.find(name => name === 'default') || allowed[0] || ''
}

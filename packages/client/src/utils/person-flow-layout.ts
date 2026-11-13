/** Bots follow one rounded route, including its bends; lines mark node boundaries only. */
export function personFlowLayout(counts: number[], width: number, rtl = false) {
  const size = 32, radius = 32, inset = 20, botSpacing = 52, nodeSpacing = 96
  const left = inset + radius, right = Math.max(left, width - inset - radius)
  const straight = right - left, stride = straight + Math.PI * radius
  function pointAt(distance: number) {
    const row = Math.floor(distance / stride), offset = distance - row * stride
    const forward = (row % 2 === 0) !== rtl
    const y = size / 2 + row * radius * 2
    if (offset < straight) return { x: forward ? left + offset : right - offset, y, row, turn: false, forward }
    const angle = (offset - straight) / radius
    return { x: (forward ? right : left) + (forward ? 1 : -1) * radius * Math.sin(angle),
      y: y + radius * (1 - Math.cos(angle)), row, turn: true, forward }
  }
  function pathBetween(start: number, end: number) {
    const first = pointAt(start)
    let path = `M ${first.x} ${first.y}`, cursor = start
    while (cursor < end - .001) {
      const point = pointAt(cursor + .000001)
      const boundary = point.row * stride + (point.turn ? stride : straight)
      const next = Math.min(end, boundary), target = pointAt(next)
      path += point.turn ? ` A ${radius} ${radius} 0 0 ${point.forward ? 1 : 0} ${target.x} ${target.y}` : ` L ${target.x} ${target.y}`
      cursor = next
    }
    return path
  }
  const nodes: { x: number; y: number; width: number; height: number; row: number; turn: boolean; group: number; distance: number }[] = []
  const edges: { from: number; to: number; source: number; target: number; path: string }[] = []
  let distance = 0
  counts.forEach((count,group) => {
    for (let index = 0; index < count; index++) {
      const previous = nodes.at(-1)
      if (previous) distance += index === 0 ? nodeSpacing : botSpacing
      const point = pointAt(distance)
      if (previous && index === 0) {
        edges.push({ from: previous.group, to: group, source: nodes.length - 1, target: nodes.length,
          path: pathBetween(previous.distance + 24, distance - 24) })
      }
      nodes.push({ x: point.x - size / 2, y: point.y - size / 2, width: size, height: size,
        row: point.row, turn: point.turn, group, distance })
    }
  })
  const height = Math.max(0, ...nodes.map(node => node.y + size))
  return { nodes, edges, height }
}

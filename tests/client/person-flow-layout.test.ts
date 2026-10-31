import { describe, expect, it } from 'vitest'
import { personFlowLayout } from '../../packages/client/src/utils/person-flow-layout'

describe('bot route with parallel nodes', () => {
  it.each([160,226,258,298,410])('turns bots along the route without connecting peers at %ipx', width => {
    for (const counts of [[],[1],[3],[8],[1,3,1,8,1,3,1,1]]) {
      const result = personFlowLayout(counts,width)
      expect(result.nodes).toHaveLength(counts.reduce((sum,count) => sum+count,0))
      expect(result.edges).toHaveLength(Math.max(0,counts.length-1))
      for (const edge of result.edges) {
        expect(edge.to).toBe(edge.from+1)
        expect(result.nodes[edge.source].group).toBe(edge.from)
        expect(result.nodes[edge.target].group).toBe(edge.to)
        expect(edge.target).toBe(edge.source+1)
      }
      for (const [index,node] of result.nodes.entries()) {
        expect(node.x).toBeGreaterThanOrEqual(0)
        expect(node.x+node.width).toBeLessThanOrEqual(width+.01)
        expect(node.y+node.height).toBeLessThanOrEqual(result.height)
        for (const previous of result.nodes.slice(0,index)) {
          const overlaps = node.x < previous.x+previous.width && node.x+node.width > previous.x && node.y < previous.y+previous.height && node.y+node.height > previous.y
          expect(overlaps).toBe(false)
        }
        const next=result.nodes[index+1]
        if (next) expect(next.y).toBeGreaterThanOrEqual(node.y)
      }
    }
  })
  it('mirrors the turning route for RTL without dropping or stacking bots', () => {
    const left=personFlowLayout([1,3,1,8,1,3,1,1],298),right=personFlowLayout([1,3,1,8,1,3,1,1],298,true)
    expect(right.height).toBe(left.height)
    right.nodes.forEach((node,index) => {
      expect(node.x).toBeCloseTo(298-left.nodes[index].x-left.nodes[index].width)
      expect(node.y).toBe(left.nodes[index].y)
    })
  })
  it('places parallel bots on the bend itself and continues in the opposite direction', () => {
    const { nodes,edges }=personFlowLayout([8],298)
    expect(edges).toHaveLength(0)
    expect(nodes.some(node => node.turn && node.y % 64 > 1)).toBe(true)
    const directions=nodes.slice(1).map((node,index) => Math.sign(node.x-nodes[index].x))
    expect(directions).toContain(1)
    expect(directions).toContain(-1)
  })
})

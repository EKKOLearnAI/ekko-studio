import { describe, it, expect } from 'vitest'
import { notificationPreview } from '../../packages/server/src/modules/studio/services/notifications/notification-preview'
describe('notification preview', () => {
 it('accepts chat content and group preview and strips rich text', () => {
  expect(notificationPreview({title:'Chat',content:'**Done** [report](https://example.test)\n```secret```'},true)).toEqual({title:'Chat',body:'Done report'})
  expect(notificationPreview({title:'Group',preview:'hello'},true).body).toBe('hello')
 })
 it('never takes raw errors, prompts, or non-completion body', () => {
  expect(notificationPreview({output:'secret',command:'secret'},true)).toEqual({title:'',body:''})
  expect(notificationPreview({title:'Chat',content:'secret'},false)).toEqual({title:'Chat',body:''})
 })
 it('limits complete graphemes including ellipsis', () => {
  const emoji='👨‍👩‍👧‍👦'
  const result=notificationPreview({title:emoji.repeat(41),content:'字'.repeat(161)},true)
  expect(result.title).toBe(emoji.repeat(39)+'…');expect(result.body).toBe('字'.repeat(159)+'…')
 })
})

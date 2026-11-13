/** Bot appearance is independent of the runtime, model and conversation name. */
function appearance(directory: string, idleCenter: readonly [number, number], thinkingCenter: readonly [number, number], size = 360) {
  return {
    idleFrame: `${directory}/idle.png`,
    // Source-pixel centers of the still and the full working-animation bounds.
    // Position artwork inside its box without changing source files. Keep Zhezhe.
    avatarOffset: { x: (size / 2 - idleCenter[0]) / size, y: (size / 2 - idleCenter[1]) / size },
    thinkingOffset: { x: (size / 2 - thinkingCenter[0]) / size, y: (size / 2 - thinkingCenter[1]) / size },
    animations: {
      idle: `${directory}/idle.gif`, thinking: `${directory}/thinking.gif`,
      searching: `${directory}/searching.gif`, done: `${directory}/done.gif`,
      error: `${directory}/error.gif`, sleeping: `${directory}/sleeping.gif`,
    },
  }
}

function character(type: string, name: string, idleCenter: readonly [number, number], thinkingCenter: readonly [number, number]) {
  const assets = appearance(`/person/${type}`, idleCenter, thinkingCenter)
  return { type, name, avatar: assets.idleFrame, ...assets }
}

export const PERSON_BOTS = [
  { type: 'zhezhe', name: '折折', avatar: '/coding-agents/person.jpg', ...appearance('/person', [120, 120], [120, 120], 240) },
  character('xiaohe', '小鹤', [158, 187], [150.5, 186]),
  character('dachu', '大厨', [158, 186.5], [150.5, 186]),
  character('nuannuan', '暖暖', [155, 186.5], [152, 185.5]),
  character('yingying', '樱樱', [155, 194], [152, 179]),
  character('shuishui', '睡睡', [155, 186.5], [152, 186]),
  character('xiaofei', '小飞', [155, 189], [152, 179]),
  character('youchai', '邮差', [156.5, 188], [153.5, 179.5]),
  character('erji', '耳机', [155, 188.5], [152, 179.5]),
  character('xingxing', '星星', [155, 193], [152, 179]),
  character('paidui', '派对', [155, 186.5], [152, 185.5]),
] as const

export const DEFAULT_PERSON_BOT_TYPE = 'zhezhe'

export function personBotNameKey(name: string) {
  return name.trim().normalize('NFKC').toLowerCase()
}

export function personBot(type: unknown) {
  return PERSON_BOTS.find(bot => bot.type === type)
}

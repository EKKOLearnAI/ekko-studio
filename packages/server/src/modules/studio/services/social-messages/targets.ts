import {
  clearSocialMessageAccountTarget,
  getActiveSocialMessageAccount,
  listSocialMessageAccounts,
  setSocialMessageAccountTarget,
} from '../../repositories/social-message-store'
import type {
  SocialMessagePlatform,
  SocialMessageRecipientType,
} from './types'

export interface SocialMessageTarget {
  platform: SocialMessagePlatform
  recipient: string
  recipientType: SocialMessageRecipientType
  updatedAt: string
}

function targetFromAccount(account: {
  platform: SocialMessagePlatform
  recipient: string
  recipientType: string
  updatedAt: number
}): SocialMessageTarget | undefined {
  if (!account.recipient || !account.recipientType) return undefined
  return {
    platform: account.platform,
    recipient: account.recipient,
    recipientType: account.recipientType as SocialMessageRecipientType,
    updatedAt: new Date(account.updatedAt).toISOString(),
  }
}

export async function readSocialMessageTargets(userId: number): Promise<SocialMessageTarget[]> {
  return listSocialMessageAccounts(userId).flatMap(account => {
    const target = targetFromAccount(account)
    return target ? [target] : []
  })
}

export async function readActiveSocialMessageTarget(userId: number): Promise<SocialMessageTarget | undefined> {
  const account = getActiveSocialMessageAccount(userId)
  return account ? targetFromAccount(account) : undefined
}

export async function saveSocialMessageTarget(
  userId: number,
  input: Pick<SocialMessageTarget, 'platform' | 'recipient' | 'recipientType'>,
): Promise<void> {
  const recipient = input.recipient.trim()
  if (!recipient) throw new Error('A non-empty Social Messages recipient is required')
  const saved = setSocialMessageAccountTarget({
    userId,
    platform: input.platform,
    recipient,
    recipientType: input.recipientType,
    active: true,
  })
  if (!saved) throw new Error(`${input.platform} is not configured`)
}

export async function clearSocialMessageTarget(
  userId: number,
  platform: SocialMessagePlatform,
): Promise<void> {
  clearSocialMessageAccountTarget(userId, platform)
}

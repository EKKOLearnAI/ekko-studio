import { AcpConnection } from '../../../../../../studio-agent-drivers/src/acp/connection'
import { logger } from '../../../studio/public/logging'

/** Compatibility name while native adapters migrate to the independent driver. */
export class NativeAcpTurn extends AcpConnection {
  constructor(child: ConstructorParameters<typeof AcpConnection>[0], callbacks: ConstructorParameters<typeof AcpConnection>[1]) {
    super(child, { ...callbacks, warning: (message, line) => logger.warn({ line }, message) })
  }
}

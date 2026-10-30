import type { InputChannel } from './InputChannel.js'

/**
 * The input channel of a USB-connected iPhone or iPad until it has one of its own. Every write is refused, so a
 * physical device is never handed the simulator's `TouchHelper`, whose writes would drive a simulator instead.
 * `IOSAgent.refusalReason` recognises it and answers `unsupported`.
 */
export class UnavailableInput implements InputChannel {
  start(): void {}
  stop(): void {}
  inputState(): 'ready' | 'starting' | 'unavailable' { return 'unavailable' }
  ownsGesture(): boolean { return false }
  touchStart(): boolean { return false }
  touchMove(): boolean { return false }
  touchEnd(): boolean { return false }
  touchEndAfterMinContact(): Promise<boolean> { return Promise.resolve(false) }
  pinchStart(): boolean { return false }
  pinchMove(): boolean { return false }
  pinchEnd(): boolean { return false }
  sendKey(): boolean { return false }
  pressButton(): boolean { return false }
  pressButtonDown(): boolean { return false }
  pressButtonUp(): boolean { return false }
  pressLegacyButton(): boolean { return false }
}

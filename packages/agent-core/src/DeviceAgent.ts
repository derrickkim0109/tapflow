import type { Device, UIElement } from './types.js'

export interface DeviceAgent {
  listDevices(): Promise<Device[]>
  boot(deviceId: string): Promise<void>
  shutdown(deviceId: string): Promise<void>
  installApp(path: string): Promise<void>
  /**
   * Launch the app. Together with `queryUITree` this carries the contract flow-runner's `launchApp` waits on: after
   * the launch resolves, a tree read either **fails until the app's UI is up** (iOS: the tree is the app's own), or
   * the launch itself **resolved only after the app's first frame** (Android: `am start -W`, or once its 10 s bound ran
   * out, so a reply is not proof that a frame was drawn). An agent that does
   * neither, and answers an empty tree while the app is still starting, makes a flow send its next step to nothing.
   */
  launchApp(bundleId: string): Promise<void>
  screenshot(): Promise<Buffer>
  stream(): ReadableStream<Buffer>
  touchStart(x: number, y: number): void
  touchMove(x: number, y: number): Promise<void>
  touchEnd(): Promise<void>
  openUrl(url: string): Promise<void>
  /** The foreground screen as unified elements. See `launchApp` for what a read must do while an app is starting. */
  queryUITree(): Promise<UIElement[]>
}

export type DeviceAgentConstructor = new () => DeviceAgent

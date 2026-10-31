import { describe, it, expect } from 'vitest'
import { pickAndroidBackend } from '../AndroidAgent'

describe('pickAndroidBackend', () => {
  it('defaults emulators (emulator-* serial) to the gRPC host-encode path', () => {
    expect(pickAndroidBackend('emulator-5554', {})).toBe('grpc')
  })

  it('defaults real devices to scrcpy', () => {
    expect(pickAndroidBackend('39021FDH200ABC', {})).toBe('scrcpy')
  })

  it('honors TAPFLOW_ANDROID_BACKEND=scrcpy on an emulator', () => {
    expect(pickAndroidBackend('emulator-5554', { TAPFLOW_ANDROID_BACKEND: 'scrcpy' })).toBe('scrcpy')
  })

  // Mutation: let `grpc` apply to every serial — a phone's session connects to an emulator's gRPC port and
  // streams and taps that emulator.
  it('keeps a real device on scrcpy under TAPFLOW_ANDROID_BACKEND=grpc', () => {
    expect(pickAndroidBackend('39021FDH200ABC', { TAPFLOW_ANDROID_BACKEND: 'grpc' })).toBe('scrcpy')
  })

  it('honors TAPFLOW_ANDROID_BACKEND=grpc on an emulator', () => {
    expect(pickAndroidBackend('emulator-5554', { TAPFLOW_ANDROID_BACKEND: 'grpc' })).toBe('grpc')
  })
})

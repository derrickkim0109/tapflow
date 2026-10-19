'use client';

import { useState } from 'react';
import type { MutableRefObject } from 'react';
import type { FormFactor } from '@tapflowio/protocol'
import { useFps } from '@/hooks/useFps';
import { useIOSScreen } from '@/hooks/useIOSScreen';
import { useAndroidScreen } from '@/hooks/useAndroidScreen';
import { IOSDeviceScreen } from './IOSDeviceScreen';
import { AndroidDeviceScreen } from './AndroidDeviceScreen';
import { framelessChrome } from '@/lib/framelessChrome';
import { skeletonSize } from '@/lib/deviceSkeleton';
import type { BinaryFrameHandler } from '@/lib/envelope';
import type { AndroidChrome, ChromeData, ChromePayload } from '@/lib/types';
import { iosScreenLayout } from '@/lib/iosScreenLayout';
import { TapMarks } from '@/components/watch/TapMarks';
import { placeOnIosFrame, type WatchMarks } from '@/lib/watchActions';

interface WatchedDeviceProps {
  chrome: ChromePayload | null;
  deviceReady: boolean;
  /** From the device list, for the two decisions the chrome cannot make: which device to draw before
   *  any chrome, and whether an iOS device that sent none by `device:ready` gets the frameless one. */
  platform: string;
  formFactor?: FormFactor;
  binaryFrameHandlerRef: MutableRefObject<BinaryFrameHandler | undefined>;
  /** A recorded video rather than a live stream: no "waiting for frame" — a paused replay has no frames coming. */
  replay?: boolean;
  /** Remounts the screen (a new decoder) when it changes, keeping what this component learned — the stream's size
   *  for a frameless device — so a replay's seek does not redraw the frame at a guessed size first. */
  screenKey?: string | number;
  /** The holder's pointer to draw on the device (A2). The live watch page passes it; a replay does not. */
  marks?: WatchMarks;
}

/**
 * **The device a watcher sees: the screen and nothing that sends.** The same drawing the QA session uses
 * (`IOSDeviceScreen` / `AndroidDeviceScreen`), with none of the controls — no toolbar, no input, no
 * recording. Rotation is the holder's own state and not on the wire, so the device is drawn upright; no
 * AI client rotates today.
 */
export function WatchedDevice({ chrome, deviceReady, platform, formFactor, binaryFrameHandlerRef, replay = false, screenKey, marks }: WatchedDeviceProps) {
  const [streamSize, setStreamSize] = useState<{ width: number; height: number } | null>(null);
  // Choosing which screen to mount is routing, not drawing — the same split `DeviceViewer` makes, and for
  // the same reason: an iOS agent that could not build a frame sends none, and the stream must still show.
  const sentIos = chrome !== null && 'framePng' in chrome ? (chrome as ChromeData) : null;
  const android = chrome !== null && !('framePng' in chrome) ? (chrome as AndroidChrome) : null;
  const ios = sentIos ?? (deviceReady && platform === 'ios' && !android
    // A replay with no recorded chrome draws the picture square-cornered: the rounding is a guess, not the device's.
    ? framelessChrome(streamSize ?? skeletonSize(formFactor, platform), replay ? 0 : undefined)
    : null);

  if (ios) {
    return <WatchedIOS key={screenKey} chrome={ios} formFactor={formFactor} binaryFrameHandlerRef={binaryFrameHandlerRef} onStreamSize={setStreamSize} replay={replay} marks={marks} />;
  }
  if (android) {
    return <WatchedAndroid key={screenKey} chrome={android} deviceReady={deviceReady} binaryFrameHandlerRef={binaryFrameHandlerRef} marks={marks} />;
  }
  return (
    <div aria-hidden="true" style={{ background: '#1c1c1e', borderRadius: '34px', padding: '12px' }}>
      <div data-testid="watch-skeleton" className="animate-pulse bg-zinc-700" style={{ ...skeletonSize(formFactor, platform), borderRadius: '22px' }} />
    </div>
  );
}

function WatchedIOS({ chrome, formFactor, binaryFrameHandlerRef, onStreamSize, replay, marks }: {
  chrome: ChromeData;
  formFactor?: FormFactor;
  binaryFrameHandlerRef: MutableRefObject<BinaryFrameHandler | undefined>;
  onStreamSize: (size: { width: number; height: number }) => void;
  replay: boolean;
  marks?: WatchMarks;
}) {
  const { fps, frameCount } = useFps();
  const screen = useIOSScreen({ chrome, binaryFrameHandlerRef, fps, frameCount, onCanvasResize: onStreamSize });
  // The overlay spans the whole frame on iOS, so a point goes through where the screen sits in it.
  const place = placeOnIosFrame(iosScreenLayout(chrome));
  return (
    <>
      {/* `joined` is what lets the screen say a live stream stalled; a replay is never waiting on one. */}
      <IOSDeviceScreen
        screen={screen} chrome={chrome} formFactor={formFactor} isLandscape={false} joined={!replay} fps={fps}
        overlay={marks ? <TapMarks marks={marks} place={place} /> : undefined}
      />
      {screen.decoderUnsupported && <UnsupportedDecoder />}
    </>
  );
}

function WatchedAndroid({ chrome, deviceReady, binaryFrameHandlerRef, marks }: {
  chrome: AndroidChrome;
  deviceReady: boolean;
  binaryFrameHandlerRef: MutableRefObject<BinaryFrameHandler | undefined>;
  marks?: WatchMarks;
}) {
  const { frameCount } = useFps();
  const screen = useAndroidScreen({
    binaryFrameHandlerRef, frameCount,
    screenWidth: chrome.screenWidth, screenHeight: chrome.screenHeight,
    streamRotation: chrome.streamRotation ?? 0, cornerRadius: chrome.cornerRadius,
    userWantsLandscape: false, rotatePending: false,
  });
  return (
    <>
      {/* The overlay is the screen itself on Android, and a watcher's device is upright — the input's own space. */}
      <AndroidDeviceScreen
        screen={screen} deviceReady={deviceReady} posturePending={false}
        overlay={marks ? <TapMarks marks={marks} place={(x, y) => ({ left: x, top: y })} /> : undefined}
      />
      {screen.decoderUnsupported && <UnsupportedDecoder />}
    </>
  );
}

/** The QA session says this in its status card; a watch page has no card, so it says it here. */
function UnsupportedDecoder() {
  return (
    <p role="status" className="max-w-xs text-sm text-muted-foreground">
      Streaming is not supported in this environment.
    </p>
  );
}

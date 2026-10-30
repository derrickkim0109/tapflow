// device-capture-helper — streams a USB-connected physical iPhone's screen to the agent.
//
// macOS exposes a trusted, unlocked, USB-attached iOS device as an AVFoundation capture device (the one
// QuickTime's "New Movie Recording" uses) once CoreMediaIO's kCMIOHardwarePropertyAllowScreenCaptureDevices
// is set. Capturing from it needs the Camera TCC grant, and a CLI child the agent spawns inherits the
// agent's (ungranted) responsibility: AVCaptureDevice.requestAccess returns false without ever prompting.
// So, like audiotap-helper, this is a .app the agent launches with `open`, which makes it its own
// responsible process; it connects back to a loopback TCP port the agent opened.
//
// Socket, helper → agent:
//   [status:u8]                         once: 0 = capture running, frames follow; otherwise the exit code
//                                       below, after which the helper exits. `open` hides the child's exit
//                                       status from the agent, so this byte is how a failure reaches it.
//   then the screencapture-helper framing:
//     h264: [u32 BE len][flags:u8 (bit0 = IDR)][Annex-B]   (len counts the flags byte)
//     jpeg: [u32 BE len][JPEG]
// Socket, agent → helper: single bytes; 0x01 forces an IDR on the next H.264 frame.
//
// Args: <port> <udid> <fps> <h264|jpeg> [--max-size N] [--name <device name>]
//       --request-permission          prime the Camera prompt and exit (0 granted, 77 denied)
//
// The capture device's uniqueID is NOT the hardware UDID (measured on macOS 26 with an iPhone 16 Pro Max:
// a random-looking UUID that matches neither the UDID nor CoreDevice's identifier, and no CoreMediaIO
// property carries the UDID). So a device is matched by uniqueID == UDID first (dashes ignored, in case a
// macOS version does use it), then by localizedName == --name (the device name devicectl reports), then,
// if exactly one iOS screen device is attached, that one.

import AVFoundation
import CoreMediaIO
import CoreVideo
import CoreGraphics
import ImageIO
import VideoToolbox
import Foundation

let EXIT_OK: Int32 = 0           // also the code when the agent closes the socket (normal stop)
let EXIT_USAGE: Int32 = 64
let EXIT_CONNECT: Int32 = 65
let EXIT_NO_DEVICE: Int32 = 69
let EXIT_SESSION: Int32 = 70
let EXIT_PERMISSION: Int32 = 77

func log(_ s: String) { FileHandle.standardError.write(("device-capture: " + s + "\n").data(using: .utf8)!) }

// MARK: - Permission

/// Resolves the Camera grant, prompting when it has never been asked. Spins the main run loop while the
/// prompt is up, since the completion is delivered off it and the device list needs it too.
func ensureCameraAccess() -> Bool {
    switch AVCaptureDevice.authorizationStatus(for: .video) {
    case .authorized: return true
    case .denied, .restricted: return false
    case .notDetermined: break
    @unknown default: return false
    }
    var answer: Bool?
    AVCaptureDevice.requestAccess(for: .video) { ok in DispatchQueue.main.async { answer = ok } }
    while answer == nil { RunLoop.main.run(until: Date().addingTimeInterval(0.1)) }
    return answer!
}

let rawArgs = Array(CommandLine.arguments.dropFirst())
if rawArgs.contains("--request-permission") {
    let ok = ensureCameraAccess()
    log("camera access \(ok ? "granted" : "denied")")
    exit(ok ? EXIT_OK : EXIT_PERMISSION)
}

// MARK: - Args

var positional: [String] = []
var maxSize = 0
var deviceName: String?
do {
    var i = 0
    while i < rawArgs.count {
        let a = rawArgs[i]
        if a == "--max-size", i + 1 < rawArgs.count { maxSize = max(0, Int(rawArgs[i + 1]) ?? 0); i += 2; continue }
        if a == "--name", i + 1 < rawArgs.count { deviceName = rawArgs[i + 1]; i += 2; continue }
        positional.append(a); i += 1
    }
}
// Plain globals rather than `guard let` bindings: top-level functions below read them, and Swift rejects a
// function capturing a guard-bound top-level name.
let port = positional.count == 4 ? UInt16(positional[0]) ?? 0 : 0
let fps = positional.count == 4 ? Double(positional[2]) ?? 0 : 0
let targetUDID = positional.count == 4 ? positional[1] : ""
let useH264 = positional.count == 4 && positional[3] == "h264"
if port == 0 || fps <= 0 || targetUDID.isEmpty || !(useH264 || positional[3] == "jpeg") {
    log("usage: device-capture-helper <port> <udid> <fps> <h264|jpeg> [--max-size N] [--name NAME] | --request-permission")
    exit(EXIT_USAGE)
}

// MARK: - Socket

signal(SIGPIPE, SIG_IGN) // a write after the agent closed must fail with EPIPE, not kill us silently
let sock = socket(AF_INET, SOCK_STREAM, 0)
guard sock >= 0 else { log("socket() failed"); exit(EXIT_CONNECT) }
do {
    var one: Int32 = 1
    setsockopt(sock, IPPROTO_TCP, TCP_NODELAY, &one, socklen_t(MemoryLayout<Int32>.size))
    var addr = sockaddr_in()
    addr.sin_family = sa_family_t(AF_INET)
    addr.sin_port = port.bigEndian
    addr.sin_addr.s_addr = inet_addr("127.0.0.1")
    let rc = withUnsafePointer(to: &addr) {
        $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(sock, $0, socklen_t(MemoryLayout<sockaddr_in>.size)) }
    }
    guard rc == 0 else { log("connect 127.0.0.1:\(port) failed"); exit(EXIT_CONNECT) }
}

let writeQueue = DispatchQueue(label: "io.tapflow.device-capture.write", qos: .userInitiated)

func writeAll(_ data: Data) -> Bool {
    data.withUnsafeBytes { raw -> Bool in
        var off = 0
        while off < raw.count {
            let n = write(sock, raw.baseAddress! + off, raw.count - off)
            if n <= 0 { return false }
            off += n
        }
        return true
    }
}

func send(_ data: Data) {
    writeQueue.async {
        if !writeAll(data) { log("socket closed by agent, exiting"); exit(EXIT_OK) }
    }
}

/// Report a startup failure to the agent and exit with the same code.
func fail(_ code: Int32, _ message: String) -> Never {
    log(message)
    writeQueue.sync { _ = writeAll(Data([UInt8(code)])) }
    exit(code)
}

func sendFrame(_ payload: Data, keyframe: Bool) {
    var out = Data(capacity: payload.count + 5)
    var len = UInt32(payload.count + (useH264 ? 1 : 0)).bigEndian
    withUnsafeBytes(of: &len) { out.append(contentsOf: $0) }
    if useH264 { out.append(keyframe ? 0x01 : 0x00) }
    out.append(payload)
    send(out)
}

// MARK: - Encoding

let captureQueue = DispatchQueue(label: "io.tapflow.device-capture.capture", qos: .userInitiated)
// Everything below is touched only on captureQueue.
var pendingForceKeyFrame = true
var lastBuffer: CVPixelBuffer?
var lastEmitNs: UInt64 = 0
var h264Session: VTCompressionSession?
var sessionW = 0, sessionH = 0
var transfer: VTPixelTransferSession?
var scaled: CVPixelBuffer?
let minIntervalNs = UInt64(1_000_000_000 / fps * 0.9) // 10% slack so a 30 fps source isn't halved by jitter
let keepAliveNs: UInt64 = 1_000_000_000
let jpegQuality = 0.7
let h264Bitrate = 8_000_000

// Same rule as screencapture-helper: longest side ≤ maxSize, 16-aligned so coded == display for the
// WASM decoder that ignores cropping. maxSize 0 = native.
func targetDims(_ w: Int, _ h: Int) -> (Int, Int) {
    guard maxSize > 0 else { return (w, h) }
    let scale = max(w, h) > maxSize ? Double(maxSize) / Double(max(w, h)) : 1.0
    return (max(16, Int((Double(w) * scale).rounded()) & ~15), max(16, Int((Double(h) * scale).rounded()) & ~15))
}

func scaleIfNeeded(_ src: CVPixelBuffer) -> CVPixelBuffer {
    let w = CVPixelBufferGetWidth(src), h = CVPixelBufferGetHeight(src)
    let (tw, th) = targetDims(w, h)
    if tw == w && th == h { return src }
    if scaled == nil || CVPixelBufferGetWidth(scaled!) != tw || CVPixelBufferGetHeight(scaled!) != th {
        var pb: CVPixelBuffer?
        CVPixelBufferCreate(kCFAllocatorDefault, tw, th, CVPixelBufferGetPixelFormatType(src),
                            [kCVPixelBufferIOSurfacePropertiesKey: [:]] as CFDictionary, &pb)
        scaled = pb
    }
    if transfer == nil { VTPixelTransferSessionCreate(allocator: kCFAllocatorDefault, pixelTransferSessionOut: &transfer) }
    guard let t = transfer, let dst = scaled, VTPixelTransferSessionTransferImage(t, from: src, to: dst) == noErr else { return src }
    return dst
}

let h264OutputCallback: VTCompressionOutputCallback = { _, _, status, _, sampleBuffer in
    guard status == noErr, let sample = sampleBuffer, CMSampleBufferDataIsReady(sample) else { return }
    var keyframe = true
    if let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]],
       let notSync = attachments.first?[kCMSampleAttachmentKey_NotSync] as? Bool {
        keyframe = !notSync
    }
    let startCode: [UInt8] = [0, 0, 0, 1]
    var out = Data()
    if keyframe, let fmt = CMSampleBufferGetFormatDescription(sample) {
        var idx = 0, count = 0
        repeat {
            var ptr: UnsafePointer<UInt8>?
            var size = 0
            guard CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: idx, parameterSetPointerOut: &ptr,
                    parameterSetSizeOut: &size, parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil) == noErr,
                  let p = ptr else { break }
            out.append(contentsOf: startCode)
            out.append(p, count: size)
            idx += 1
        } while idx < count
    }
    guard let block = CMSampleBufferGetDataBuffer(sample) else { return }
    var total = 0
    var dataPtr: UnsafeMutablePointer<Int8>?
    guard CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil, totalLengthOut: &total,
                                      dataPointerOut: &dataPtr) == noErr, let base = dataPtr else { return }
    let bytes = UnsafeRawPointer(base).assumingMemoryBound(to: UInt8.self)
    var off = 0
    while off + 4 <= total {
        let nalLen = Int(UInt32(bytes[off]) << 24 | UInt32(bytes[off + 1]) << 16 | UInt32(bytes[off + 2]) << 8 | UInt32(bytes[off + 3]))
        off += 4
        if nalLen == 0 || off + nalLen > total { break }
        out.append(contentsOf: startCode)
        out.append(bytes + off, count: nalLen)
        off += nalLen
    }
    sendFrame(out, keyframe: keyframe)
}

// Encoder settings ported from screencapture-helper: real-time, no reordering, no frame delay, Baseline,
// 2 s GOP, soft average bitrate, BT.709.
func makeH264Session(_ w: Int, _ h: Int) -> Bool {
    if let old = h264Session { VTCompressionSessionInvalidate(old); h264Session = nil }
    var s: VTCompressionSession?
    let st = VTCompressionSessionCreate(allocator: kCFAllocatorDefault, width: Int32(w), height: Int32(h),
        codecType: kCMVideoCodecType_H264, encoderSpecification: nil, imageBufferAttributes: nil,
        compressedDataAllocator: nil, outputCallback: h264OutputCallback, refcon: nil, compressionSessionOut: &s)
    guard st == noErr, let session = s else { log("VTCompressionSessionCreate failed (\(st))"); return false }
    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxFrameDelayCount, value: NSNumber(value: 0))
    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ProfileLevel, value: kVTProfileLevel_H264_Baseline_AutoLevel)
    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: NSNumber(value: Int(fps) * 2))
    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_MaxKeyFrameIntervalDuration, value: NSNumber(value: 2.0))
    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_AverageBitRate, value: NSNumber(value: h264Bitrate))
    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_ColorPrimaries, value: kCVImageBufferColorPrimaries_ITU_R_709_2)
    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_TransferFunction, value: kCVImageBufferTransferFunction_ITU_R_709_2)
    VTSessionSetProperty(session, key: kVTCompressionPropertyKey_YCbCrMatrix, value: kCVImageBufferYCbCrMatrix_ITU_R_709_2)
    VTCompressionSessionPrepareToEncodeFrames(session)
    h264Session = session
    sessionW = w; sessionH = h
    log("h264 session \(w)x\(h)")
    return true
}

func encodeJPEG(_ buf: CVPixelBuffer) -> Data? {
    CVPixelBufferLockBaseAddress(buf, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(buf, .readOnly) }
    guard let base = CVPixelBufferGetBaseAddress(buf),
          let ctx = CGContext(data: base, width: CVPixelBufferGetWidth(buf), height: CVPixelBufferGetHeight(buf),
              bitsPerComponent: 8, bytesPerRow: CVPixelBufferGetBytesPerRow(buf), space: CGColorSpaceCreateDeviceRGB(),
              bitmapInfo: CGImageAlphaInfo.premultipliedFirst.rawValue | CGBitmapInfo.byteOrder32Little.rawValue),
          let image = ctx.makeImage() else { return nil }
    let out = NSMutableData()
    guard let dest = CGImageDestinationCreateWithData(out, "public.jpeg" as CFString, 1, nil) else { return nil }
    CGImageDestinationAddImage(dest, image, [kCGImageDestinationLossyCompressionQuality: jpegQuality] as CFDictionary)
    return CGImageDestinationFinalize(dest) ? out as Data : nil
}

// captureQueue only.
func emit(_ src: CVPixelBuffer, now: UInt64) {
    lastEmitNs = now
    let buf = scaleIfNeeded(src)
    if !useH264 {
        if let jpeg = encodeJPEG(buf) { sendFrame(jpeg, keyframe: false) }
        return
    }
    let w = CVPixelBufferGetWidth(buf), h = CVPixelBufferGetHeight(buf)
    if h264Session == nil || w != sessionW || h != sessionH {
        guard makeH264Session(w, h) else { return }
        pendingForceKeyFrame = true // a new session (first frame, rotation) must open on an IDR
    }
    var props: CFDictionary?
    if pendingForceKeyFrame {
        props = [kVTEncodeFrameOptionKey_ForceKeyFrame: true] as CFDictionary
        pendingForceKeyFrame = false
    }
    let pts = CMTime(value: CMTimeValue(now / 1000), timescale: 1_000_000)
    VTCompressionSessionEncodeFrame(h264Session!, imageBuffer: buf, presentationTimeStamp: pts, duration: .invalid,
                                    frameProperties: props, sourceFrameRefcon: nil, infoFlagsOut: nil)
}

final class FrameSink: NSObject, AVCaptureVideoDataOutputSampleBufferDelegate {
    var frames = 0
    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        guard let pb = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        if frames == 0 { log("first frame \(CVPixelBufferGetWidth(pb))x\(CVPixelBufferGetHeight(pb))") }
        frames += 1
        lastBuffer = pb
        let now = DispatchTime.now().uptimeNanoseconds
        if now - lastEmitNs < minIntervalNs && !pendingForceKeyFrame { return }
        emit(pb, now: now)
    }
}

// MARK: - Agent → helper commands

Thread.detachNewThread {
    var b = [UInt8](repeating: 0, count: 256)
    while true {
        let n = read(sock, &b, b.count)
        if n <= 0 { log("socket closed by agent, exiting"); exit(EXIT_OK) }
        if b[0..<n].contains(0x01) {
            captureQueue.async {
                pendingForceKeyFrame = true
                // A static screen delivers no new frames, so encode the last one now rather than wait.
                if useH264, let last = lastBuffer { emit(last, now: DispatchTime.now().uptimeNanoseconds) }
            }
        }
    }
}

// MARK: - Device

guard ensureCameraAccess() else {
    fail(EXIT_PERMISSION, "camera access denied — allow device-capture-helper in System Settings › Privacy & Security › Camera")
}

do {
    var prop = CMIOObjectPropertyAddress(
        mSelector: CMIOObjectPropertySelector(kCMIOHardwarePropertyAllowScreenCaptureDevices),
        mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
        mElement: CMIOObjectPropertyElement(kCMIOObjectPropertyElementMain))
    var allow: UInt32 = 1
    let st = CMIOObjectSetPropertyData(CMIOObjectID(kCMIOObjectSystemObject), &prop, 0, nil, UInt32(MemoryLayout<UInt32>.size), &allow)
    if st != 0 { log("enabling screen capture devices failed (\(st))") }
}

func normalize(_ s: String) -> String { s.replacingOccurrences(of: "-", with: "").uppercased() }

func findDevice() -> AVCaptureDevice? {
    let devices = AVCaptureDevice.DiscoverySession(deviceTypes: [.external], mediaType: .muxed, position: .unspecified).devices
    if let d = devices.first(where: { normalize($0.uniqueID) == normalize(targetUDID) }) { return d }
    if let name = deviceName, let d = devices.first(where: { $0.localizedName == name }) { return d }
    let ios = devices.filter { $0.modelID == "iOS Device" }
    if deviceName == nil, ios.count == 1 { return ios[0] }
    return nil
}

// The device list is populated asynchronously on the main run loop after the property is set — 1–2 s.
var device: AVCaptureDevice?
let deadline = Date().addingTimeInterval(10)
while device == nil && Date() < deadline {
    device = findDevice()
    if device == nil { RunLoop.main.run(until: Date().addingTimeInterval(0.25)) }
}
guard let device else {
    let seen = AVCaptureDevice.DiscoverySession(deviceTypes: [.external], mediaType: .muxed, position: .unspecified).devices
        .map { "\($0.localizedName) (\($0.uniqueID))" }.joined(separator: ", ")
    fail(EXIT_NO_DEVICE, "no screen capture device for \(targetUDID)\(deviceName.map { " / \($0)" } ?? "") within 10 s — is it connected by USB, trusted and unlocked? seen: [\(seen)]")
}
log("using \(device.localizedName) (\(device.uniqueID))")

// MARK: - Session

let session = AVCaptureSession()
let sink = FrameSink()
do {
    let input = try AVCaptureDeviceInput(device: device)
    guard session.canAddInput(input) else { fail(EXIT_SESSION, "cannot add device input") }
    session.addInput(input)
} catch {
    fail(EXIT_SESSION, "device input: \(error.localizedDescription)")
}
let output = AVCaptureVideoDataOutput()
output.alwaysDiscardsLateVideoFrames = true
// 420v feeds VideoToolbox without a conversion; JPEG goes through a BGRA CGContext.
output.videoSettings = [kCVPixelBufferPixelFormatTypeKey as String:
    useH264 ? kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange : kCVPixelFormatType_32BGRA]
output.setSampleBufferDelegate(sink, queue: captureQueue)
guard session.canAddOutput(output) else { fail(EXIT_SESSION, "cannot add video output") }
session.addOutput(output)
session.startRunning()
guard session.isRunning else { fail(EXIT_SESSION, "capture session did not start") }
send(Data([0x00]))
log("capturing \(useH264 ? "h264" : "jpeg") at \(fps) fps, max size \(maxSize)")

// The phone sends nothing while its screen is static; re-send the last frame so a viewer that joins or
// drops mid-stream still gets a picture within a second.
let keepAlive = DispatchSource.makeTimerSource(queue: captureQueue)
keepAlive.schedule(deadline: .now() + 1, repeating: 0.25)
keepAlive.setEventHandler {
    let now = DispatchTime.now().uptimeNanoseconds
    if let last = lastBuffer, now - lastEmitNs >= keepAliveNs { emit(last, now: now) }
}
keepAlive.resume()

// Unplugged or untrusted mid-stream: exit so the agent's stream ends instead of freezing on the last frame.
let disconnectObserver = NotificationCenter.default.addObserver(
    forName: AVCaptureDevice.wasDisconnectedNotification, object: device, queue: .main) { _ in
    log("device disconnected, exiting")
    exit(EXIT_NO_DEVICE)
}

signal(SIGTERM) { _ in exit(EXIT_OK) }
dispatchMain()

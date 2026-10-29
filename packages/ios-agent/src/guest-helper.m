// guest-helper — tapflow's one in-simulator process, and the one file its private simulator API lives in.
// Two jobs: input for a simulator with more than one integrated panel (iPhone Duo, Xcode 27.1), resident;
// and `--orientation`, a one-shot read of where any simulator is held (below), for hosts whose devicectl
// cannot answer. It was `duo-helper` while it did only the first.
//
// Runs INSIDE the simulator, started by the agent with `xcrun simctl spawn <udid> <this> --udid <udid>`.
// On a multi-panel device the host's Indigo path has no live receiver for the cover panel's touches and
// SimulatorHID drops Indigo keys, buttons and the Purple rotation event, so every input goes through
// here instead. A single-panel device never starts the resident mode.
//
// It registers virtual HID services with the private HID.framework (`HIDVirtualEventService`, loaded with
// dlopen so this builds against any iOS SDK) and dispatches IOKit HID events on them:
//   - one touchscreen per panel, shaped like the guest's own CoreDevice touchscreens (digitizer usage,
//     Built-In, DisplayIntegrated, displayUUID). Display UUIDs change every boot, so the host passes the
//     ones it read from `simctl io enumerate` as `--touchscreen <uuid>` and they are registered at start.
//   - an avpCustom-shaped service (0xFF61/0x5B) for the hinge and the orientation picker. The payload is
//     the keyed record DeviceHub sends, byte layout captured from DeviceHub on Xcode 27.1.
//   - a mainScreenButtons-shaped service (0x0B/0x01) for keyboard and hardware keys.
//
// **A service is not usable the moment it registers.** Measured on Xcode 27.1: a tap dispatched within
// 50 ms of `activate` is dropped, one at 100 ms lands (twice each). So every service is registered at start
// and `ready` waits kSettleMs past the last one; a touchscreen for a UUID nobody announced is registered
// on first use and waits the same before its first event. Dropping that wait is what lost the first tap,
// and very likely the first button press seen in the prototype.
//
// Every private symbol tapflow uses for this device lives in this file. A runtime that refuses them is
// reported with `fatal` and a non-zero exit, and the agent treats the device as unusable.
//
// Protocol, one command per line on stdin:
//   touch <displayUUID> <d|m|u> <x> <y> <edge>   one finger; x/y normalized to the panel's framebuffer;
//                                                 edge 1 marks a gesture that started at a screen edge
//   pinch <displayUUID> <d|m|u> <x1> <y1> <x2> <y2>
//   hinge <fromDeg> <toDeg> <ms>                  ease-out sweep at 60 Hz, played here, not on the host
//   orient <portrait|pud|landscape-left|landscape-right>   DeviceHub's own labels
//   key <usagePage> <usage> <holdMs> [<modPage> <modUsage>]...
//   keydown <usagePage> <usage> / keyup <usagePage> <usage>   a hold as long as the tester's (long-press)
// Consumer-page Menu (0x0C/0x40) is the home button on the Duo (measured: AC Home 0x0C/0x223 does nothing).
// Replies on stdout: `pid <n>` then `ready` at start; `done <status> <cmd>` for every command except
// touch and pinch, which answer only on failure (`err <status> <cmd>`) — a drag is 60+ lines a second
// and the host acks input on the write, not on this. Status 0 ok, 1 dispatch refused, 2 bad line.
// Exits on stdin EOF, so an agent that goes away takes its helper with it.
//
// `--orientation` instead reads which way the device is held and exits: one line, `orientation <name>` with
// UIDeviceOrientation's names (portrait, portraitUpsideDown, landscapeLeft, landscapeRight), or `fatal <why>`.
// It is how a single-panel simulator's orientation is read on an Xcode 26 host, whose devicectl does not see
// simulators. The value is backboardd's, over its HID MIG port (`_BKSHIDGetNonFlatDeviceOrientation`): the
// physical orientation, not the interface's — measured on iOS 26.5, it follows Purple turns on a home screen
// that never turns, all four ways.
#import <Foundation/Foundation.h>
#import <objc/runtime.h>
#import <objc/message.h>
#include <dlfcn.h>
#include <mach/mach_time.h>
#include <unistd.h>

typedef void *HIDEventRef;
static HIDEventRef (*mkDigitizer)(CFAllocatorRef, uint64_t, uint32_t, uint32_t, uint32_t, uint32_t, uint32_t,
                                  double, double, double, double, double, Boolean, Boolean, uint32_t);
static HIDEventRef (*mkFinger)(CFAllocatorRef, uint64_t, uint32_t, uint32_t, uint32_t,
                               double, double, double, double, double, Boolean, Boolean, uint32_t);
static void (*appendEvent)(HIDEventRef, HIDEventRef, uint32_t);
static HIDEventRef (*mkVendor)(CFAllocatorRef, uint64_t, uint32_t, uint32_t, uint32_t, const uint8_t *, CFIndex, uint32_t);
static HIDEventRef (*mkKeyboard)(CFAllocatorRef, uint64_t, uint32_t, uint32_t, Boolean, uint32_t);

// IOHIDFamily's digitizer event mask. Down and move carry range|touch|position, up touch|position — the
// same values touch-helper uses; a move sent as position alone is ignored. FromEdgeTip is what makes the
// system treat a swipe as a system gesture (home, app switcher). The system still checks where the touch
// started, so the flag on a touch far from an edge, or on a tap near one, changes nothing (measured).
enum { kMaskDown = 0x07, kMaskUp = 0x06, kMaskFromEdgeTip = 0x800 };
static const useconds_t kSettleUs = 300 * 1000;   // 3x the measured 100 ms

@interface TFServiceDelegate : NSObject
@property (copy) NSDictionary *props;
@end
@implementation TFServiceDelegate
- (id)propertyForKey:(NSString *)key forService:(id)service { return self.props[key]; }
- (BOOL)setProperty:(id)value forKey:(NSString *)key forService:(id)service { return NO; }
- (id)copyEventMatching:(NSDictionary *)attributes forService:(id)service { return nil; }
- (BOOL)setOutputEvent:(id)event forService:(id)service { return NO; }
- (void)notification:(NSInteger)type withProperty:(NSDictionary *)property forService:(id)service {}
@end

static NSMutableArray *retained;   // delegates are held weakly by the service
static NSMutableDictionary<NSString *, id> *touchscreens;
static id avpService, buttonService;

static id makeService(NSDictionary *props) {
    Class cls = objc_getClass("HIDVirtualEventService");
    if (!cls) return nil;
    TFServiceDelegate *delegate = [TFServiceDelegate new];
    delegate.props = props;
    id service = [cls new];
    ((void (*)(id, SEL, id))objc_msgSend)(service, sel_registerName("setDelegate:"), delegate);
    ((void (*)(id, SEL, id))objc_msgSend)(service, sel_registerName("setDispatchQueue:"),
                                          dispatch_queue_create("dev.tapflow.guest-helper.service", DISPATCH_QUEUE_SERIAL));
    ((void (*)(id, SEL))objc_msgSend)(service, sel_registerName("activate"));
    [retained addObject:delegate];
    [retained addObject:service];
    return service;
}

static BOOL dispatchEvent(id service, HIDEventRef event) {
    if (!service || !event) { if (event) CFRelease(event); return NO; }
    BOOL ok = ((BOOL (*)(id, SEL, id))objc_msgSend)(service, sel_registerName("dispatchEvent:"), (__bridge id)event);
    CFRelease(event);
    return ok;
}

static id registerTouchscreen(NSString *displayUUID) {
    id service = makeService(@{
        @"PrimaryUsagePage": @0x0D, @"PrimaryUsage": @0x04,
        @"DeviceUsagePairs": @[@{ @"DeviceUsagePage": @0x0D, @"DeviceUsage": @0x04 }],
        @"Built-In": @1, @"DisplayIntegrated": @1, @"displayUUID": displayUUID, @"Transport": @"CoreDevice",
    });
    if (service) touchscreens[displayUUID] = service;
    return service;
}

static id touchscreen(NSString *displayUUID) {
    id service = touchscreens[displayUUID];
    if (service) return service;
    service = registerTouchscreen(displayUUID);
    if (service) usleep(kSettleUs);
    return service;
}

// ── Keyed record (DeviceHub's vendor payload) ─────────────────────────────────────────────────────────
// 'd3 00 00 00', then items of [u24 aux LE][u8 type], each padded to 4 bytes. Types: 0x01 dictionary
// (aux = pair count), 0x08 key (aux = length with its NUL), 0x09 string (aux = length, NO terminator),
// 0x04 double (aux 0x3f, 8 bytes LE). Bit 0x80 on the type marks the last entry of a container, and the
// root dictionary carries it too. Entry order is DeviceHub's. Captured on Xcode 27.1; the descriptions
// that predate that capture got the NULs, the order and the root bit wrong, and nothing moved.
static void recordItem(NSMutableData *d, uint8_t type, uint32_t aux, const void *payload, size_t length, BOOL last) {
    uint8_t header[4] = { aux & 0xff, (aux >> 8) & 0xff, (aux >> 16) & 0xff, (uint8_t)(type | (last ? 0x80 : 0)) };
    [d appendBytes:header length:4];
    if (length == 0) return;
    [d appendBytes:payload length:length];
    static const uint8_t zero[4] = {0};
    [d appendBytes:zero length:(4 - length % 4) % 4];
}
static void recordKey(NSMutableData *d, const char *key) {
    size_t n = strlen(key) + 1;
    recordItem(d, 0x08, (uint32_t)n, key, n, NO);
}
static void recordString(NSMutableData *d, const char *s, BOOL last) {
    size_t n = strlen(s);
    recordItem(d, 0x09, (uint32_t)n, s, n, last);
}
static NSMutableData *recordStart(void) {
    NSMutableData *d = [NSMutableData data];
    static const uint8_t magic[4] = {0xd3, 0, 0, 0};
    [d appendBytes:magic length:4];
    recordItem(d, 0x01, 4, NULL, 0, YES);
    return d;
}
static const char *kProvider = "com.apple.Virtualization.VirtualMachines";

static NSData *hingeRecord(double degrees) {
    NSMutableData *d = recordStart();
    recordKey(d, "value"); recordItem(d, 0x04, 0x3f, &degrees, 8, NO);
    recordKey(d, "type"); recordString(d, "range", NO);
    recordKey(d, "source"); recordString(d, "hinge-slider-control", NO);
    recordKey(d, "provider"); recordString(d, kProvider, YES);
    return d;
}
static NSData *orientationRecord(const char *value) {
    NSMutableData *d = recordStart();
    recordKey(d, "value"); recordString(d, value, NO);
    recordKey(d, "source"); recordString(d, "orientation-picker-control", NO);
    recordKey(d, "type"); recordString(d, "enum", NO);
    recordKey(d, "provider"); recordString(d, kProvider, YES);
    return d;
}
static BOOL sendRecord(NSData *record) {
    return dispatchEvent(avpService, mkVendor(NULL, mach_absolute_time(), 0xFF61, 0x5B, 0,
                                              record.bytes, (CFIndex)record.length, 0));
}

// ── Commands ──────────────────────────────────────────────────────────────────────────────────────────
static BOOL touchFrame(id service, char phase, int fingers, const double *xs, const double *ys, BOOL edge) {
    if (phase != 'd' && phase != 'm' && phase != 'u') return NO;
    BOOL down = phase != 'u';
    uint32_t mask = (down ? kMaskDown : kMaskUp) | (edge ? kMaskFromEdgeTip : 0);
    uint64_t now = mach_absolute_time();
    HIDEventRef hand = mkDigitizer(NULL, now, 2 /* hand */, 0, 1, mask, 0, xs[0], ys[0], 0, 0, 0, down, down, 0);
    if (!hand) return NO;
    for (int i = 0; i < fingers; i++) {
        HIDEventRef finger = mkFinger(NULL, now, (uint32_t)i + 1, (uint32_t)i + 2, mask, xs[i], ys[i], 0, 0, 0, down, down, 0);
        if (!finger) { CFRelease(hand); return NO; }
        appendEvent(hand, finger, 0);
        CFRelease(finger);
    }
    return dispatchEvent(service, hand);
}

static BOOL validOrientation(const char *v) {
    return !strcmp(v, "portrait") || !strcmp(v, "pud") || !strcmp(v, "landscape-left") || !strcmp(v, "landscape-right");
}

static void reply(const char *what, int status, const char *cmd) {
    printf("%s %d %s\n", what, status, cmd);
}

static void handle(char *line) {
    char cmd[16] = {0};
    if (sscanf(line, "%15s", cmd) != 1) return;

    if (!strcmp(cmd, "touch")) {
        char uuid[64] = {0}, phase = 0; double x = 0, y = 0; int edge = 0;
        if (sscanf(line, "%*s %63s %c %lf %lf %d", uuid, &phase, &x, &y, &edge) != 5) { reply("err", 2, cmd); return; }
        double xs[1] = {x}, ys[1] = {y};
        if (!touchFrame(touchscreen(@(uuid)), phase, 1, xs, ys, edge != 0)) reply("err", 1, cmd);
    } else if (!strcmp(cmd, "pinch")) {
        char uuid[64] = {0}, phase = 0; double v[4] = {0};
        if (sscanf(line, "%*s %63s %c %lf %lf %lf %lf", uuid, &phase, &v[0], &v[1], &v[2], &v[3]) != 6) { reply("err", 2, cmd); return; }
        double xs[2] = {v[0], v[2]}, ys[2] = {v[1], v[3]};
        if (!touchFrame(touchscreen(@(uuid)), phase, 2, xs, ys, NO)) reply("err", 1, cmd);
    } else if (!strcmp(cmd, "hinge")) {
        double from = 0, to = 0, ms = 0;
        if (sscanf(line, "%*s %lf %lf %lf", &from, &to, &ms) != 3 || to < 0 || to > 180 || ms < 0) { reply("done", 2, cmd); return; }
        // DeviceHub sends a sample every ~17 ms on an ease-out curve; the panel switches as SpringBoard
        // sees the angle cross, so the samples matter, not only the last one.
        int steps = ms > 0 ? (int)ceil(ms * 60 / 1000) : 1;
        BOOL ok = YES;
        for (int i = 1; i <= steps; i++) {
            double t = (double)i / steps;
            ok &= sendRecord(hingeRecord(from + (to - from) * (1 - pow(1 - t, 3))));
            if (i < steps) usleep(1000000 / 60);
        }
        reply("done", ok ? 0 : 1, cmd);
    } else if (!strcmp(cmd, "orient")) {
        char value[32] = {0};
        if (sscanf(line, "%*s %31s", value) != 1 || !validOrientation(value)) { reply("done", 2, cmd); return; }
        reply("done", sendRecord(orientationRecord(value)) ? 0 : 1, cmd);
    } else if (!strcmp(cmd, "key")) {
        // key <page> <usage> <holdMs> [<modPage> <modUsage>]... Modifiers go down in order before the key
        // and up in reverse after it, and are released even when the key itself is refused.
        unsigned args[3 + 2 * 8]; int n = 0;
        for (char *save = NULL, *tok = strtok_r(line, " \t\n", &save); tok; tok = strtok_r(NULL, " \t\n", &save)) {
            if (tok == line) continue;   // the command word
            char *end = NULL; unsigned long v = strtoul(tok, &end, 0);
            if (*end != '\0' || n == (int)(sizeof args / sizeof args[0])) { reply("done", 2, cmd); return; }
            args[n++] = (unsigned)v;
        }
        if (n < 3 || (n - 3) % 2 != 0) { reply("done", 2, cmd); return; }
        unsigned page = args[0], usage = args[1], hold = args[2];
        int nmods = (n - 3) / 2;
        unsigned (*mods)[2] = (unsigned (*)[2])&args[3];
        BOOL ok = YES;
        for (int i = 0; i < nmods; i++) ok &= dispatchEvent(buttonService, mkKeyboard(NULL, mach_absolute_time(), mods[i][0], mods[i][1], 1, 0));
        ok &= dispatchEvent(buttonService, mkKeyboard(NULL, mach_absolute_time(), page, usage, 1, 0));
        usleep(hold * 1000);
        ok &= dispatchEvent(buttonService, mkKeyboard(NULL, mach_absolute_time(), page, usage, 0, 0));
        for (int i = nmods - 1; i >= 0; i--) ok &= dispatchEvent(buttonService, mkKeyboard(NULL, mach_absolute_time(), mods[i][0], mods[i][1], 0, 0));
        reply("done", ok ? 0 : 1, cmd);
    } else if (!strcmp(cmd, "keydown") || !strcmp(cmd, "keyup")) {
        unsigned page = 0, usage = 0;
        if (sscanf(line, "%*s %u %u", &page, &usage) != 2) { reply("done", 2, cmd); return; }
        BOOL down = !strcmp(cmd, "keydown");
        reply("done", dispatchEvent(buttonService, mkKeyboard(NULL, mach_absolute_time(), page, usage, down, 0)) ? 0 : 1, cmd);
    } else {
        reply("done", 2, cmd);
    }
}

static void fatal(const char *why) {
    printf("fatal %s\n", why);
    exit(3);
}

// The NonFlat value lands in the low 32 bits; the rest of a 64-bit out-parameter is left as it was found
// (measured: 0xFFFFFFFF00000001 for portrait), so it is read as 32 bits into a zeroed word.
static int printOrientation(void) {
    void *bbs = dlopen("/System/Library/PrivateFrameworks/BackBoardServices.framework/BackBoardServices", RTLD_NOW);
    if (!bbs) fatal("BackBoardServices did not load");
    mach_port_t (*port)(void) = dlsym(bbs, "BKSHIDServicesServerPort");
    kern_return_t (*get)(mach_port_t, int64_t *) = dlsym(bbs, "_BKSHIDGetNonFlatDeviceOrientation");
    if (!port || !get) fatal("BackBoardServices orientation symbols missing");
    int64_t out = 0;
    kern_return_t kr = get(port(), &out);
    if (kr != KERN_SUCCESS) fatal("orientation read refused");
    static const char *names[] = { NULL, "portrait", "portraitUpsideDown", "landscapeLeft", "landscapeRight" };
    int32_t value = (int32_t)(out & 0xFFFFFFFF);
    if (value < 1 || value > 4) { printf("fatal unknown orientation %d\n", value); return 3; }
    printf("orientation %s\n", names[value]);
    return 0;
}

int main(int argc, char **argv) {
    @autoreleasepool {
        setvbuf(stdout, NULL, _IOLBF, 0);
        if (argc > 1 && !strcmp(argv[1], "--orientation")) return printOrientation();
        // `--udid <udid>` is not read: it is in argv so the host can find this process with `pgrep -f`
        // after losing track of it (an agent killed with -9, or a `simctl spawn` that died alone — the
        // guest process outlives it).
        retained = [NSMutableArray array];
        touchscreens = [NSMutableDictionary dictionary];
        NSMutableArray<NSString *> *panels = [NSMutableArray array];
        for (int i = 1; i + 1 < argc; i++) {
            if (!strcmp(argv[i], "--touchscreen")) [panels addObject:@(argv[++i])];
        }

        if (!dlopen("/System/Library/PrivateFrameworks/HID.framework/HID", RTLD_NOW)) fatal("HID.framework did not load");
        void *iokit = dlopen("/System/Library/Frameworks/IOKit.framework/IOKit", RTLD_NOW);
        if (!iokit) fatal("IOKit did not load");
        mkDigitizer = dlsym(iokit, "IOHIDEventCreateDigitizerEvent");
        mkFinger = dlsym(iokit, "IOHIDEventCreateDigitizerFingerEvent");
        appendEvent = dlsym(iokit, "IOHIDEventAppendEvent");
        mkVendor = dlsym(iokit, "IOHIDEventCreateVendorDefinedEvent");
        mkKeyboard = dlsym(iokit, "IOHIDEventCreateKeyboardEvent");
        if (!mkDigitizer || !mkFinger || !appendEvent || !mkVendor || !mkKeyboard) fatal("IOKit HID event symbols missing");
        if (!objc_getClass("HIDVirtualEventService")) fatal("HIDVirtualEventService missing");

        // Created up front rather than on first use: a key or a fold is often the first thing sent, and a
        // service is not worth registering in the middle of one.
        avpService = makeService(@{
            @"PrimaryUsagePage": @0xFF61, @"PrimaryUsage": @0x5B,
            @"DeviceUsagePairs": @[@{ @"DeviceUsagePage": @0xFF61, @"DeviceUsage": @0x5B }], @"Transport": @"CoreDevice",
        });
        buttonService = makeService(@{
            @"PrimaryUsagePage": @0x0B, @"PrimaryUsage": @0x01,
            @"DeviceUsagePairs": @[@{ @"DeviceUsagePage": @0x0B, @"DeviceUsage": @0x01 }],
            @"Built-In": @1, @"Authenticated": @1, @"Transport": @"CoreDevice",
        });
        if (!avpService || !buttonService) fatal("could not register services");
        for (NSString *uuid in panels) {
            if (!registerTouchscreen(uuid)) fatal("could not register a touchscreen");
        }
        usleep(kSettleUs);

        printf("pid %d\nready\n", getpid());
        char line[512];
        while (fgets(line, sizeof line, stdin)) handle(line);
    }
    return 0;
}

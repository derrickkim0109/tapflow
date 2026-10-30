import Foundation
import Network
import XCTest

// Minimal HTTP server that serves a target app's accessibility tree and drives input.
// Runs inside the resident UI-test process, so tree reads are window-agnostic
// (no Simulator.app window required — the tapflow headless path). On a physical device it is
// the only input path: SimulatorKit's HID injection does not reach hardware.
//
// Routes:
//   GET  /health                          → the token the host passed, or "ok" without one (readiness probe)
//   GET  /tree?bundleId=<id>              → the app's XCUIApplication.debugDescription (text)
//   GET  /tap?x=&y=                       → tap at a point normalized to the screen (0–1)
//   GET  /drag?x1=&y1=&x2=&y2=&ms=        → press at (x1,y1) and drag to (x2,y2) over ms; equal points = long press
//   POST /type[?bundleId=]                → type the UTF-8 body into the element with keyboard focus
//   GET  /key?name=<name>[&bundleId=]     → return | delete | tab | home | volumeUp | volumeDown (device only)
// Input routes answer JSON — {"ok":true} or {"ok":false,"error":"…"} — and need the `X-Tapflow-Token`
// header whenever the host passed a token (it always does). Bound beyond loopback (TAPFLOW_TREE_BIND_ANY),
// /health and /tree need it too, and with no token there every route is refused.
final class TreeServer {
    private let listener: NWListener
    private let queue = DispatchQueue(label: "dev.tapflow.treeserver")
    private let token: String
    private let bindAny: Bool

    init(port: UInt16, token: String, bindAny: Bool = false) throws {
        self.token = token
        self.bindAny = bindAny
        let params = NWParameters.tcp
        params.allowLocalEndpointReuse = true
        guard let nwPort = NWEndpoint.Port(rawValue: port) else {
            throw NSError(domain: "TreeServer", code: 1, userInfo: [NSLocalizedDescriptionKey: "invalid port \(port)"])
        }
        if bindAny {
            // A physical device: the Mac reaches it over the CoreDevice tunnel (a utun address of the device's own),
            // never through the device's loopback. `::` also listens on the device's Wi-Fi, which is why the token
            // gates every route in this mode.
            params.requiredLocalEndpoint = NWEndpoint.hostPort(host: NWEndpoint.Host("::"), port: nwPort)
        } else {
            // Bind loopback ONLY. The simulator shares the host's network stack, so a
            // default all-interfaces bind would expose the app's UI tree to the LAN with
            // no auth — tapflow keeps app data inside the machine. requiredLocalEndpoint
            // forces the listen socket onto 127.0.0.1 (requiredInterfaceType alone does not).
            params.requiredLocalEndpoint = NWEndpoint.hostPort(host: NWEndpoint.Host("127.0.0.1"), port: nwPort)
        }
        listener = try NWListener(using: params)
    }

    func start() {
        listener.newConnectionHandler = { [weak self] conn in
            guard let self else { return }
            conn.start(queue: self.queue)
            self.receive(conn, buffer: Data())
        }
        // Surface a bind failure immediately by
        // exiting — otherwise the process stays alive looking "ready" and the host
        // only fails after the full 90s /health poll.
        listener.stateUpdateHandler = { [weak self] state in
            switch state {
            case .ready:
                // Announced only once bound, with the port the kernel gave (the host passes 0), because the host
                // talks to nothing but the port this line names. Printed before the bind, as it once was, a runner
                // that lost its port still announced it, and the host then read another simulator's tree from
                // whoever held it.
                print("TAPFLOW_TREE_READY port=\(self?.listener.port?.rawValue ?? 0)")
                fflush(stdout)
            case .failed(let error):
                FileHandle.standardError.write(Data("tree server failed to bind: \(error)\n".utf8))
                exit(1)
            default:
                break
            }
        }
        listener.start(queue: queue)
    }

    private struct Request {
        let method: String
        let path: String
        let headers: [String: String]
        let body: Data
    }

    // Accumulate bytes until the request head and, for a POST, its Content-Length of body have arrived.
    private func receive(_ conn: NWConnection, buffer: Data) {
        conn.receive(minimumIncompleteLength: 1, maximumLength: 65536) { [weak self] data, _, isComplete, error in
            guard let self else { return }
            var buf = buffer
            if let data { buf.append(data) }
            switch Self.parse(buf) {
            case .request(let request):
                self.handleRequest(conn, request)
                return
            case .invalid:
                conn.cancel()
                return
            case .incomplete:
                break
            }
            if isComplete || error != nil || buf.count > 1 << 20 { conn.cancel(); return }
            self.receive(conn, buffer: buf)
        }
    }

    private enum Parsed {
        case incomplete
        case invalid
        case request(Request)
    }

    private static func parse(_ buf: Data) -> Parsed {
        guard let sep = buf.range(of: Data("\r\n\r\n".utf8)),
              let head = String(data: buf[..<sep.lowerBound], encoding: .utf8) else { return .incomplete }
        let lines = head.components(separatedBy: "\r\n")
        let parts = (lines.first ?? "").split(separator: " ")
        var headers: [String: String] = [:]
        for line in lines.dropFirst() {
            guard let colon = line.firstIndex(of: ":") else { continue }
            let name = line[..<colon].trimmingCharacters(in: .whitespaces).lowercased()
            headers[name] = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
        }
        let length = Int(headers["content-length"] ?? "0") ?? 0
        // A negative length would pass the check below and trap in `prefix`, killing the runner for any caller.
        guard length >= 0 && length <= 1 << 20 else { return .invalid }
        let body = buf[sep.upperBound...]
        if body.count < length { return .incomplete }
        return .request(Request(
            method: parts.first.map(String.init) ?? "GET",
            path: parts.count >= 2 ? String(parts[1]) : "/",
            headers: headers,
            body: Data(body.prefix(length))
        ))
    }

    private func handleRequest(_ conn: NWConnection, _ request: Request) {
        // XCUITest snapshot access and synthesized events must run on the main thread.
        DispatchQueue.main.async {
            let (status, type, body) = self.route(request)
            self.respond(conn, status: status, contentType: type, body: body)
        }
    }

    private func authorized(_ request: Request) -> Bool {
        // Without a token there is nothing to check a caller against; beyond loopback that refuses everyone.
        if token.isEmpty { return !bindAny }
        return request.headers["x-tapflow-token"] == token
    }

    private func route(_ request: Request) -> (String, String, String) {
        let path = request.path
        let text = "text/plain; charset=utf-8"
        if path.hasPrefix("/health") {
            // The token tells the host this is the runner it started, not one another agent left on the port.
            // Beyond loopback anyone on the device's network could ask, so there it answers only a caller that
            // already holds it.
            if bindAny && !authorized(request) { return ("401 Unauthorized", text, "unauthorized") }
            return ("200 OK", text, token.isEmpty ? "ok" : token)
        }
        if path.hasPrefix("/tree") {
            if bindAny && !authorized(request) { return ("401 Unauthorized", text, "unauthorized") }
            guard let bundleId = Self.query(path, "bundleId"), !bundleId.isEmpty else {
                return ("400 Bad Request", text, "missing bundleId")
            }
            let app = XCUIApplication(bundleIdentifier: bundleId)
            return ("200 OK", text, app.debugDescription)
        }
        guard let route = ["/tap", "/drag", "/type", "/key"].first(where: { path.hasPrefix($0) }) else {
            return ("404 Not Found", text, "unknown route")
        }
        guard authorized(request) else { return Self.json("401 Unauthorized", error: "unauthorized") }
        do {
            switch route {
            case "/tap":
                try tap(path)
            case "/drag":
                try drag(path)
            case "/type":
                guard request.method == "POST" else { return Self.json("405 Method Not Allowed", error: "POST the text") }
                try type(String(decoding: request.body, as: UTF8.self), bundleId: Self.query(path, "bundleId"))
            default:
                try key(Self.query(path, "name") ?? "", bundleId: Self.query(path, "bundleId"))
            }
            return Self.json("200 OK", error: nil)
        } catch let e as InputError {
            return Self.json(e.status, error: e.message)
        } catch {
            return Self.json("500 Internal Server Error", error: "\(error)")
        }
    }

    private struct InputError: Error {
        let status: String
        let message: String
        static func bad(_ m: String) -> InputError { InputError(status: "400 Bad Request", message: m) }
        static func unsupported(_ m: String) -> InputError { InputError(status: "501 Not Implemented", message: m) }
        static func refused(_ m: String) -> InputError { InputError(status: "409 Conflict", message: m) }
    }

    // SpringBoard spans the whole screen whatever app is in front, so a coordinate on it lands wherever the
    // foreground app has its UI — the runner never needs to know which app that is to touch it.
    private var screen: XCUIApplication { XCUIApplication(bundleIdentifier: "com.apple.springboard") }

    private func point(_ path: String, _ xKey: String, _ yKey: String) throws -> CGVector {
        guard let x = Self.number(path, xKey), let y = Self.number(path, yKey),
              (0...1).contains(x), (0...1).contains(y) else {
            throw InputError.bad("\(xKey) and \(yKey) must be numbers in 0…1")
        }
        return CGVector(dx: x, dy: y)
    }

    private func tap(_ path: String) throws {
        screen.coordinate(withNormalizedOffset: try point(path, "x", "y")).tap()
    }

    private func drag(_ path: String) throws {
        let from = try point(path, "x1", "y1")
        let to = try point(path, "x2", "y2")
        guard let ms = Self.number(path, "ms"), ms >= 0 else { throw InputError.bad("ms must be a number ≥ 0") }
        let seconds = ms / 1000
        let springboard = screen
        let start = springboard.coordinate(withNormalizedOffset: from)
        if from == to {
            start.press(forDuration: seconds)
            return
        }
        let size = springboard.frame.size
        let distance = hypot((to.dx - from.dx) * size.width, (to.dy - from.dy) * size.height)
        // The press before moving stays short: held longer, the drag would open as a long press.
        let hold = 0.05
        start.press(
            forDuration: hold,
            thenDragTo: springboard.coordinate(withNormalizedOffset: to),
            withVelocity: XCUIGestureVelocity(distance / max(seconds - hold, 0.05)),
            thenHoldForDuration: 0
        )
    }

    // The element with keyboard focus in the given foreground app, else in SpringBoard (its search, a system alert).
    private func focused(bundleId: String?) -> XCUIElement? {
        var apps: [XCUIApplication] = []
        if let bundleId, !bundleId.isEmpty {
            let app = XCUIApplication(bundleIdentifier: bundleId)
            if app.state == .runningForeground { apps.append(app) }
        }
        apps.append(screen)
        for app in apps {
            let el = app.descendants(matching: .any).matching(NSPredicate(format: "hasKeyboardFocus == true")).firstMatch
            if el.exists { return el }
        }
        return nil
    }

    private func type(_ text: String, bundleId: String?) throws {
        if text.isEmpty { return }
        // typeText with nothing focused records an XCTest failure rather than throwing; checking first keeps the
        // answer an error the host can read.
        guard let el = focused(bundleId: bundleId) else {
            throw InputError.refused("no element has keyboard focus — tap a text field first")
        }
        el.typeText(text)
    }

    private func key(_ name: String, bundleId: String?) throws {
        switch name {
        case "return": try type(XCUIKeyboardKey.return.rawValue, bundleId: bundleId)
        case "delete": try type(XCUIKeyboardKey.delete.rawValue, bundleId: bundleId)
        case "tab": try type(XCUIKeyboardKey.tab.rawValue, bundleId: bundleId)
        case "home": XCUIDevice.shared.press(.home)
        #if !targetEnvironment(simulator)
        case "volumeUp": XCUIDevice.shared.press(.volumeUp)
        case "volumeDown": XCUIDevice.shared.press(.volumeDown)
        #endif
        case "": throw InputError.bad("missing name")
        default: throw InputError.unsupported("key \(name) cannot be pressed from XCUITest")
        }
    }

    private static func json(_ status: String, error: String?) -> (String, String, String) {
        let object: [String: Any] = error.map { ["ok": false, "error": $0] } ?? ["ok": true]
        let data = (try? JSONSerialization.data(withJSONObject: object)) ?? Data("{\"ok\":false}".utf8)
        return (status, "application/json", String(decoding: data, as: UTF8.self))
    }

    private static func number(_ path: String, _ key: String) -> Double? {
        query(path, key).flatMap(Double.init).flatMap { $0.isFinite ? $0 : nil }
    }

    private static func query(_ path: String, _ key: String) -> String? {
        guard let q = path.split(separator: "?").dropFirst().first else { return nil }
        for pair in q.split(separator: "&") {
            let kv = pair.split(separator: "=", maxSplits: 1)
            if kv.count == 2 && kv[0] == key {
                let raw = String(kv[1])
                return raw.removingPercentEncoding ?? raw
            }
        }
        return nil
    }

    private func respond(_ conn: NWConnection, status: String, contentType: String, body: String) {
        let bytes = Array(body.utf8)
        let header = "HTTP/1.1 \(status)\r\nContent-Type: \(contentType)\r\nContent-Length: \(bytes.count)\r\nConnection: close\r\n\r\n"
        var out = Data(header.utf8)
        out.append(contentsOf: bytes)
        conn.send(content: out, completion: .contentProcessed { _ in conn.cancel() })
    }
}

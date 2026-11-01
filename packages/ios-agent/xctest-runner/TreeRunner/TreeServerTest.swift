import XCTest

// Resident runner: starts the HTTP tree server, then blocks so the process stays
// alive serving queries until the host terminates it (session end / shutdown).
// The host learns the port from the TAPFLOW_TREE_READY line and confirms it with GET /health.
final class TreeServerTest: XCTestCase {
    func testServeTree() throws {
        // The host passes these as TEST_RUNNER_TAPFLOW_TREE_*: xcodebuild strips the prefix on the way in. Port 0
        // lets the kernel pick, and the server announces what it got.
        let env = ProcessInfo.processInfo.environment
        let portStr = env["TAPFLOW_TREE_PORT"] ?? "22087"
        guard let port = UInt16(portStr) else {
            XCTFail("invalid TAPFLOW_TREE_PORT: \(portStr)")
            return
        }
        // Input routes synthesize events from this test; a failed XCUI action must not end the resident runner.
        continueAfterFailure = true
        let server = try TreeServer(port: port, token: env["TAPFLOW_TREE_TOKEN"] ?? "", bindAny: env["TAPFLOW_TREE_BIND_ANY"] == "1")
        server.start()
        // Block forever — the host kills the process to stop the runner. The server's handlers hold it weakly, so
        // keep it alive here explicitly rather than trusting the local to outlive its last use.
        withExtendedLifetime(server) { RunLoop.current.run() }
    }
}

import Capacitor
import Foundation
import Network
import UIKit

/// Content downloads and account backup for the iOS app, with the same JavaScript surface and the
/// same rules as Android's `WifiContentTransportPlugin.java`:
///
/// - Only the approved API hosts and the content CDN, over HTTPS on port 443, never redirected.
/// - Detailed map chunks (`map/island/*.bin`) use Wi-Fi only unless the request allows any network;
///   everything else may use any network. Unlike Android, a chunk is refused at once without Wi-Fi
///   instead of waiting 15 seconds for it, and iOS keeps it off mobile data if Wi-Fi drops mid-way.
/// - Account backup only reaches the claim and photo routes, with a bearer session, the native
///   transport marker and the route's content type and size limits.
/// - Responses are size-limited, cookies are never sent or stored, and requests stop when Parkdex
///   leaves the foreground.
@objc(WifiContentTransportPlugin)
public class WifiContentTransportPlugin: CAPPlugin, CAPBridgedPlugin, URLSessionDataDelegate {
    public let identifier = "WifiContentTransportPlugin"
    public let jsName = "WifiContentTransport"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getWifiStatus", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "request", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "accountRequest", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "abort", returnType: CAPPluginReturnPromise),
    ]

    private static let defaultMaxResponseBytes = 4 * 1024 * 1024
    private static let hardMaxResponseBytes = 8 * 1024 * 1024
    private static let maxAccountBackupBytes = 2_621_440
    private static let maxClaimJsonBytes = 16 * 1024
    private static let defaultTimeoutMs = 20_000
    private static let maxTimeoutMs = 60_000
    private static let approvedCdnOrigin = "https://kip-assets.parkdex.app"
    private static let approvedApiHosts: Set<String> = [
        "staging.web.parkdex.app", "web.parkdex.app", "parkdex-kip-staging.vercel.app", "parkdex-kip.vercel.app",
    ]
    private static let blockedHeaders: Set<String> = [
        "host", "connection", "content-length", "transfer-encoding", "upgrade", "keep-alive",
        "proxy-authorization", "proxy-authenticate", "cookie", "set-cookie", "accept-encoding",
    ]
    private static let uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"

    private final class ActiveRequest {
        let requestId: String
        let call: CAPPluginCall
        let url: URL
        let maxResponseBytes: Int
        let accountBackup: Bool
        let wifiRequired: Bool
        var task: URLSessionDataTask?
        var response: HTTPURLResponse?
        var body = Data()

        init(requestId: String, call: CAPPluginCall, url: URL, maxResponseBytes: Int, accountBackup: Bool, wifiRequired: Bool) {
            self.requestId = requestId
            self.call = call
            self.url = url
            self.maxResponseBytes = maxResponseBytes
            self.accountBackup = accountBackup
            self.wifiRequired = wifiRequired
        }
    }

    /// Every request's state is touched only on this queue, which is also the session's delegate queue.
    private let stateQueue = DispatchQueue(label: "app.parkdex.content-transport")
    private lazy var delegateQueue: OperationQueue = {
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 1
        queue.underlyingQueue = stateQueue
        return queue
    }()
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        configuration.httpShouldSetCookies = false
        configuration.urlCache = nil
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.waitsForConnectivity = false
        return URLSession(configuration: configuration, delegate: self, delegateQueue: delegateQueue)
    }()
    private var active: [String: ActiveRequest] = [:]
    private var byTask: [Int: ActiveRequest] = [:]
    private var foreground = true
    private let pathMonitor = NWPathMonitor()
    private var currentPath: NWPath?

    public override func load() {
        // The handler runs on stateQueue, like every other read of the path.
        pathMonitor.pathUpdateHandler = { [weak self] path in
            self?.currentPath = path
        }
        pathMonitor.start(queue: stateQueue)
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(didEnterBackground), name: UIApplication.didEnterBackgroundNotification, object: nil)
        center.addObserver(self, selector: #selector(willEnterForeground), name: UIApplication.willEnterForegroundNotification, object: nil)
    }

    @objc private func didEnterBackground() {
        stateQueue.async {
            self.foreground = false
            for state in Array(self.active.values) { self.fail(state, "Content requests stop when Parkdex leaves the foreground") }
        }
    }

    @objc private func willEnterForeground() {
        stateQueue.async { self.foreground = true }
    }

    private func wifiAvailable() -> Bool {
        let path = currentPath ?? pathMonitor.currentPath
        return path.status == .satisfied && path.usesInterfaceType(.wifi)
    }

    private func anyNetworkAvailable() -> Bool {
        (currentPath ?? pathMonitor.currentPath).status == .satisfied
    }

    // MARK: Plugin methods

    @objc func getWifiStatus(_ call: CAPPluginCall) {
        stateQueue.async { call.resolve(["wifi": self.wifiAvailable()]) }
    }

    @objc func request(_ call: CAPPluginCall) {
        let method = call.getString("method") ?? "GET"
        let maxResponseBytes = call.getInt("maxResponseBytes") ?? Self.defaultMaxResponseBytes
        let timeoutMs = call.getInt("timeoutMs") ?? Self.defaultTimeoutMs
        let anyNetwork = call.getBool("anyNetwork") ?? false
        guard let requestId = call.getString("requestId"), !requestId.isEmpty, requestId.count <= 128 else {
            call.reject("A valid requestId is required")
            return
        }
        guard let urlText = call.getString("url") else {
            call.reject("A content URL is required")
            return
        }
        guard method == "GET" || method == "HEAD" else {
            call.reject("Content transport only permits GET and HEAD requests")
            return
        }
        guard maxResponseBytes >= 1, maxResponseBytes <= Self.hardMaxResponseBytes else {
            call.reject("The content response byte limit is invalid")
            return
        }
        guard timeoutMs >= 1, timeoutMs <= Self.maxTimeoutMs else {
            call.reject("The content request timeout is invalid")
            return
        }
        let url: URL
        do {
            url = try Self.validateContentUrl(urlText, apiOrigin: call.getString("approvedApiOrigin"), cdnOrigin: call.getString("approvedCdnOrigin"))
        } catch {
            call.reject(Self.message(error, "The content URL is not approved"))
            return
        }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: Double(timeoutMs) / 1000)
        request.httpMethod = method
        do {
            try Self.applyHeaders(call.getObject("headers"), to: &request)
        } catch {
            call.reject("The content request contains an invalid header")
            return
        }
        let wifiRequired = !anyNetwork && Self.isWifiOnlyMapChunk(url)
        start(request, state: ActiveRequest(requestId: requestId, call: call, url: url, maxResponseBytes: maxResponseBytes, accountBackup: false, wifiRequired: wifiRequired))
    }

    @objc func accountRequest(_ call: CAPPluginCall) {
        let method = call.getString("method") ?? "GET"
        let bodyBase64 = call.getString("bodyBase64") ?? ""
        let maxRequestBytes = call.getInt("maxRequestBytes") ?? Self.maxAccountBackupBytes
        let maxResponseBytes = call.getInt("maxResponseBytes") ?? Self.maxAccountBackupBytes
        let timeoutMs = call.getInt("timeoutMs") ?? Self.defaultTimeoutMs
        guard let requestId = call.getString("requestId"), !requestId.isEmpty, requestId.count <= 128 else {
            call.reject("A valid requestId is required")
            return
        }
        guard let urlText = call.getString("url") else {
            call.reject("An account backup URL is required")
            return
        }
        guard bodyBase64.count <= ((Self.maxAccountBackupBytes + 2) / 3) * 4 + 4 else {
            call.reject("The account backup request exceeds its byte limit")
            return
        }
        guard let body = bodyBase64.isEmpty ? Data() : Data(base64Encoded: bodyBase64) else {
            call.reject("The account backup request body is invalid")
            return
        }
        let headers = Self.stringHeaders(call.getObject("headers"))
        let url: URL
        do {
            url = try Self.validateAccountBackupUrl(urlText, apiOrigin: call.getString("approvedApiOrigin"), method: method)
            try Self.validateAccountBackupBody(url, method: method, body: body)
            try Self.validateAccountBackupHeaders(headers, url: url, method: method)
        } catch {
            call.reject(Self.message(error, "The account backup request is not approved"))
            return
        }
        let routeLimit = Self.matches(url.path, "^/api/claims/\(Self.uuid)$") ? Self.maxClaimJsonBytes : Self.maxAccountBackupBytes
        guard maxRequestBytes >= 1, maxRequestBytes <= routeLimit, body.count <= maxRequestBytes else {
            call.reject("The account backup request byte limit is invalid")
            return
        }
        guard maxResponseBytes >= 1, maxResponseBytes <= Self.maxAccountBackupBytes else {
            call.reject("The account backup response byte limit is invalid")
            return
        }
        guard timeoutMs >= 1, timeoutMs <= Self.maxTimeoutMs else {
            call.reject("The account backup request timeout is invalid")
            return
        }
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: Double(timeoutMs) / 1000)
        request.httpMethod = method
        do {
            try Self.applyHeaders(call.getObject("headers"), to: &request)
        } catch {
            call.reject("The account backup request contains an invalid header")
            return
        }
        if method == "PUT" { request.httpBody = body }
        start(request, state: ActiveRequest(requestId: requestId, call: call, url: url, maxResponseBytes: maxResponseBytes, accountBackup: true, wifiRequired: false))
    }

    @objc func abort(_ call: CAPPluginCall) {
        let requestId = call.getString("requestId")
        stateQueue.async {
            if let requestId = requestId, let state = self.active[requestId] { self.fail(state, "Content request aborted") }
            call.resolve()
        }
    }

    // MARK: Requests

    private func start(_ request: URLRequest, state: ActiveRequest) {
        var request = request
        request.httpShouldHandleCookies = false
        request.setValue("identity", forHTTPHeaderField: "Accept-Encoding")
        // Detailed map chunks never use mobile data; iOS then waits for or fails on Wi-Fi itself.
        request.allowsCellularAccess = !state.wifiRequired
        stateQueue.async {
            guard self.foreground else {
                state.call.reject(state.accountBackup ? "Account backup requests require Parkdex to be in the foreground" : "Content requests require Parkdex to be in the foreground")
                return
            }
            guard self.active[state.requestId] == nil else {
                state.call.reject(state.accountBackup ? "A request already uses this requestId" : "A content request already uses this requestId")
                return
            }
            if state.wifiRequired && !self.wifiAvailable() {
                state.call.reject("Validated Wi-Fi is unavailable for detailed map downloads")
                return
            }
            if !state.wifiRequired && !self.anyNetworkAvailable() {
                state.call.reject(state.accountBackup ? "A validated internet connection is unavailable for account backup" : "A validated internet connection is unavailable for content downloads")
                return
            }
            let task = self.session.dataTask(with: request)
            state.task = task
            self.active[state.requestId] = state
            self.byTask[task.taskIdentifier] = state
            task.resume()
        }
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                           newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        // Returning nil delivers the 3xx itself, which is then rejected below.
        completionHandler(nil)
    }

    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                           completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        guard let state = byTask[dataTask.taskIdentifier], let http = response as? HTTPURLResponse else {
            completionHandler(.cancel)
            return
        }
        if http.expectedContentLength > Int64(state.maxResponseBytes) {
            completionHandler(.cancel)
            fail(state, state.accountBackup ? "Account backup response exceeds its byte limit" : "Content response exceeds its byte limit")
            return
        }
        state.response = http
        completionHandler(.allow)
    }

    public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        guard let state = byTask[dataTask.taskIdentifier] else { return }
        if state.body.count + data.count > state.maxResponseBytes {
            fail(state, state.accountBackup ? "Account backup response exceeds its byte limit" : "Content response exceeds its byte limit")
            return
        }
        state.body.append(data)
    }

    public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        guard let state = byTask[task.taskIdentifier] else { return }
        if error != nil {
            fail(state, state.wifiRequired ? "The Wi-Fi connection was lost" : state.accountBackup ? "Account backup request failed" : "Content request failed")
            return
        }
        guard let http = state.response else {
            fail(state, state.accountBackup ? "Account backup request failed" : "Content request failed")
            return
        }
        let status = http.statusCode
        if status < 200 || status > 599 {
            fail(state, state.accountBackup ? "Account backup server returned an invalid HTTP status" : "Content server returned an invalid HTTP status")
            return
        }
        if status >= 300 && status < 400 && status != 304 {
            fail(state, state.accountBackup ? "Account backup redirects are not permitted" : "Content server redirects are not permitted")
            return
        }
        let noBody = task.originalRequest?.httpMethod == "HEAD" || status == 204 || status == 205 || status == 304
        var headers: [String: Any] = [:]
        for (key, value) in http.allHeaderFields {
            guard let name = (key as? String)?.lowercased(), name != "set-cookie", name != "set-cookie2" else { continue }
            headers[name] = "\(value)"
        }
        finish(state)
        state.call.resolve([
            "status": status,
            "statusText": HTTPURLResponse.localizedString(forStatusCode: status),
            "headers": headers,
            "bodyBase64": noBody ? "" : state.body.base64EncodedString(),
            "url": state.url.absoluteString,
        ])
    }

    /// Must run on stateQueue.
    private func fail(_ state: ActiveRequest, _ message: String) {
        guard active[state.requestId] === state else { return }
        finish(state)
        state.task?.cancel()
        state.call.reject(message)
    }

    /// Must run on stateQueue.
    private func finish(_ state: ActiveRequest) {
        active.removeValue(forKey: state.requestId)
        if let task = state.task { byTask.removeValue(forKey: task.taskIdentifier) }
    }

    // MARK: Validation, as in WifiContentTransportPlugin.java

    struct TransportError: Error {
        let message: String
    }

    private static func message(_ error: Error, _ fallback: String) -> String {
        (error as? TransportError)?.message ?? fallback
    }

    private static func matches(_ value: String, _ pattern: String) -> Bool {
        value.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
    }

    static func isWifiOnlyMapChunk(_ url: URL) -> Bool {
        matches(url.path, "(^|/)map/island/[^/]+\\.bin$")
    }

    private static func httpsComponents(_ value: String, _ failure: String, portFailure: String) throws -> (URLComponents, String) {
        guard let components = URLComponents(string: value), components.scheme?.lowercased() == "https",
              let host = components.host?.lowercased(), !host.isEmpty,
              components.user == nil, components.password == nil, components.fragment == nil
        else { throw TransportError(message: failure) }
        if let port = components.port, port != 443 { throw TransportError(message: portFailure) }
        return (components, host)
    }

    private static func canonicalApprovedOrigin(_ value: String?, api: Bool) -> String? {
        guard let value = value, !value.isEmpty, let components = URLComponents(string: value),
              components.scheme?.lowercased() == "https", let host = components.host?.lowercased(),
              components.user == nil, components.password == nil, components.query == nil, components.fragment == nil,
              components.port == nil || components.port == 443,
              components.path.isEmpty || components.path == "/"
        else { return nil }
        if api ? !approvedApiHosts.contains(host) : host != "kip-assets.parkdex.app" { return nil }
        let origin = "https://" + host
        if !api && origin != approvedCdnOrigin { return nil }
        return origin
    }

    static func validateContentUrl(_ value: String, apiOrigin: String?, cdnOrigin: String?) throws -> URL {
        let (components, host) = try httpsComponents(
            value, "Content downloads require an approved HTTPS URL", portFailure: "Content downloads cannot use a custom port")
        let origin = "https://" + host
        let approved = (origin == canonicalApprovedOrigin(apiOrigin, api: true) && approvedApiHosts.contains(host))
            || (origin == canonicalApprovedOrigin(cdnOrigin, api: false) && host == "kip-assets.parkdex.app")
        guard approved, let url = components.url else { throw TransportError(message: "The content URL origin is not approved") }
        return url
    }

    static func validateAccountBackupUrl(_ value: String, apiOrigin: String?, method: String) throws -> URL {
        let (components, host) = try httpsComponents(
            value, "Account backup requires an approved HTTPS URL", portFailure: "Account backup cannot use a custom port")
        guard let approved = canonicalApprovedOrigin(apiOrigin, api: true), "https://" + host == approved else {
            throw TransportError(message: "The account backup origin is not approved")
        }
        let path = components.percentEncodedPath
        let query = components.percentEncodedQuery
        var allowed = false
        if path == "/api/claims" {
            allowed = method == "GET" && (query == nil || matches(query!, "^cursor=[A-Za-z0-9_-]{1,1024}$"))
        } else if matches(path, "^/api/claims/\(uuid)$") {
            allowed = method == "PUT" && query == nil
        } else if matches(path, "^/api/claims/\(uuid)/photo$") {
            allowed = (method == "GET" || method == "PUT") && query == nil
        } else if path == "/api/claims/display" {
            // A photo's display choices (#174): the list, and one photo's crop, cover and removal.
            allowed = method == "GET" && query == nil
        } else if matches(path, "^/api/claims/\(uuid)/display$") {
            allowed = method == "PUT" && query == nil
        }
        guard allowed, let url = components.url else { throw TransportError(message: "The account backup path or method is not approved") }
        return url
    }

    /// Claim records and a photo's display choices are small JSON bodies; photos are images.
    static func isJsonAccountRoute(_ path: String) -> Bool {
        matches(path, "^/api/claims/\(uuid)(/display)?$")
    }

    static func validateAccountBackupBody(_ url: URL, method: String, body: Data) throws {
        if method == "GET" {
            if !body.isEmpty { throw TransportError(message: "Account backup GET requests cannot contain a body") }
            return
        }
        let maximum = isJsonAccountRoute(url.path) ? maxClaimJsonBytes : maxAccountBackupBytes
        if method != "PUT" || body.isEmpty || body.count > maximum {
            throw TransportError(message: "The account backup request body is invalid or exceeds its byte limit")
        }
    }

    static func validateAccountBackupHeaders(_ headers: [String: String], url: URL, method: String) throws {
        func header(_ name: String) -> String? { headers.first { $0.key.lowercased() == name }?.value }
        guard let authorization = header("authorization"), matches(authorization, "^Bearer [^\\s]{1,4096}$") else {
            throw TransportError(message: "Native account backup requires a bearer session")
        }
        guard let accountId = header("x-kip-account-id"), matches(accountId, "^\(uuid)$") else {
            throw TransportError(message: "Native account backup requires an account scope")
        }
        guard header("x-kip-auth-transport") == "native" else { throw TransportError(message: "Native account backup requires the native transport marker") }
        if header("cookie") != nil { throw TransportError(message: "Native account backup does not accept cookies") }
        if method == "PUT" {
            let contentType = (header("content-type") ?? "").split(separator: ";", maxSplits: 1).first.map { $0.trimmingCharacters(in: .whitespaces).lowercased() } ?? ""
            let allowed = isJsonAccountRoute(url.path)
                ? contentType == "application/json"
                : ["image/jpeg", "image/png", "image/webp"].contains(contentType)
            if !allowed { throw TransportError(message: "Native account backup content type is not approved for this route") }
        }
    }

    private static func stringHeaders(_ headers: JSObject?) -> [String: String] {
        var result: [String: String] = [:]
        for (name, value) in headers ?? [:] {
            if let text = value as? String { result[name] = text } else if let number = value as? NSNumber { result[name] = number.stringValue }
        }
        return result
    }

    private static func applyHeaders(_ headers: JSObject?, to request: inout URLRequest) throws {
        for (name, value) in stringHeaders(headers) {
            let lower = name.lowercased()
            if blockedHeaders.contains(lower) || lower.hasPrefix("proxy-") || lower.hasPrefix("sec-") { continue }
            guard isHttpToken(name), !value.contains("\r"), !value.contains("\n") else { throw TransportError(message: "invalid header") }
            request.setValue(value, forHTTPHeaderField: name)
        }
    }

    private static func isHttpToken(_ value: String) -> Bool {
        !value.isEmpty && value.unicodeScalars.allSatisfy { scalar in
            CharacterSet.alphanumerics.contains(scalar) && scalar.isASCII || "!#$%&'*+-.^_`|~".unicodeScalars.contains(scalar)
        }
    }
}

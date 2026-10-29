import AuthenticationServices
import Capacitor
import CryptoKit
import Foundation
import UIKit

/// Sign-in and the saved session for the iOS app, with the same JavaScript surface as Android's
/// `NativeIdentityPlugin.java` plus Sign in with Apple.
///
/// - Google: the OAuth authorization-code flow with PKCE in `ASWebAuthenticationSession` (the system
///   browser sheet Google allows; never the WebView), using the iOS OAuth client the server names.
///   The server's nonce goes into the request, so the ID token carries it back.
/// - Apple: `ASAuthorizationAppleIDProvider` with the server's nonce passed through unchanged. The
///   identity token and the one-time authorization code go to the server, which verifies the first
///   and may trade the second for a refresh token it can revoke on account deletion.
/// - The session token lives in the Keychain (`KeychainSessionStore`).
///
/// Provider error text can contain user-specific data, so it is never returned or logged.
@objc(NativeIdentityPlugin)
public class NativeIdentityPlugin: CAPPlugin, CAPBridgedPlugin, ASWebAuthenticationPresentationContextProviding,
    ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    public let identifier = "NativeIdentityPlugin"
    public let jsName = "NativeIdentity"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "getGoogleIdToken", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getAppleCredential", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getSession", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "clearSession", returnType: CAPPluginReturnPromise),
    ]

    private static let googleClientPattern = try! NSRegularExpression(pattern: "^([0-9]+-[A-Za-z0-9_-]+)\\.apps\\.googleusercontent\\.com$")
    private let store = KeychainSessionStore()
    private let storageQueue = DispatchQueue(label: "app.parkdex.native-session")
    private var webSession: ASWebAuthenticationSession?
    private var appleCall: CAPPluginCall?
    private var appleController: ASAuthorizationController?

    // MARK: Google

    @objc func getGoogleIdToken(_ call: CAPPluginCall) {
        guard let clientId = call.getString("serverClientId")?.trimmingCharacters(in: .whitespaces), clientId.count <= 512,
              let match = Self.googleClientPattern.firstMatch(in: clientId, range: NSRange(clientId.startIndex..., in: clientId)),
              let prefixRange = Range(match.range(at: 1), in: clientId),
              let nonce = Self.validNonce(call.getString("nonce"))
        else {
            call.reject("Google sign-in is not configured for this request.")
            return
        }
        // An iOS OAuth client redirects to its reversed client ID; ASWebAuthenticationSession
        // catches that scheme itself, so it needs no CFBundleURLTypes entry.
        let scheme = "com.googleusercontent.apps." + String(clientId[prefixRange])
        let redirectUri = scheme + ":/oauth2redirect"
        let verifier = Self.randomURLSafe(bytes: 48)
        let state = Self.randomURLSafe(bytes: 24)
        let challenge = Data(SHA256.hash(data: Data(verifier.utf8))).base64URLEncodedString()
        var components = URLComponents(string: "https://accounts.google.com/o/oauth2/v2/auth")!
        components.queryItems = [
            URLQueryItem(name: "client_id", value: clientId),
            URLQueryItem(name: "redirect_uri", value: redirectUri),
            URLQueryItem(name: "response_type", value: "code"),
            URLQueryItem(name: "scope", value: "openid email profile"),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "nonce", value: nonce),
            URLQueryItem(name: "prompt", value: "select_account"),
        ]
        guard let authUrl = components.url else {
            call.reject("Google sign-in is unavailable right now.")
            return
        }

        DispatchQueue.main.async {
            guard self.webSession == nil, self.appleCall == nil else {
                call.reject("Another sign-in is already open.")
                return
            }
            let session = ASWebAuthenticationSession(url: authUrl, callbackURLScheme: scheme) { [weak self] callbackUrl, error in
                self?.webSession = nil
                guard error == nil, let callbackUrl = callbackUrl,
                      let items = URLComponents(url: callbackUrl, resolvingAgainstBaseURL: false)?.queryItems,
                      items.first(where: { $0.name == "state" })?.value == state,
                      let code = items.first(where: { $0.name == "code" })?.value, !code.isEmpty
                else {
                    call.reject("Google sign-in was canceled or could not be completed.")
                    return
                }
                self?.exchangeGoogleCode(code, clientId: clientId, redirectUri: redirectUri, verifier: verifier, call: call)
            }
            session.presentationContextProvider = self
            session.prefersEphemeralWebBrowserSession = false
            self.webSession = session
            if !session.start() {
                self.webSession = nil
                call.reject("Google sign-in is unavailable right now.")
            }
        }
    }

    private func exchangeGoogleCode(_ code: String, clientId: String, redirectUri: String, verifier: String, call: CAPPluginCall) {
        var request = URLRequest(url: URL(string: "https://oauth2.googleapis.com/token")!)
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.cachePolicy = .reloadIgnoringLocalCacheData
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        var form = URLComponents()
        form.queryItems = [
            URLQueryItem(name: "client_id", value: clientId),
            URLQueryItem(name: "code", value: code),
            URLQueryItem(name: "code_verifier", value: verifier),
            URLQueryItem(name: "grant_type", value: "authorization_code"),
            URLQueryItem(name: "redirect_uri", value: redirectUri),
        ]
        // URLComponents leaves "+" unescaped, which a form body would read as a space.
        request.httpBody = form.percentEncodedQuery?.replacingOccurrences(of: "+", with: "%2B").data(using: .utf8)
        let configuration = URLSessionConfiguration.ephemeral
        configuration.httpCookieStorage = nil
        URLSession(configuration: configuration).dataTask(with: request) { data, response, _ in
            guard let http = response as? HTTPURLResponse, http.statusCode == 200, let data = data,
                  let body = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  let idToken = (body["id_token"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines), !idToken.isEmpty
            else {
                call.reject("Google sign-in did not return an ID token.")
                return
            }
            call.resolve(["idToken": idToken])
        }.resume()
    }

    public func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        presentationWindow()
    }

    // MARK: Apple

    @objc func getAppleCredential(_ call: CAPPluginCall) {
        guard let nonce = Self.validNonce(call.getString("nonce")) else {
            call.reject("Sign in with Apple is not configured for this request.")
            return
        }
        DispatchQueue.main.async {
            guard self.webSession == nil, self.appleCall == nil else {
                call.reject("Another sign-in is already open.")
                return
            }
            let request = ASAuthorizationAppleIDProvider().createRequest()
            request.requestedScopes = [.fullName, .email]
            // Passed through unchanged: the server compares the token's nonce claim with the one it issued.
            request.nonce = nonce
            let controller = ASAuthorizationController(authorizationRequests: [request])
            controller.delegate = self
            controller.presentationContextProvider = self
            self.appleCall = call
            self.appleController = controller
            controller.performRequests()
        }
    }

    public func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        guard let call = finishApple() else { return }
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let tokenData = credential.identityToken, let identityToken = String(data: tokenData, encoding: .utf8), !identityToken.isEmpty
        else {
            call.reject("Sign in with Apple did not return an identity token.")
            return
        }
        var result: [String: Any] = ["identityToken": identityToken]
        if let codeData = credential.authorizationCode, let code = String(data: codeData, encoding: .utf8), !code.isEmpty {
            result["authorizationCode"] = code
        }
        // Apple shares the name only on the first sign-in on a device.
        if let given = credential.fullName?.givenName, !given.isEmpty { result["givenName"] = given }
        if let family = credential.fullName?.familyName, !family.isEmpty { result["familyName"] = family }
        call.resolve(result)
    }

    public func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        guard let call = finishApple() else { return }
        if (error as? ASAuthorizationError)?.code == .canceled {
            call.reject("Sign in with Apple was canceled.", "canceled")
        } else {
            call.reject("Sign in with Apple could not be completed.")
        }
    }

    public func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        presentationWindow()
    }

    private func finishApple() -> CAPPluginCall? {
        let call = appleCall
        appleCall = nil
        appleController = nil
        return call
    }

    // MARK: Session

    @objc func setSession(_ call: CAPPluginCall) {
        guard let token = call.getString("token"), let apiOrigin = call.getString("apiOrigin"),
              let expiresAt = call.getDouble("expiresAt"), expiresAt.isFinite
        else {
            call.reject("A valid native session is required.")
            return
        }
        let expiry = Int64(expiresAt)
        if expiry <= KeychainSessionStore.nowMillis() {
            call.reject("The native session has expired.")
            return
        }
        storageQueue.async {
            do {
                try self.store.write(token: token, expiresAt: expiry, apiOrigin: apiOrigin)
                call.resolve()
            } catch {
                call.reject("Unable to securely save the native session.")
            }
        }
    }

    @objc func getSession(_ call: CAPPluginCall) {
        storageQueue.async {
            do {
                guard let session = try self.store.read() else {
                    call.resolve()
                    return
                }
                call.resolve(["token": session.token, "expiresAt": Double(session.expiresAt), "apiOrigin": session.apiOrigin])
            } catch {
                call.reject("Unable to read the secure native session.")
            }
        }
    }

    /// Google and Apple keep no credential state in the app to clear, so only the session goes.
    @objc func clearSession(_ call: CAPPluginCall) {
        storageQueue.async {
            do {
                try self.store.clear()
                call.resolve()
            } catch {
                call.reject("Unable to clear the secure native session.")
            }
        }
    }

    // MARK: Helpers

    private func presentationWindow() -> ASPresentationAnchor {
        if let window = bridge?.webView?.window { return window }
        let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
        return scenes.flatMap { $0.windows }.first { $0.isKeyWindow } ?? ASPresentationAnchor()
    }

    private static func validNonce(_ value: String?) -> String? {
        guard let nonce = value, !nonce.isEmpty, nonce.count <= 512, nonce == nonce.trimmingCharacters(in: .whitespacesAndNewlines) else { return nil }
        return nonce
    }

    private static func randomURLSafe(bytes count: Int) -> String {
        var bytes = [UInt8](repeating: 0, count: count)
        if SecRandomCopyBytes(kSecRandomDefault, count, &bytes) != errSecSuccess {
            bytes = (0..<count).map { _ in UInt8.random(in: 0...255) }
        }
        return Data(bytes).base64URLEncodedString()
    }
}

fileprivate extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
    }
}

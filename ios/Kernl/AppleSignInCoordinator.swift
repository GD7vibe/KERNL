import AuthenticationServices
import CryptoKit
import UIKit

/// Native Sign in with Apple. The identity token is handed back to the page, which
/// calls Supabase (`signInWithIdToken` or `linkIdentity`). The session then lives in
/// the same place as email and Google sign-in.
final class AppleSignInCoordinator: NSObject, ASAuthorizationControllerDelegate, ASAuthorizationControllerPresentationContextProviding {
    static let shared = AppleSignInCoordinator()

    private var continuation: CheckedContinuation<[String: Any], Never>?
    private var controller: ASAuthorizationController?
    private var window: UIWindow?
    private var rawNonce = ""

    func signIn(from window: UIWindow?) async -> [String: Any] {
        guard continuation == nil else {
            return ["ok": false, "error": "Apple sign-in is already open."]
        }
        guard let window else {
            return ["ok": false, "error": "Apple sign-in could not be shown. Please try again."]
        }
        self.window = window
        rawNonce = Self.randomNonce()
        let request = ASAuthorizationAppleIDProvider().createRequest()
        request.requestedScopes = [.fullName, .email]
        request.nonce = Self.sha256(rawNonce)
        let controller = ASAuthorizationController(authorizationRequests: [request])
        controller.delegate = self
        controller.presentationContextProvider = self
        self.controller = controller
        return await withCheckedContinuation { continuation in
            self.continuation = continuation
            controller.performRequests()
        }
    }

    func presentationAnchor(for controller: ASAuthorizationController) -> ASPresentationAnchor {
        window ?? ASPresentationAnchor()
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithAuthorization authorization: ASAuthorization) {
        defer { self.controller = nil }
        guard let credential = authorization.credential as? ASAuthorizationAppleIDCredential,
              let tokenData = credential.identityToken,
              let token = String(data: tokenData, encoding: .utf8), !token.isEmpty else {
            finish(["ok": false, "error": "Apple did not return a sign-in token. Please try again."])
            return
        }
        finish([
            "ok": true,
            "identityToken": token,
            "nonce": rawNonce,
            "givenName": credential.fullName?.givenName ?? "",
            "familyName": credential.fullName?.familyName ?? ""
        ])
    }

    func authorizationController(controller: ASAuthorizationController, didCompleteWithError error: Error) {
        controllerFinished()
        if let auth = error as? ASAuthorizationError, auth.code == .canceled {
            finish(["ok": false, "code": "cancelled"])
            return
        }
        #if DEBUG
        print("[KERNL] Sign in with Apple failed: \(error.localizedDescription)")
        #endif
        finish(["ok": false, "error": "Apple sign-in is not available right now. Please try again."])
    }

    private func controllerFinished() {
        controller = nil
    }

    private func finish(_ result: [String: Any]) {
        continuation?.resume(returning: result)
        continuation = nil
        controller = nil
    }

    private static func randomNonce(length: Int = 32) -> String {
        let charset = Array("0123456789ABCDEFGHIJKLMNOPQRSTUVXYZabcdefghijklmnopqrstuvwxyz-._")
        var bytes = [UInt8](repeating: 0, count: length)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        if status != errSecSuccess {
            return UUID().uuidString.replacingOccurrences(of: "-", with: "")
        }
        return String(bytes.map { charset[Int($0) % charset.count] })
    }

    /// Hex SHA-256. Apple receives this. Supabase receives the raw nonce and hashes it the same way.
    private static func sha256(_ value: String) -> String {
        SHA256.hash(data: Data(value.utf8)).map { String(format: "%02x", $0) }.joined()
    }
}

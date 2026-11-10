import AuthenticationServices
import UIKit

/// Opens Google (and web Apple) sign-in in a secure browser session.
/// Google rejects the embedded web view, so the page is not left to do this itself.
/// The return address is the custom scheme from Shared.xcconfig, which does not need a Team ID.
final class AuthSessionCoordinator: NSObject, ASWebAuthenticationPresentationContextProviding {
    static let shared = AuthSessionCoordinator()

    private var session: ASWebAuthenticationSession?
    private var window: UIWindow?
    var onCallback: ((URL) -> Void)?

    func start(url: URL, from window: UIWindow?) -> Bool {
        let scheme = KernlConfig.oauthScheme
        guard !scheme.isEmpty else { return false }
        let startURL = rewritingRedirect(url)
        let session = ASWebAuthenticationSession(url: startURL, callback: .customScheme(scheme)) { [weak self] callbackURL, error in
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.session = nil
                if let callbackURL, let page = self.pageURL(from: callbackURL) {
                    self.onCallback?(page)
                    return
                }
                if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin { return }
                #if DEBUG
                if let error { print("[KERNL] sign-in session: \(error.localizedDescription)") }
                #endif
            }
        }
        session.presentationContextProvider = self
        session.prefersEphemeralWebBrowserSession = false
        self.window = window
        self.session = session
        let started = session.start()
        if !started { self.session = nil }
        return started
    }

    func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
        window ?? ASPresentationAnchor()
    }

    /// Supabase must be allowed to redirect to `kernl://auth`. Rewriting here means the
    /// website can keep its https address, and only the app uses the custom scheme.
    func rewritingRedirect(_ url: URL) -> URL {
        let redirect = KernlConfig.oauthRedirect
        guard !redirect.isEmpty, var components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return url }
        guard var items = components.queryItems, let index = items.firstIndex(where: { $0.name == "redirect_to" }) else { return url }
        items[index].value = redirect
        components.queryItems = items
        return components.url ?? url
    }

    /// Turns `kernl://auth?code=…` into a page on the current host so Supabase JS can finish sign-in.
    func pageURL(from callback: URL) -> URL? {
        guard callback.scheme?.lowercased() == KernlConfig.oauthScheme.lowercased(),
              let host = KernlConfig.webHost else { return nil }
        var components = URLComponents(url: host.appending(path: "app.html"), resolvingAgainstBaseURL: false)
        components?.query = callback.query
        components?.fragment = callback.fragment
        return components?.url
    }
}

import SwiftUI
import UIKit
import WebKit

/// The existing KERNL site, plus the native pieces around it.
/// Pages on the KERNL host stay here. Other links open in Safari.
/// StoreKit, Sign in with Apple and the sign-in browser session are not part of the page.
struct WebShellView: UIViewRepresentable {
    @ObservedObject var model: WebModel

    func makeCoordinator() -> Coordinator {
        Coordinator(model: model)
    }

    func makeUIView(context: Context) -> KernlWebView {
        let configuration = WKWebViewConfiguration()
        configuration.applicationNameForUserAgent = "KERNL-iOS"
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.allowsInlineMediaPlayback = true
        configuration.mediaTypesRequiringUserActionForPlayback = []
        let controller = WKUserContentController()
        controller.addUserScript(WKUserScript(source: KernlBridge.source, injectionTime: .atDocumentStart, forMainFrameOnly: true))
        controller.add(context.coordinator, name: "kernl")
        configuration.userContentController = controller

        let webView = KernlWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        webView.allowsBackForwardNavigationGestures = true
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.applyPaper()
        let refresh = UIRefreshControl()
        refresh.addTarget(context.coordinator, action: #selector(Coordinator.refresh(_:)), for: .valueChanged)
        webView.scrollView.refreshControl = refresh

        context.coordinator.attach(webView)
        StoreCoordinator.shared.webView = webView
        AuthSessionCoordinator.shared.onCallback = { [weak model] url in
            Task { @MainActor in
                model?.deliver(url)
            }
        }
        model.load = { [weak webView] url in webView?.load(URLRequest(url: url)) }
        model.reload = { [weak webView] in webView?.reload() }

        if let url = KernlConfig.webHost?.appending(path: "app.html") {
            webView.load(URLRequest(url: url))
        } else {
            model.pageFailed("The app is missing its website address.")
        }
        return webView
    }

    func updateUIView(_ webView: KernlWebView, context: Context) {
        StoreCoordinator.shared.webView = webView
        webView.applyPaper()
    }

    static func dismantleUIView(_ webView: KernlWebView, coordinator: Coordinator) {
        webView.configuration.userContentController.removeScriptMessageHandler(forName: "kernl")
        coordinator.invalidate()
    }
}

final class KernlWebView: WKWebView {
    override func traitCollectionDidChange(_ previousTraitCollection: UITraitCollection?) {
        super.traitCollectionDidChange(previousTraitCollection)
        applyPaper()
    }

    func applyPaper() {
        let dark = traitCollection.userInterfaceStyle == .dark
        let colour = dark
            ? UIColor(red: 0.082, green: 0.067, blue: 0.165, alpha: 1)
            : UIColor(red: 0.953, green: 0.925, blue: 0.984, alpha: 1)
        isOpaque = false
        backgroundColor = colour
        scrollView.backgroundColor = colour
    }
}

final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
    let model: WebModel
    private weak var webView: WKWebView?
    private var progress: NSKeyValueObservation?

    init(model: WebModel) {
        self.model = model
    }

    func attach(_ webView: WKWebView) {
        self.webView = webView
        progress = webView.observe(\.estimatedProgress, options: [.new]) { [weak self] view, _ in
            let value = view.estimatedProgress
            Task { @MainActor in
                self?.model.progress = value
                self?.model.loading = value < 0.98
            }
        }
    }

    func invalidate() {
        progress?.invalidate()
        progress = nil
    }

    @objc func refresh(_ sender: UIRefreshControl) {
        webView?.reload()
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "kernl",
              let body = message.body as? [String: Any],
              let id = body["id"] as? String,
              let name = body["name"] as? String else { return }
        let payload = body["payload"] as? [String: Any] ?? [:]
        let window = webView?.window
        Task { @MainActor in
            let result = await self.handle(name: name, payload: payload, window: window)
            self.resolve(id: id, result: result)
        }
    }

    @MainActor
    private func handle(name: String, payload: [String: Any], window: UIWindow?) async -> [String: Any] {
        switch name {
        case "purchase":
            let productId = payload["productId"] as? String ?? ""
            return await StoreCoordinator.shared.purchase(productId: productId)
        case "restore":
            return await StoreCoordinator.shared.restore()
        case "appleSignIn":
            return await AppleSignInCoordinator.shared.signIn(from: window ?? webView?.window)
        default:
            return ["ok": false, "error": "The app could not complete that."]
        }
    }

    @MainActor
    private func resolve(id: String, result: [String: Any]) {
        guard let webView,
              JSONSerialization.isValidJSONObject(result),
              let data = try? JSONSerialization.data(withJSONObject: result),
              let json = String(data: data, encoding: .utf8) else { return }
        let call = "window.__kernlNativeResolve && window.__kernlNativeResolve(\(Self.js(id)), \(json))"
        webView.evaluateJavaScript(call, completionHandler: nil)
    }

    private static func js(_ value: String) -> String {
        let escaped = value
            .replacingOccurrences(of: "\\", with: "\\\\")
            .replacingOccurrences(of: "'", with: "\\'")
        return "'\(escaped)'"
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else {
            decisionHandler(.allow)
            return
        }
        if url.scheme == "about" {
            decisionHandler(.allow)
            return
        }
        if navigationAction.targetFrame == nil && Self.isAppPage(url) {
            decisionHandler(.cancel)
            webView.load(URLRequest(url: url))
            return
        }
        if url.scheme?.lowercased() == KernlConfig.oauthScheme.lowercased() {
            decisionHandler(.cancel)
            if let page = AuthSessionCoordinator.shared.pageURL(from: url) {
                webView.load(URLRequest(url: page))
            }
            return
        }
        let mainFrame = navigationAction.targetFrame.map(\.isMainFrame) ?? true
        if mainFrame && Self.isSupabaseAuthorize(url) {
            if AuthSessionCoordinator.shared.start(url: url, from: webView.window) {
                decisionHandler(.cancel)
                return
            }
        }
        if mainFrame && !Self.isAppPage(url) {
            decisionHandler(.cancel)
            if let scheme = url.scheme?.lowercased(), ["http", "https", "mailto", "tel"].contains(scheme) {
                UIApplication.shared.open(url)
            }
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        guard let url = navigationAction.request.url else { return nil }
        if Self.isAppPage(url) {
            webView.load(URLRequest(url: url))
        } else if let scheme = url.scheme?.lowercased(), ["http", "https", "mailto", "tel"].contains(scheme) {
            UIApplication.shared.open(url)
        }
        return nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.scrollView.refreshControl?.endRefreshing()
        Task { @MainActor in
            model.pageLoaded()
            StoreCoordinator.shared.drainUnfinished()
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        note(error)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        note(error)
    }

    private func note(_ error: Error) {
        webView?.scrollView.refreshControl?.endRefreshing()
        let code = (error as NSError).code
        if code == NSURLErrorCancelled { return }
        Task { @MainActor in
            model.pageFailed("KERNL could not be reached. Check your connection and try again.")
        }
    }

    private static func isAppPage(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "https", let host = url.host?.lowercased() else { return false }
        return KernlConfig.allowedPageHosts.contains(host)
    }

    private static func isSupabaseAuthorize(_ url: URL) -> Bool {
        guard url.scheme?.lowercased() == "https",
              let host = url.host?.lowercased(),
              !KernlConfig.supabaseHost.isEmpty else { return false }
        return host == KernlConfig.supabaseHost && url.path.contains("/auth/v1/authorize")
    }
}

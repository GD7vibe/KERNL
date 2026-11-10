import Foundation

/// Values that identify the app, the subscription and the website it loads.
/// They are written once, in `ios/Config/Shared.xcconfig`, substituted into Info.plist
/// at build time, and read back here. Swift source does not repeat them.
enum KernlConfig {
    private static func info(_ key: String) -> String {
        let raw = (Bundle.main.object(forInfoDictionaryKey: key) as? String) ?? ""
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.isEmpty || value.contains("$(") { return "" }
        return value
    }

    private static func httpsURL(_ string: String) -> URL? {
        guard let url = URL(string: string), url.scheme == "https", let host = url.host, !host.isEmpty else { return nil }
        return url
    }

    /// Bundle id from the signed app. Set by PRODUCT_BUNDLE_IDENTIFIER in Shared.xcconfig.
    static var bundleID: String { Bundle.main.bundleIdentifier ?? "" }

    /// StoreKit product id. Written as KERNL_PRODUCT_ID in Shared.xcconfig.
    static var proProductID: String { info("KernlProductID") }

    /// Custom URL scheme so an OAuth redirect can return to the app (`kernl://auth`).
    static var oauthScheme: String { info("KernlOAuthScheme") }

    static var oauthRedirect: String {
        let scheme = oauthScheme
        return scheme.isEmpty ? "" : "\(scheme)://auth"
    }

    static var productionHost: URL? { httpsURL(info("KernlProductionHost")) }
    static var stagingHost: URL? { httpsURL(info("KernlStagingHost")) }

    /// The site this build loads. Release is the live site. Debug is staging unless
    /// the scheme sets KERNL_WEB_HOST. Release ignores that variable.
    static var webHost: URL? {
        #if DEBUG
        if let override = ProcessInfo.processInfo.environment["KERNL_WEB_HOST"], let url = httpsURL(override) {
            return url
        }
        #endif
        return httpsURL(info("KernlWebHost"))
    }

    static var supabaseHost: String { info("KernlSupabaseHost").lowercased() }

    /// Hosts whose pages stay inside the app. Anything else opens in Safari.
    static var allowedPageHosts: Set<String> {
        var hosts = Set<String>()
        for candidate in [productionHost, stagingHost, webHost] {
            guard let host = candidate?.host?.lowercased() else { continue }
            hosts.insert(host)
            if !host.hasPrefix("www.") { hosts.insert("www." + host) }
        }
        return hosts
    }

    static var isStaging: Bool {
        guard let current = webHost?.host?.lowercased(), let live = productionHost?.host?.lowercased() else { return false }
        return current != live
    }
}

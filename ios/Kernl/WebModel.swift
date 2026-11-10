import Combine
import Foundation

/// Native shell state: splash, staging banner, load errors, and where OAuth should land.
@MainActor
final class WebModel: ObservableObject {
    @Published var showSplash = true
    @Published var loadError: String?
    @Published var loading = true
    @Published var progress: Double = 0

    private let started = Date()
    private var revealed = false

    var load: ((URL) -> Void)?
    var reload: (() -> Void)?

    var isStaging: Bool { KernlConfig.isStaging }

    private var lastDelivery: (url: String, at: Date)?

    func deliver(_ url: URL) {
        let key = url.absoluteString
        if let last = lastDelivery, last.url == key, Date().timeIntervalSince(last.at) < 2 { return }
        lastDelivery = (key, Date())
        load?(url)
    }

    func pageLoaded() {
        loading = false
        guard !revealed else { return }
        revealed = true
        let wait = max(0, 0.45 - Date().timeIntervalSince(started))
        Task {
            try? await Task.sleep(nanoseconds: UInt64(wait * 1_000_000_000))
            showSplash = false
            loadError = nil
        }
    }

    func pageFailed(_ message: String) {
        loading = false
        guard !revealed else { return }
        loadError = message
    }

    func retry() {
        loadError = nil
        loading = true
        progress = 0
        if revealed {
            reload?()
            return
        }
        if let url = KernlConfig.webHost?.appending(path: "app.html") {
            load?(url)
        } else {
            pageFailed("The app is missing its website address.")
        }
    }
}

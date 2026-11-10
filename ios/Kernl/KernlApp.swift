import SwiftUI

@main
struct KernlApp: App {
    init() {
        StoreCoordinator.shared.start()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
        }
    }
}

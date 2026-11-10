import SwiftUI

struct RootView: View {
    @Environment(\.scenePhase) private var scenePhase
    @StateObject private var model = WebModel()

    var body: some View {
        ZStack(alignment: .top) {
            WebShellView(model: model)
                .ignoresSafeArea()
            if model.loading && !model.showSplash {
                ProgressView(value: min(max(model.progress, 0.05), 1))
                    .progressViewStyle(.linear)
                    .tint(Color(red: 0.137, green: 0.541, blue: 0.514))
                    .frame(height: 3)
                    .padding(.top, 1)
            }
            if model.isStaging {
                Text("Staging")
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(Color(red: 0.106, green: 0.082, blue: 0.200))
                    .padding(.horizontal, 8)
                    .padding(.vertical, 3)
                    .background(.white.opacity(0.92), in: Capsule())
                    .padding(.top, 6)
                    .allowsHitTesting(false)
            }
            if model.showSplash {
                SplashView(error: model.loadError, retry: model.retry)
                    .transition(.opacity)
            }
        }
        .animation(.easeOut(duration: 0.25), value: model.showSplash)
        .onOpenURL { url in
            if let page = AuthSessionCoordinator.shared.pageURL(from: url) {
                model.deliver(page)
            }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase == .active {
                StoreCoordinator.shared.drainUnfinished()
            }
        }
    }
}

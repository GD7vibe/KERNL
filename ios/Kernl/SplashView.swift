import SwiftUI

/// Shown over the web view until the first page loads. The launch storyboard uses the same colours,
/// so the hand-off is one continuous splash rather than a blank web view.
struct SplashView: View {
    var error: String?
    var retry: () -> Void

    private let paper = Color(red: 0.953, green: 0.925, blue: 0.984)
    private let ink = Color(red: 0.106, green: 0.082, blue: 0.200)
    private let accent = Color(red: 0.137, green: 0.541, blue: 0.514)
    private let muted = Color(red: 0.404, green: 0.373, blue: 0.510)

    var body: some View {
        ZStack {
            paper.ignoresSafeArea()
            VStack(spacing: 10) {
                wordmark
                Text("Read less. Know more.")
                    .font(.system(size: 13, weight: .medium))
                    .tracking(1.5)
                    .textCase(.uppercase)
                    .foregroundStyle(muted)
                if let error {
                    Text(error)
                        .font(.system(size: 15))
                        .foregroundStyle(ink)
                        .multilineTextAlignment(.center)
                        .padding(.top, 18)
                        .padding(.horizontal, 28)
                    Button("Try again", action: retry)
                        .font(.system(size: 16, weight: .semibold))
                        .foregroundStyle(.white)
                        .padding(.horizontal, 22)
                        .padding(.vertical, 12)
                        .background(accent, in: Capsule())
                        .padding(.top, 8)
                }
            }
        }
    }

    private var wordmark: some View {
        HStack(spacing: 0) {
            Text("K").foregroundStyle(ink)
            Text("E").foregroundStyle(accent)
            Text("RNL").foregroundStyle(ink)
        }
        .font(.system(size: 40, weight: .semibold))
        .tracking(4)
    }
}

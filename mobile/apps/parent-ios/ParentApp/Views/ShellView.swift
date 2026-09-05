import SwiftUI

/* THE FRAME AROUND THE PAGE. Bottom to top: the page, the failure panel, the
   loading screen, the banner, the lock, the progress bar, the toast. The
   order is the same as the Android root FrameLayout and matters for the same
   reasons: a parent who has asked for a face check must not be shown a
   loading screen with yesterday's fees sitting behind it, so the lock is above
   the splash; and the banner sits over the page rather than replacing it. */
struct ShellView: View {
    @ObservedObject var shell: WebShell

    var body: some View {
        ZStack(alignment: .top) {
            /* The page's own ground colour under everything, out to the
               edges, so the strips beside the notch and under the home
               indicator are never a different colour from the page. */
            Color("PageBackground").ignoresSafeArea()

            /* Hidden, never removed, while the panel or the lock is up: the
               page and its session are left exactly where they were, so a
               retry or an unlock shows the screen the parent was on. */
            WebContainer(shell: shell)
                .opacity(shell.failure == nil && !shell.locked ? 1 : 0)
                .allowsHitTesting(shell.failure == nil && !shell.locked)

            PullSpinner(pull: shell.pull)

            if let failure = shell.failure {
                OfflineView(failure: failure) { shell.retry() }
                    .transition(.opacity)
            }

            if shell.splashVisible {
                SplashView(snapshot: shell.snapshot)
                    .transition(.opacity.animation(.easeOut(duration: 0.16)))
                    .zIndex(1)
            }

            if let text = shell.banner {
                BannerView(text: text) { shell.hideBanner() }
                    .transition(.move(edge: .top).combined(with: .opacity))
                    .zIndex(2)
            }

            if shell.locked {
                LockView { shell.askToUnlock() }
                    .zIndex(3)
            }

            if shell.loading && shell.failure == nil {
                ProgressBar(value: shell.progress)
                    .zIndex(4)
            }

            if let toast = shell.toast {
                ToastView(text: toast.text, open: toast.file == nil ? nil : { shell.openToast() })
                    .transition(.move(edge: .bottom).combined(with: .opacity))
                    .zIndex(5)
            }
        }
        .animation(.easeInOut(duration: 0.2), value: shell.banner)
        .animation(.easeInOut(duration: 0.2), value: shell.toast)
        .animation(.easeOut(duration: 0.16), value: shell.splashVisible)
    }
}

/* A thin line of progress along the top, as the Android shell draws. Gone at
   100, which the loading flag decides. */
private struct ProgressBar: View {
    let value: Double

    var body: some View {
        GeometryReader { geo in
            Rectangle()
                .fill(Color.accentColor)
                .frame(width: max(0, geo.size.width * value), height: 3)
                .animation(.linear(duration: 0.15), value: value)
        }
        .frame(height: 3)
        .allowsHitTesting(false)
    }
}

/* The pull-to-refresh spinner: rests above the top edge and is drawn down by
   the gesture's damped travel. */
private struct PullSpinner: View {
    let pull: WebShell.Pull

    var body: some View {
        ProgressView()
            .progressViewStyle(.circular)
            .padding(8)
            .background(Color("PageBackground").opacity(0.9), in: Circle())
            .offset(y: -40 + pull.travel)
            .opacity(pull.visible ? Double(pull.alpha) : 0)
            .animation(pull.visible ? nil : .easeOut(duration: 0.2), value: pull.travel)
            .allowsHitTesting(false)
    }
}

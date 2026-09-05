import SwiftUI

/* THE TEN SECONDS THIS APP IS ACTUALLY JUDGED ON.

   The system launch screen covers the launch and nothing else. Everything
   after it, which on mobile data is most of the wait, would be a flat
   coloured rectangle: the React bundle has to come down the wire, parse and
   boot before the web view has a pixel to show. A parent cannot tell that
   rectangle from an app that has hung.

   So the rectangle carries three things instead. The school's mark, the same
   one the launch screen just showed, so the handover looks like one screen
   rather than two. A spinner, because a still picture cannot say "working".
   And, behind both, the last screen this parent was on, dimmed: see
   LastScreen for what that is and when it is refused.

   All on the page's own background colour: the eye reads a colour change as
   a new screen and no colour change as one screen filling in. */
struct SplashView: View {
    let snapshot: UIImage?

    var body: some View {
        ZStack {
            Color("PageBackground")
            if let snapshot {
                /* Faint on purpose. It has to read as the memory of a screen
                   rather than as the screen: nothing on it responds, and a
                   parent who believed it was live would tap a fee row and get
                   nothing. */
                Image(uiImage: snapshot)
                    .resizable()
                    .scaledToFill()
                    .opacity(0.3)
                    .clipped()
            }
            VStack(spacing: 8) {
                Image("SplashMark")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 128, height: 128)
                ProgressView()
                    .progressViewStyle(.circular)
            }
        }
        .ignoresSafeArea()
        /* Swallows touches. Without this a tap aimed at the dimmed picture
           lands on the live page underneath, which is a page the parent
           cannot see and may not be the one in the picture. */
        .contentShape(Rectangle())
        .onTapGesture {}
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(L10n.splashLoading)
    }
}

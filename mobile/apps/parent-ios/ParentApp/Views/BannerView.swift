import SwiftUI

/* THE BANNER, WHICH IS THE POINT OF NOT USING THE PANEL. One line over the
   top of a page that still works, gone in a few seconds. Tappable because it
   sits over the site's own header, and it must take the tap itself: otherwise
   it goes through to whatever the site has under it, which on the bus screen
   is the map. */
struct BannerView: View {
    let text: String
    let dismiss: () -> Void

    var body: some View {
        Text(text)
            .font(.footnote)
            .foregroundColor(.white)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(Color("BannerBackground"))
            .contentShape(Rectangle())
            .onTapGesture(perform: dismiss)
    }
}

/* Said at the bottom and gone by itself: the download acknowledgements, which
   on Android are toasts and here are this. */
struct ToastView: View {
    let text: String
    /* Set when the toast is about a file that now exists: the toast becomes
       the way to open it, and says so. */
    var open: (() -> Void)? = nil

    var body: some View {
        VStack {
            Spacer()
            HStack(spacing: 10) {
                Text(text)
                    .font(.footnote)
                    .multilineTextAlignment(open == nil ? .center : .leading)
                if open != nil {
                    Text(L10n.open)
                        .font(.footnote.weight(.semibold))
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(Color.white.opacity(0.18), in: Capsule())
                }
            }
            .foregroundColor(.white)
            .padding(.horizontal, 16)
            .padding(.vertical, 12)
            .background(Color("BannerBackground"), in: RoundedRectangle(cornerRadius: 12))
            .padding(.horizontal, 24)
            .padding(.bottom, 16)
            .contentShape(Rectangle())
            .onTapGesture { open?() }
            .accessibilityAddTraits(open == nil ? [] : .isButton)
        }
        .allowsHitTesting(open != nil)
    }
}

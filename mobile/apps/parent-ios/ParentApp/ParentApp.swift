import SwiftUI

/* THE PARENT APP, FOR IPHONE.

   The portal already is the parent's whole product, it is responsive, and it
   is installable to the home screen from Safari's share sheet. This exists
   because a school hands parents an app: a link that has to be opened in
   Safari and then added from a submenu is a step most families will not
   complete, and an icon on the App Store is one they will. It is the sibling
   of mobile/apps/parent, the Android shell, and does the same job the same
   way: a shell around the same site, and deliberately nothing more. */
@main
struct ParentApp: App {
    @StateObject private var shell = WebShell()
    @Environment(\.scenePhase) private var phase

    var body: some Scene {
        WindowGroup {
            ShellView(shell: shell)
                /* A universal link into the portal, from an SMS or an email,
                   arriving at a running app or starting it. Only the narrow
                   slice DeepLink accepts is honoured. */
                .onOpenURL { url in
                    if let accepted = DeepLink.accept(url) { shell.open(deepLink: accepted) }
                }
        }
        .onChange(of: phase) { next in
            switch next {
            case .active: shell.becameActive()
            case .inactive: shell.becameInactive()
            case .background: shell.wentToBackground()
            default: break
            }
        }
    }
}

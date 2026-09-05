import UIKit

/* THE PHONE ANSWERS A PRESS, FROM THE PHONE.

   The site asks for a tick under the thumb; in a browser it uses
   navigator.vibrate, which iOS ignores entirely. The shell offers the
   handset's own tuned clicks through the bridge instead, and the site asks
   for those first (web/src/lib/haptics.ts). The kinds are the site's five;
   the mapping onto UIKit's three generators follows what each one means
   rather than how long Android's pulse for it was. */
enum Haptics {
    private static let impact = UIImpactFeedbackGenerator(style: .light)
    private static let selection = UISelectionFeedbackGenerator()
    private static let notice = UINotificationFeedbackGenerator()

    static func play(_ kind: String) {
        switch kind {
        case "warn":
            notice.notificationOccurred(.error)
        case "open":
            notice.notificationOccurred(.success)
        case "select", "snap":
            selection.selectionChanged()
        default:
            impact.impactOccurred()
        }
    }
}

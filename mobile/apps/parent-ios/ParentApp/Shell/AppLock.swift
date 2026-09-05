import Foundation
import LocalAuthentication

/* THE APP LOCK.

   A parent who turns it on (Profile → App lock in the portal) is asking the
   phone, not the school, to check it is them before the portal is shown
   again. When the app has been away for a minute or more the page is hidden
   behind a panel and the phone's own prompt is raised: Face ID, Touch ID or
   the passcode. Nothing about the face or the fingerprint ever reaches the
   site; the site is only told, through the bridge, whether the switch is on.

   The switch lives in UserDefaults. It is a preference, not a secret: knowing
   the lock is on tells nobody anything they cannot see by opening the app. */
enum AppLock {
    private static let key = "app_lock"
    static let lockAfter: TimeInterval = 60

    static var enabled: Bool {
        get { UserDefaults.standard.bool(forKey: key) }
        set {
            UserDefaults.standard.set(newValue, forKey: key)
            /* Turning the lock on has to take away the picture of the portal
               that is already on disk, not merely stop writing new ones.
               Otherwise the very next cold start shows, behind the unlock
               panel, the screen the lock was turned on to hide. */
            if newValue { LastScreen.clear() }
        }
    }

    /* .deviceOwnerAuthentication rather than the biometrics-only policy: a
       phone with a passcode and no face enrolled can still lock, and a face
       that fails three times falls back to the passcode instead of a wall. */
    static var available: Bool {
        LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil)
    }

    /* Completion on the main thread. A false is "cancelled, too many tries,
       or the sensor is busy"; the panel stays and its button asks again. */
    static func ask(_ done: @escaping (Bool) -> Void) {
        let context = LAContext()
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: nil) else {
            // No passcode on the phone: there is nothing to ask for.
            DispatchQueue.main.async { done(true) }
            return
        }
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: L10n.lockBody) { ok, _ in
            DispatchQueue.main.async { done(ok) }
        }
    }
}

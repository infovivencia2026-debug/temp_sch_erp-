import Foundation
import Network

/* NOBODY SHOULD HAVE TO KEEP PRESSING A BUTTON.

   The parent this app is for is on mobile data that comes and goes on its own
   several times in a thirty second visit. A panel that sits there until
   somebody taps it produces the shape: signal returns, app still shows an
   error, parent concludes the app is broken rather than the network was.

   NWPathMonitor says when a usable path appears, which is the exact moment a
   retry is worth making. It is started for the life of the shell rather than
   per failure, because registering it only after a failure means missing the
   network that came back while the panel was being built. */
final class NetworkWatch {
    private let monitor = NWPathMonitor()
    private var satisfied = true

    var onReturn: () -> Void = {}
    var onLost: () -> Void = {}

    /* VALIDATED is deliberately not required, in Android's words: a captive
       portal or a connection the system has not finished probing reports a
       path without it, and calling that "no connection" sends a parent to
       check a wifi switch that is already on. .requiresConnection counts as
       having one for the same reason. */
    var hasNetwork: Bool { satisfied }

    func start() {
        monitor.pathUpdateHandler = { [weak self] path in
            let now = path.status != .unsatisfied
            DispatchQueue.main.async {
                guard let self else { return }
                let was = self.satisfied
                self.satisfied = now
                if now && !was { self.onReturn() }
                if !now && was { self.onLost() }
            }
        }
        monitor.start(queue: DispatchQueue(label: "com.schoolerp.parent.network"))
    }

    func stop() {
        monitor.cancel()
    }
}

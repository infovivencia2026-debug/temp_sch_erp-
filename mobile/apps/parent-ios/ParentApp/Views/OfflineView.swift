import SwiftUI

/* The full-page answer, used only when there is genuinely nothing to show:
   the cache has been tried and came back empty too. The hint is only
   promised where it can be kept — a parent whose data is off will see this
   reload itself the moment it is on; a parent whose school server is down
   has a network already and nothing will fire. */
struct OfflineView: View {
    let failure: WebShell.Failure
    let retry: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(failure.title)
                .font(.title2.weight(.semibold))
                .foregroundColor(Color("PageText"))
            Text(failure.body)
                .font(.body)
                .foregroundColor(Color("PageMuted"))
                .padding(.bottom, 12)
            Button(action: retry) {
                Text(L10n.retry)
                    .font(.body.weight(.medium))
                    .frame(maxWidth: .infinity, minHeight: 48)
            }
            .buttonStyle(.borderedProminent)
            if failure == .noNetwork {
                Text(L10n.waitingForNetwork)
                    .font(.footnote)
                    .foregroundColor(Color("PageMuted"))
                    .padding(.top, 12)
            }
        }
        .padding(24)
        .frame(maxWidth: 480, maxHeight: .infinity)
        .frame(maxWidth: .infinity)
        .background(Color("PageBackground").ignoresSafeArea())
    }
}

import SwiftUI

/* Over the page while the phone is being asked. The button is for the case
   where the prompt was cancelled or the sensor gave up; it asks again. */
struct LockView: View {
    let unlock: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(L10n.lockTitle)
                .font(.title2.weight(.semibold))
                .foregroundColor(Color("PageText"))
            Text(L10n.lockBody)
                .font(.body)
                .foregroundColor(Color("PageMuted"))
                .padding(.bottom, 12)
            Button(action: unlock) {
                Text(L10n.unlock)
                    .font(.body.weight(.medium))
                    .frame(maxWidth: .infinity, minHeight: 48)
            }
            .buttonStyle(.borderedProminent)
        }
        .padding(24)
        .frame(maxWidth: 480, maxHeight: .infinity)
        .frame(maxWidth: .infinity)
        .background(Color("PageBackground").ignoresSafeArea())
    }
}

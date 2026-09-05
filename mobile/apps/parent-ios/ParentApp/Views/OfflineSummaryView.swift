import SwiftUI

/* THE OFFLINE SCREEN THAT STILL ANSWERS THE QUESTIONS.

   Drawn natively from the shell's saved copy of the parent's summary (see
   SummaryStore) when the portal cannot be reached. The same failure title and
   sentence as the plain panel, the same Try again, and under them what the
   parent came for: each child's attendance, fees due, homework, the next
   exam or the last result, and today's periods — with the time these were
   true, said plainly, because a figure without its age is a figure that can
   be believed after it has changed. */
struct OfflineSummaryView: View {
    let failure: WebShell.Failure
    let saved: SummaryStore.Saved
    let retry: () -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                VStack(alignment: .leading, spacing: 8) {
                    Text(failure.title)
                        .font(.title2.weight(.semibold))
                        .foregroundColor(Color("PageText"))
                    Text(failure.body)
                        .font(.body)
                        .foregroundColor(Color("PageMuted"))
                    Button(action: retry) {
                        Text(L10n.retry)
                            .font(.body.weight(.medium))
                            .frame(maxWidth: .infinity, minHeight: 48)
                    }
                    .buttonStyle(.borderedProminent)
                    .padding(.top, 4)
                    if failure == .noNetwork {
                        Text(L10n.waitingForNetwork)
                            .font(.footnote)
                            .foregroundColor(Color("PageMuted"))
                    }
                }

                HStack {
                    Text(L10n.savedAt(saved.fetchedAt))
                        .font(.footnote.weight(.medium))
                        .foregroundColor(Color("PageMuted"))
                    Spacer()
                }
                .padding(.top, 8)

                ForEach(saved.children) { child in
                    ChildCard(child: child)
                }
            }
            .padding(24)
            .frame(maxWidth: 560)
            .frame(maxWidth: .infinity)
        }
        .background(Color("PageBackground").ignoresSafeArea())
        .accessibilityLabel(L10n.offlineSummaryLabel)
    }
}

private struct ChildCard: View {
    let child: SummaryStore.Child

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(child.fullName)
                .font(.headline)
                .foregroundColor(Color("PageText"))

            LazyVGrid(columns: [GridItem(.flexible(), alignment: .leading),
                                GridItem(.flexible(), alignment: .leading)], spacing: 12) {
                Fact(label: L10n.attendance, value: "\(child.attendancePct)%",
                     note: L10n.absentDays(child.absentDays))
                Fact(label: L10n.feesDue, value: L10n.rupees(child.outstandingPaise),
                     note: child.outstandingPaise == 0 ? L10n.nothingDue : nil)
                Fact(label: L10n.homework, value: "\(child.homeworkDue)",
                     note: child.nextHomeworkTitle)
                if let exam = child.latestResultExam {
                    Fact(label: L10n.latestResult, value: resultValue, note: exam)
                } else if let next = child.nextExam {
                    Fact(label: L10n.nextExam, value: next, note: nil)
                }
            }

            if let today = child.today, !today.isEmpty {
                VStack(alignment: .leading, spacing: 6) {
                    Text(L10n.today)
                        .font(.footnote.weight(.semibold))
                        .foregroundColor(Color("PageMuted"))
                    ForEach(today) { p in
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(timeText(p))
                                .font(.footnote.monospacedDigit())
                                .foregroundColor(Color("PageMuted"))
                                .frame(minWidth: 52, alignment: .leading)
                            Text(p.subject)
                                .font(.subheadline)
                                .foregroundColor(Color("PageText"))
                            if let room = p.room, !room.isEmpty {
                                Text(room)
                                    .font(.footnote)
                                    .foregroundColor(Color("PageMuted"))
                            }
                        }
                    }
                }
                .padding(.top, 4)
            }
        }
        .padding(16)
        .background(Color("CardBackground"), in: RoundedRectangle(cornerRadius: 14, style: .continuous))
    }

    private var resultValue: String {
        if let grade = child.latestResultGrade, !grade.isEmpty { return grade }
        if let pct = child.latestResultPct { return "\(Int(pct.rounded()))%" }
        return "—"
    }

    /* "09:15" from "09:15:00" or an ISO time; the period name when no time. */
    private func timeText(_ p: SummaryStore.Period) -> String {
        guard let s = p.startsAt else { return p.period }
        let t = s.contains("T") ? String(s.split(separator: "T").last ?? "") : s
        return String(t.prefix(5))
    }
}

private struct Fact: View {
    let label: String
    let value: String
    let note: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption)
                .foregroundColor(Color("PageMuted"))
            Text(value)
                .font(.title3.weight(.semibold))
                .foregroundColor(Color("PageText"))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
            if let note, !note.isEmpty {
                Text(note)
                    .font(.caption)
                    .foregroundColor(Color("PageMuted"))
                    .lineLimit(2)
            }
        }
    }
}

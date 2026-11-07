import SwiftUI

/// Recent notes, newest first. Pull from the server on appear; tap a row for the full note.
struct NotesView: View {
    @State private var notes: [NoteResult] = []
    @State private var loading = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Group {
                if loading && notes.isEmpty {
                    ProgressView()
                } else if let error, notes.isEmpty {
                    VStack(spacing: 6) {
                        Text(error).font(.footnote).multilineTextAlignment(.center)
                        Button("Retry") { Task { await load() } }
                    }
                } else if notes.isEmpty {
                    Text("עוד אין הערות").foregroundStyle(.secondary)
                } else {
                    List(notes) { note in
                        NavigationLink {
                            ResultView(note: note, onNew: nil)
                        } label: {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(note.title).font(.footnote.weight(.semibold)).lineLimit(2)
                                Text(note.wrist ?? note.summary).font(.caption2).foregroundStyle(.secondary).lineLimit(2)
                                Text(Self.relative(note.recorded_at)).font(.caption2).foregroundStyle(.tertiary)
                            }
                        }
                    }
                }
            }
            .navigationTitle("הערות")
        }
        .task { await load() }
    }

    private func load() async {
        loading = true
        defer { loading = false }
        do {
            notes = try await Uploader.recentNotes()
            error = nil
        } catch {
            self.error = error.localizedDescription
        }
    }

    private static let iso = ISO8601DateFormatter()
    private static let isoFractional: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        return f
    }()

    static func relative(_ stamp: String?) -> String {
        guard let stamp, let date = iso.date(from: stamp) ?? isoFractional.date(from: stamp) else { return "" }
        let f = RelativeDateTimeFormatter()
        f.unitsStyle = .short
        return f.localizedString(for: date, relativeTo: Date())
    }
}

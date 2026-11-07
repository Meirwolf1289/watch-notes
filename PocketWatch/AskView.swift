import SwiftUI
import WatchKit

/// "Ask your memory": dictate a question, get a short answer from your notes.
struct AskView: View {
    @State private var question = ""
    @State private var answer: String?
    @State private var busy = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    // On watchOS the TextField opens the dictation / scribble sheet.
                    TextField("מה פתוח עם...?", text: $question)
                        .onSubmit { Task { await ask() } }

                    Button(action: { Task { await ask() } }) {
                        Label("שאל", systemImage: "sparkles")
                    }
                    .disabled(busy || question.trimmingCharacters(in: .whitespaces).isEmpty)

                    if busy {
                        ProgressView().frame(maxWidth: .infinity)
                    } else if let answer {
                        Text(answer).font(.footnote)
                    } else if let error {
                        Text(error).font(.footnote).foregroundStyle(.red)
                    } else {
                        Text("שאל על כל מה שאמרת ב-90 הימים האחרונים.")
                            .font(.caption2).foregroundStyle(.secondary)
                    }
                }
            }
            .navigationTitle("שאל")
        }
    }

    private func ask() async {
        let q = question.trimmingCharacters(in: .whitespaces)
        guard !q.isEmpty, !busy else { return }
        busy = true
        answer = nil
        error = nil
        defer { busy = false }
        do {
            answer = try await Uploader.ask(q).answer
            WKInterfaceDevice.current().play(.success)
        } catch {
            self.error = error.localizedDescription
            WKInterfaceDevice.current().play(.failure)
        }
    }
}

import SwiftUI
import WatchKit

struct ContentView: View {
    enum Phase {
        case idle
        case recording
        case processing
        case done(NoteResult)
        case queued          // saved on the watch, will upload when the connection is back
        case failed(String)
    }

    @StateObject private var recorder = Recorder()
    @StateObject private var pending = PendingUploads.shared
    @State private var phase: Phase = .idle
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        TabView {
            recordTab
            NotesView()
            AskView()
        }
        .tabViewStyle(.page)   // horizontal pages: a List scrolls vertically without fighting the pager
        .task { pending.startRetrying(immediately: true) }
        .onChange(of: scenePhase) { _, new in
            if new == .active { pending.startRetrying(immediately: true) }
        }
    }

    private var recordTab: some View {
        NavigationStack {
            switch phase {
            case .idle, .recording:
                recordScreen
            case .processing:
                VStack(spacing: 8) {
                    ProgressView()
                    Text("חושב…").font(.footnote).foregroundStyle(.secondary)
                }
            case .done(let note):
                ResultView(note: note) { phase = .idle }
            case .queued:
                VStack(spacing: 8) {
                    Image(systemName: "icloud.and.arrow.up").font(.title2)
                    Text("אין רשת. ההקלטה נשמרה ותעלה לבד.").font(.footnote).multilineTextAlignment(.center)
                    Button("הערה חדשה") { phase = .idle }
                }
            case .failed(let message):
                VStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle").font(.title2)
                    Text(message).font(.footnote).multilineTextAlignment(.center)
                    Button("נסה שוב") { phase = .idle }
                }
            }
        }
    }

    private var recordScreen: some View {
        VStack(spacing: 10) {
            Button(action: toggle) {
                Circle()
                    .fill(recorder.isRecording ? Color.red : Color.white)
                    .frame(width: 90, height: 90)
                    .overlay(
                        Image(systemName: recorder.isRecording ? "stop.fill" : "mic.fill")
                            .font(.title)
                            .foregroundStyle(recorder.isRecording ? .white : .black)
                    )
            }
            .buttonStyle(.plain)

            Text(recorder.isRecording ? timeString(recorder.elapsed) : "לחץ ודבר")
                .font(.footnote.monospacedDigit())
                .foregroundStyle(.secondary)

            if pending.waiting > 0 && !recorder.isRecording {
                Label("\(pending.waiting) ממתינות להעלאה", systemImage: "icloud.and.arrow.up")
                    .font(.caption2)
                    .foregroundStyle(.orange)
            }
        }
    }

    private func toggle() {
        if recorder.isRecording {
            let started = recorder.startedAt ?? Date()
            guard let fileURL = recorder.stop() else { return }
            phase = .processing
            Task {
                // Persist first, upload second: nothing is lost if the upload (or the app) dies.
                let item: PendingNote
                do {
                    item = try pending.enqueue(fileURL, recordedAt: started)
                } catch {
                    phase = .failed(error.localizedDescription)
                    return
                }
                do {
                    let note = try await pending.upload(item)
                    phase = .done(note)
                    WKInterfaceDevice.current().play(.success)
                } catch {
                    if Uploader.isRetryable(error) {
                        phase = .queued
                        WKInterfaceDevice.current().play(.retry)
                        pending.startRetrying(immediately: false)
                    } else {
                        phase = .failed(error.localizedDescription)
                        WKInterfaceDevice.current().play(.failure)
                    }
                }
            }
        } else {
            Task {
                guard await recorder.requestPermission() else {
                    phase = .failed("Microphone access denied")
                    return
                }
                do {
                    try recorder.start()
                    phase = .recording
                    WKInterfaceDevice.current().play(.start)
                } catch {
                    phase = .failed(error.localizedDescription)
                }
            }
        }
    }

    private func timeString(_ t: TimeInterval) -> String {
        let s = Int(t)
        return String(format: "%02d:%02d", s / 60, s % 60)
    }
}

struct ResultView: View {
    let note: NoteResult
    let onNew: (() -> Void)?

    /// Full transcript for sharing. Present right after a recording; fetched lazily for notes opened from the list.
    @State private var transcript: String?

    init(note: NoteResult, onNew: (() -> Void)?) {
        self.note = note
        self.onNew = onNew
        _transcript = State(initialValue: note.transcript)
    }

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 8) {
                Text(note.title).font(.headline)
                Text(note.summary).font(.footnote)

                if !note.action_items.isEmpty {
                    Divider()
                    Text("לעשות").font(.caption).foregroundStyle(.secondary)
                    ForEach(note.action_items) { item in
                        VStack(alignment: .leading, spacing: 2) {
                            Label(item.task, systemImage: "checkmark.circle")
                                .font(.footnote)
                            if let when = item.due_text ?? item.due {
                                Text(when).font(.caption2).foregroundStyle(.secondary)
                            }
                        }
                    }
                }

                if let cost = note.cost_agorot {
                    Text(String(format: "%.2f אג׳", cost)).font(.caption2).foregroundStyle(.tertiary)
                }
                Divider()
                ShareLink(item: note.shareText(transcript: nil),
                          subject: Text(note.title)) {
                    Label("שתף סיכום", systemImage: "square.and.arrow.up")
                }
                if let transcript, !transcript.isEmpty {
                    ShareLink(item: note.shareText(transcript: transcript),
                              subject: Text(note.title)) {
                        Label("שתף עם התמלול", systemImage: "text.bubble")
                    }
                }
                if let onNew {
                    Button("הערה חדשה", action: onNew).padding(.top, 6)
                }
            }
        }
        .task {
            if transcript == nil, let id = note.id {
                transcript = try? await Uploader.note(id: id).transcript
            }
        }
    }
}

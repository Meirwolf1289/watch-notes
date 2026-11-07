import Foundation
import WatchKit

/// A finished recording that has not reached the server yet.
struct PendingNote: Codable, Identifiable, Equatable {
    let id: UUID
    let fileName: String
    let recordedAt: Date
    var attempts: Int
}

/// Recordings are moved here the moment you stop, BEFORE any upload. They survive the app being
/// killed and are retried until the server gives a definitive answer, so a meeting recorded with
/// no network is never lost.
@MainActor
final class PendingUploads: ObservableObject {
    static let shared = PendingUploads()

    @Published private(set) var items: [PendingNote] = []

    /// Give up on an item after this many failed attempts (it stays on disk, only the retries stop).
    static let maxAttempts = 8

    private let dir: URL
    private let indexURL: URL
    private var draining = false
    private var retryTask: Task<Void, Never>?

    init() {
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
        dir = base.appendingPathComponent("pending", isDirectory: true)
        indexURL = dir.appendingPathComponent("index.json")
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        if let data = try? Data(contentsOf: indexURL),
           let decoded = try? JSONDecoder().decode([PendingNote].self, from: data) {
            items = decoded.filter { FileManager.default.fileExists(atPath: fileURL($0).path) }
        }
    }

    var waiting: Int { items.filter { $0.attempts < Self.maxAttempts }.count }

    func fileURL(_ item: PendingNote) -> URL { dir.appendingPathComponent(item.fileName) }

    func enqueue(_ recording: URL, recordedAt: Date) throws -> PendingNote {
        let id = UUID()
        let item = PendingNote(id: id, fileName: "\(id.uuidString).m4a", recordedAt: recordedAt, attempts: 0)
        try FileManager.default.moveItem(at: recording, to: fileURL(item))
        items.append(item)
        save()
        return item
    }

    func remove(_ item: PendingNote) {
        try? FileManager.default.removeItem(at: fileURL(item))
        items.removeAll { $0.id == item.id }
        save()
    }

    func markFailedAttempt(_ item: PendingNote) {
        guard let index = items.firstIndex(where: { $0.id == item.id }) else { return }
        items[index].attempts += 1
        save()
    }

    /// Upload one item. The local copy is deleted only on success or a final server verdict
    /// (`empty`, `too_long`). Every other failure (no network, 5xx, bad key, anything unexpected)
    /// keeps the recording and counts an attempt: a recording is never thrown away on a guess.
    func upload(_ item: PendingNote) async throws -> NoteResult {
        do {
            let note = try await Uploader.send(fileURL: fileURL(item), recordedAt: item.recordedAt)
            remove(item)
            return note
        } catch {
            if Uploader.isFinalVerdict(error) {
                remove(item)
            } else {
                markFailedAttempt(item)
            }
            throw error
        }
    }

    /// Retry everything that is waiting, oldest first. Stops at the first transient failure
    /// (no point hammering a dead connection). Returns how many notes were saved.
    @discardableResult
    func drain() async -> Int {
        guard !draining else { return 0 }
        draining = true
        defer { draining = false }
        var saved = 0
        for item in items where item.attempts < Self.maxAttempts {
            do {
                _ = try await upload(item)
                saved += 1
            } catch {
                if Uploader.isRetryable(error) { break }
            }
        }
        return saved
    }

    /// One background loop for the whole app: retry what is waiting every 60 s until the queue is empty.
    /// `immediately` also tries right now (app launch / coming to the foreground).
    func startRetrying(immediately: Bool) {
        if retryTask != nil {
            if immediately { Task { await drain() } }
            return
        }
        retryTask = Task { [weak self] in
            var first = immediately
            while let self, !Task.isCancelled {
                if !first { try? await Task.sleep(for: .seconds(60)) }
                first = false
                if await self.drain() > 0 { WKInterfaceDevice.current().play(.success) }
                if self.waiting == 0 { break }
            }
            self?.retryTask = nil
        }
    }

    private func save() {
        if let data = try? JSONEncoder().encode(items) { try? data.write(to: indexURL, options: .atomic) }
    }
}

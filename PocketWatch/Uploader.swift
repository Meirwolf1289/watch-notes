import Foundation

struct ActionItem: Codable, Hashable, Identifiable {
    var id: String { task + (due ?? "") }
    let task: String
    let owner: String?
    let due: String?        // ISO-8601 with offset
    let due_text: String?   // "מחר 19:00"
}

struct NoteResult: Codable, Identifiable {
    let id: String?
    let title: String
    let summary: String
    let wrist: String?
    let action_items: [ActionItem]
    let people: [String]
    let cost_agorot: Double?
    let recorded_at: String?
    let transcript: String?

    /// Plain text for the system share sheet (Messages, Mail, AirDrop...). The transcript is optional
    /// because the full conversation is long and often private.
    func shareText(transcript: String?) -> String {
        var parts = [title, summary]
        let tasks = action_items.map { "• \($0.task)" + ($0.due_text.map { " (\($0))" } ?? "") }
        if !tasks.isEmpty { parts.append("משימות:\n" + tasks.joined(separator: "\n")) }
        if let transcript, !transcript.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            parts.append("תמלול:\n" + transcript.trimmingCharacters(in: .whitespacesAndNewlines))
        }
        return parts.filter { !$0.isEmpty }.joined(separator: "\n\n")
    }
}

struct AskResult: Codable {
    let answer: String
    let confidence: String?
}

/// The backend returns 200 with an `error` key for expected failures (see ingest/index.ts).
private struct ServerError: Codable {
    let error: String
    let code: String?
    let message_he: String?
}

enum PocketError: LocalizedError {
    case http(Int, String)
    case server(code: String?, message: String)
    case noKey

    var errorDescription: String? {
        switch self {
        case .http(let code, let body): return "Server \(code): \(body.prefix(120))"
        case .server(_, let message): return message
        case .noKey: return "Missing key: set POCKET_SHARED_KEY in Secrets.xcconfig"
        }
    }
}

enum Uploader {
    /// Server verdicts that mean "try again later" (the audio never became a note). Everything else is final.
    private static let retryableServerCodes: Set<String> = [
        "upstream", "rate_limited", "no_transcriber", "bad_transcriber_key", "db", "internal",
    ]

    /// True when retrying later can change the outcome: no connection, timeouts, 5xx/408/429,
    /// or a server-side failure that happened before a transcript existed.
    static func isRetryable(_ error: Error) -> Bool {
        if error is URLError { return true }
        switch error as? PocketError {
        case .http(let status, _): return status >= 500 || status == 408 || status == 429
        case .server(let code, _): return code.map { retryableServerCodes.contains($0) } ?? false
        default: return false
        }
    }

    /// The server has dealt with this recording for good: nothing to say (`empty`) or the transcript
    /// was parked server-side (`too_long`). Only then may the local copy be deleted.
    static func isFinalVerdict(_ error: Error) -> Bool {
        if case .server(let code, _)? = error as? PocketError { return code == "empty" || code == "too_long" }
        return false
    }

    private static let iso: ISO8601DateFormatter = {
        let f = ISO8601DateFormatter()
        f.formatOptions = [.withInternetDateTime]
        f.timeZone = .current   // local offset so the server resolves "מחר" against Israel time
        return f
    }()

    private static func request(_ url: URL) throws -> URLRequest {
        guard Config.pocketKey != "CHANGE-ME" else { throw PocketError.noKey }
        // Test hook: launch with `-PocketForceOffline YES` to simulate no network.
        if UserDefaults.standard.bool(forKey: "PocketForceOffline") { throw URLError(.notConnectedToInternet) }
        var request = URLRequest(url: url)
        request.httpMethod = "POST"
        request.timeoutInterval = 150
        request.setValue(Config.pocketKey, forHTTPHeaderField: "x-pocket-key")
        return request
    }

    private static func decode<T: Decodable>(_ type: T.Type, data: Data, response: URLResponse) throws -> T {
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard status == 200 else {
            throw PocketError.http(status, String(data: data, encoding: .utf8) ?? "")
        }
        if let failure = try? JSONDecoder().decode(ServerError.self, from: data) {
            throw PocketError.server(code: failure.code, message: failure.message_he ?? failure.error)
        }
        return try JSONDecoder().decode(type, from: data)
    }

    /// Audio note: raw m4a body -> transcribe -> structure.
    static func send(fileURL: URL, recordedAt: Date) async throws -> NoteResult {
        var request = try request(Config.ingestURL)
        request.setValue("audio/m4a", forHTTPHeaderField: "Content-Type")
        request.setValue(iso.string(from: recordedAt), forHTTPHeaderField: "x-recorded-at")
        let (data, response) = try await URLSession.shared.upload(for: request, fromFile: fileURL)
        let note = try decode(NoteResult.self, data: data, response: response)
        try? FileManager.default.removeItem(at: fileURL)
        return note
    }

    /// "Ask your memory".
    static func ask(_ question: String) async throws -> AskResult {
        var request = try request(Config.askURL)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["question": question, "recorded_at": iso.string(from: Date())])
        let (data, response) = try await URLSession.shared.data(for: request)
        return try decode(AskResult.self, data: data, response: response)
    }

    /// One full note including its transcript (the list omits it to stay small).
    static func note(id: String) async throws -> NoteResult {
        var request = try request(Config.notesURL)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(["id": id])
        let (data, response) = try await URLSession.shared.data(for: request)
        struct One: Codable { let note: NoteResult }
        return try decode(One.self, data: data, response: response).note
    }

    /// Recent notes for the list screen.
    static func recentNotes() async throws -> [NoteResult] {
        var request = try request(Config.notesURL)
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data("{}".utf8)
        let (data, response) = try await URLSession.shared.data(for: request)
        struct Page: Codable { let notes: [NoteResult] }
        return try decode(Page.self, data: data, response: response).notes
    }
}

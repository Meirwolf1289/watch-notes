import AVFoundation

enum RecorderError: LocalizedError {
    case couldNotStart(String)
    var errorDescription: String? {
        switch self { case .couldNotStart(let why): return "Could not start recording: \(why)" }
    }
}

@MainActor
final class Recorder: ObservableObject {
    @Published var isRecording = false
    @Published var elapsed: TimeInterval = 0

    private var recorder: AVAudioRecorder?
    private var timer: Timer?
    private(set) var startedAt: Date?

    func requestPermission() async -> Bool {
        await withCheckedContinuation { continuation in
            AVAudioApplication.requestRecordPermission { granted in
                continuation.resume(returning: granted)
            }
        }
    }

    func start() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(.record, mode: .default)
        try session.setActive(true)

        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("note-\(UUID().uuidString).m4a")

        // 16 kHz mono AAC (~0.5 MB/min). Try the higher quality first (a low AAC quality smears consonants,
        // which hurts Hebrew recognition) and fall back to `.medium`, the setting proven on a real Series 7:
        // the simulator and the watch use different AAC encoders, so what one accepts the other may refuse.
        // Do NOT set AVEncoderBitRateKey: 64 kbps is invalid for 16 kHz mono.
        var started: AVAudioRecorder?
        var lastError = "record() returned false"
        for quality in [AVAudioQuality.high, AVAudioQuality.medium] {
            let settings: [String: Any] = [
                AVFormatIDKey: kAudioFormatMPEG4AAC,
                AVSampleRateKey: 16_000,
                AVNumberOfChannelsKey: 1,
                AVEncoderAudioQualityKey: quality.rawValue,
            ]
            do {
                let candidate = try AVAudioRecorder(url: url, settings: settings)
                if candidate.record() { started = candidate; break }
            } catch {
                lastError = "\(error.localizedDescription) (\((error as NSError).code))"
            }
        }
        guard let newRecorder = started else { throw RecorderError.couldNotStart(lastError) }

        recorder = newRecorder
        startedAt = Date()
        elapsed = 0
        isRecording = true

        timer = Timer.scheduledTimer(withTimeInterval: 1, repeats: true) { [weak self] _ in
            Task { @MainActor in
                guard let self, let start = self.startedAt else { return }
                self.elapsed = Date().timeIntervalSince(start)
            }
        }
    }

    /// Stops recording and returns the file URL.
    func stop() -> URL? {
        guard let active = recorder else { return nil }
        active.stop()
        timer?.invalidate()
        timer = nil
        isRecording = false
        recorder = nil
        try? AVAudioSession.sharedInstance().setActive(false)
        return active.url
    }
}

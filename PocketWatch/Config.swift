import Foundation

enum Config {
    /// POCKET_PROJECT_REF (the part before .supabase.co), injected from Secrets.xcconfig via Info.plist.
    static let projectRef: String = {
        let ref = Bundle.main.object(forInfoDictionaryKey: "PocketProjectRef") as? String ?? ""
        return ref.isEmpty || ref == "YOUR-PROJECT-REF" ? "missing-project-ref" : ref
    }()
    static var baseURL: URL { URL(string: "https://\(projectRef).supabase.co/functions/v1")! }
    static var ingestURL: URL { baseURL.appendingPathComponent("ingest") }
    static var askURL: URL { baseURL.appendingPathComponent("ask") }
    static var notesURL: URL { baseURL.appendingPathComponent("notes") }

    /// POCKET_SHARED_KEY, injected from Secrets.xcconfig via Info.plist (never hard-code it here).
    static let pocketKey: String = {
        let key = Bundle.main.object(forInfoDictionaryKey: "PocketKey") as? String ?? ""
        return key.isEmpty || key == "paste-your-key" ? "CHANGE-ME" : key
    }()
}

import Foundation
import Observation
import RoomPlan

enum ScanError: LocalizedError {
    case empty, badURL(String), missingFile(String)

    var errorDescription: String? {
        switch self {
        case .empty: "Nothing was captured."
        case .badURL(let url): "Not a valid upload URL: \(url)"
        case .missingFile(let name): "Missing file: \(name)"
        }
    }
}

/// Settings plus every saved scan. Files live in Documents/scans/<id>/:
/// roomplan.json (raw RoomPlan Codable output), model.usdz, payload.json (built on demand).
@MainActor
@Observable
final class ScanStore {
    var settings: ScanSettings
    private(set) var scans: [SavedScan] = []

    @ObservationIgnored private let root: URL
    @ObservationIgnored private let settingsKey = "radar.field.settings"

    init() {
        let documents = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
        root = documents.appendingPathComponent("scans", isDirectory: true)
        try? FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        if let data = UserDefaults.standard.data(forKey: settingsKey),
           let saved = try? JSONDecoder().decode(ScanSettings.self, from: data) {
            settings = saved
        } else {
            settings = ScanSettings()
        }
        scans = loadIndex()
    }

    func persistSettings() {
        if let data = try? JSONEncoder().encode(settings) {
            UserDefaults.standard.set(data, forKey: settingsKey)
        }
    }

    func scan(id: UUID) -> SavedScan? { scans.first { $0.id == id } }

    func update(_ id: UUID, _ change: (inout SavedScan) -> Void) {
        guard let index = scans.firstIndex(where: { $0.id == id }) else { return }
        change(&scans[index])
        persistIndex()
    }

    func delete(at offsets: IndexSet) {
        for index in offsets {
            try? FileManager.default.removeItem(at: directory(for: scans[index].id))
        }
        scans.remove(atOffsets: offsets)
        persistIndex()
    }

    // MARK: - Saving

    func save(rooms: [CapturedRoom], structure: CapturedStructure?) throws -> SavedScan {
        guard !rooms.isEmpty else { throw ScanError.empty }
        let id = UUID()
        let dir = directory(for: id)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let json = dir.appendingPathComponent("roomplan.json")
        let usdz = dir.appendingPathComponent("model.usdz")
        let encoder = JSONEncoder()

        let type: String
        if let structure {
            try encoder.encode(structure).write(to: json)
            try? structure.export(to: usdz, exportOptions: .parametric)
            type = "CapturedStructure"
        } else if rooms.count == 1 {
            try encoder.encode(rooms[0]).write(to: json)
            try? rooms[0].export(to: usdz, exportOptions: .parametric)
            type = "CapturedRoom"
        } else {
            try encoder.encode(rooms).write(to: json)
            try? rooms[0].export(to: usdz, exportOptions: .parametric)
            type = "CapturedRoomArray"
        }

        let scan = SavedScan(
            id: id,
            propertyId: settings.propertyId.trimmingCharacters(in: .whitespaces),
            operatorName: settings.operatorName,
            notes: settings.notes,
            capturedAt: Date(),
            standIn: settings.standIn,
            searchedBelow: settings.searchedBelow,
            firstRoomAtEntrance: settings.firstRoomAtEntrance,
            roomplanType: type,
            summary: ScanMetrics.summarize(rooms: rooms, structure: structure)
        )
        scans.insert(scan, at: 0)
        persistIndex()
        return scan
    }

    // MARK: - Payload, sharing, upload

    func payloadData(for scan: SavedScan) throws -> Data {
        let json = directory(for: scan.id).appendingPathComponent("roomplan.json")
        guard FileManager.default.fileExists(atPath: json.path) else { throw ScanError.missingFile("roomplan.json") }
        let roomplan = try JSONSerialization.jsonObject(with: Data(contentsOf: json))
        let summary = try JSONSerialization.jsonObject(with: JSONEncoder().encode(scan.summary))
        let payload: [String: Any] = [
            "schema": "radar-field-scan/1",
            "scan_id": scan.id.uuidString,
            "property_id": scan.propertyId,
            "operator": scan.operatorName,
            "notes": scan.notes,
            "stand_in": scan.standIn,
            "searched_below": scan.searchedBelow,
            "first_room_at_entrance": scan.firstRoomAtEntrance,
            "captured_at": ISO8601DateFormatter().string(from: scan.capturedAt),
            "device": DeviceInfo.current,
            "summary": summary,
            "roomplan_type": scan.roomplanType,
            "roomplan": roomplan,
        ]
        return try JSONSerialization.data(withJSONObject: payload, options: [.sortedKeys])
    }

    /// Files to hand to the share sheet (AirDrop, Files, Mail): the payload and the 3D model.
    func shareableFiles(for scan: SavedScan) throws -> [URL] {
        let dir = directory(for: scan.id)
        let payload = dir.appendingPathComponent("\(scan.propertyId)-\(scan.id.uuidString.prefix(8)).json")
        try payloadData(for: scan).write(to: payload)
        let usdz = dir.appendingPathComponent("model.usdz")
        return FileManager.default.fileExists(atPath: usdz.path) ? [payload, usdz] : [payload]
    }

    func upload(_ scan: SavedScan) async {
        do {
            guard let url = URL(string: settings.backendURL), url.scheme?.hasPrefix("http") == true else {
                throw ScanError.badURL(settings.backendURL)
            }
            var request = URLRequest(url: url)
            request.httpMethod = "POST"
            request.timeoutInterval = 30
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            if !settings.uploadToken.isEmpty {
                request.setValue(settings.uploadToken, forHTTPHeaderField: "X-Radar-Token")
            }
            let body = try payloadData(for: scan)
            let (data, response) = try await URLSession.shared.upload(for: request, from: body)
            let status = (response as? HTTPURLResponse)?.statusCode ?? 0
            let reply = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
            guard (200..<300).contains(status) else {
                let detail = reply?["error"] as? String ?? String(decoding: data.prefix(200), as: UTF8.self)
                update(scan.id) { $0.lastError = "HTTP \(status): \(detail)" }
                return
            }
            update(scan.id) {
                $0.uploadedAt = Date()
                $0.serverMessage = reply?["message"] as? String ?? "Uploaded."
                $0.lastError = nil
            }
        } catch {
            update(scan.id) { $0.lastError = error.localizedDescription }
        }
    }

    // MARK: - Files

    private func directory(for id: UUID) -> URL {
        root.appendingPathComponent(id.uuidString, isDirectory: true)
    }

    private var indexURL: URL { root.appendingPathComponent("index.json") }

    private func loadIndex() -> [SavedScan] {
        guard let data = try? Data(contentsOf: indexURL) else { return [] }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return (try? decoder.decode([SavedScan].self, from: data)) ?? []
    }

    private func persistIndex() {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        if let data = try? encoder.encode(scans) {
            try? data.write(to: indexURL)
        }
    }
}

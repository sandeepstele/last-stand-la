import Foundation
import UIKit

/// Set on the home screen before scanning; copied into each scan and editable until upload.
struct ScanSettings: Codable, Equatable {
    var propertyId: String = "TEST-A"
    var operatorName: String = ""
    var backendURL: String = "http://192.168.1.10:2024/field/scan"
    var uploadToken: String = ""
    /// A room that is NOT the building being verified (e.g. a room in Princeton standing in
    /// for a Houston office). The backend shows it as a preview and never changes a verdict.
    var standIn: Bool = true
    /// The person scanning actually looked for stairs or a lower level. Only then may the
    /// backend use "nothing below" as evidence.
    var searchedBelow: Bool = false
    /// The first room scanned is at the building's entrance level. Level offsets are measured from
    /// the first room, so only then can a lower level count as below grade.
    var firstRoomAtEntrance: Bool = true
    var notes: String = ""
}

/// What the phone measured. Mirrors the backend's FieldScan; snake_case on the wire.
struct ScanSummary: Codable, Hashable {
    var rooms: Int
    var ceilingHeightM: Double?
    var ceilingInRange: Bool
    var wallHeightsM: [Double]
    var netAreaM2: Double
    var roomAreasM2: [Double]
    var levelOffsetsM: [Double]
    var stories: [Int]
    var walls: Int
    var doors: Int
    var windows: Int
    var openings: Int
    var objects: Int
    var warnings: [String]

    enum CodingKeys: String, CodingKey {
        case rooms
        case ceilingHeightM = "ceiling_height_m"
        case ceilingInRange = "ceiling_in_range"
        case wallHeightsM = "wall_heights_m"
        case netAreaM2 = "net_area_m2"
        case roomAreasM2 = "room_areas_m2"
        case levelOffsetsM = "level_offsets_m"
        case stories, walls, doors, windows, openings, objects, warnings
    }
}

struct SavedScan: Codable, Identifiable, Hashable {
    let id: UUID
    var propertyId: String
    var operatorName: String
    var notes: String
    let capturedAt: Date
    var standIn: Bool
    var searchedBelow: Bool
    var firstRoomAtEntrance: Bool = true
    /// "CapturedRoom", "CapturedStructure" (merged rooms) or "CapturedRoomArray" (merge failed).
    let roomplanType: String
    var summary: ScanSummary
    var uploadedAt: Date?
    var serverMessage: String?
    var lastError: String?
}

enum DeviceInfo {
    @MainActor static var current: [String: String] {
        var info = utsname()
        uname(&info)
        let model = withUnsafeBytes(of: &info.machine) { raw in
            String(decoding: raw.prefix(while: { $0 != 0 }), as: UTF8.self)
        }
        let app = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "?"
        return [
            "model": model,
            "system": "\(UIDevice.current.systemName) \(UIDevice.current.systemVersion)",
            "app": "Radar Field \(app)",
        ]
    }
}

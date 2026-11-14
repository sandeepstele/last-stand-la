import Foundation
import RoomPlan
import simd

/// Turns RoomPlan output into the few numbers Retrofit Radar can defend.
/// The backend recomputes the same numbers from the raw JSON; these are for the phone screen.
enum ScanMetrics {
    /// Apple designed RoomPlan for rooms up to 15 x 15 m with ceilings up to 3.6 m.
    static let maxCeilingM = 3.6
    static let maxRoomAreaM2 = 15.0 * 15.0
    /// Floor elevations closer than this are the same level (steps, thresholds, ramps).
    static let levelGapM = 1.0

    static func summarize(rooms: [CapturedRoom], structure: CapturedStructure?) -> ScanSummary {
        let walls: [CapturedRoom.Surface] = structure?.walls ?? rooms.flatMap { $0.walls }
        let structureFloors = structure?.floors ?? []
        let floors: [CapturedRoom.Surface] = structureFloors.isEmpty ? rooms.flatMap { $0.floors } : structureFloors

        let wallHeights = walls.map { Double($0.dimensions.y) }.filter { $0 > 0.5 }.sorted()
        let ceiling = median(wallHeights)
        let roomAreas = rooms.map { room in room.floors.reduce(0.0) { $0 + area(of: $1) } }
        let floorArea = floors.reduce(0.0) { $0 + area(of: $1) }
        let netArea = floorArea > 0 ? floorArea : roomAreas.reduce(0, +)

        // Elevations share one world frame because every room is scanned in the same ARSession.
        let reference = rooms.first?.floors.first.map { Double($0.transform.columns.3.y) }
        let elevations = floors.map { Double($0.transform.columns.3.y) }
        let levelOffsets = clusterLevels(elevations, reference: reference ?? elevations.min() ?? 0)
        let stories = Array(Set(rooms.map { $0.story } + floors.map { $0.story })).sorted()

        var warnings: [String] = []
        if let c = ceiling, c > maxCeilingM {
            warnings.append(String(format: "Ceiling %.2f m is above RoomPlan's 3.6 m design limit, so the height is unverified.", c))
        }
        if ceiling == nil { warnings.append("No walls captured, so there is no ceiling height.") }
        if floors.isEmpty { warnings.append("No floor outline captured, so there is no area.") }
        for (index, a) in roomAreas.enumerated() where a > maxRoomAreaM2 {
            warnings.append(String(format: "Room %d (%.0f m²) is larger than RoomPlan's 15 x 15 m design limit.", index + 1, a))
        }
        if levelOffsets.count > 1 {
            warnings.append("Several levels in one session: offsets are about ±15 cm at best (inferred).")
        }
        if rooms.count > 1 && structure == nil {
            warnings.append("Rooms could not be merged, so they were saved separately.")
        }

        return ScanSummary(
            rooms: max(rooms.count, structure?.rooms.count ?? 0),
            ceilingHeightM: ceiling.map(round2),
            ceilingInRange: ceiling.map { $0 <= maxCeilingM } ?? false,
            wallHeightsM: wallHeights.map(round2),
            netAreaM2: round2(netArea),
            roomAreasM2: roomAreas.map(round2),
            levelOffsetsM: levelOffsets,
            stories: stories,
            walls: walls.count,
            doors: structure?.doors.count ?? rooms.reduce(0) { $0 + $1.doors.count },
            windows: structure?.windows.count ?? rooms.reduce(0) { $0 + $1.windows.count },
            openings: structure?.openings.count ?? rooms.reduce(0) { $0 + $1.openings.count },
            objects: structure?.objects.count ?? rooms.reduce(0) { $0 + $1.objects.count },
            warnings: warnings
        )
    }

    /// Area of a planar surface. polygonCorners are in the surface's local frame; take the
    /// projection with the largest area so it works whichever two local axes span the plane.
    static func area(of surface: CapturedRoom.Surface) -> Double {
        let corners = surface.polygonCorners
        if corners.count >= 3 {
            let xy = shoelace(corners.map { SIMD2(Double($0.x), Double($0.y)) })
            let xz = shoelace(corners.map { SIMD2(Double($0.x), Double($0.z)) })
            let yz = shoelace(corners.map { SIMD2(Double($0.y), Double($0.z)) })
            return max(xy, xz, yz)
        }
        let d = [surface.dimensions.x, surface.dimensions.y, surface.dimensions.z]
            .map { Double($0) }
            .sorted(by: >)
        return d[0] * d[1]
    }

    static func shoelace(_ points: [SIMD2<Double>]) -> Double {
        guard points.count >= 3 else { return 0 }
        var sum = 0.0
        for i in points.indices {
            let a = points[i]
            let b = points[(i + 1) % points.count]
            sum += a.x * b.y - b.x * a.y
        }
        return abs(sum) / 2
    }

    static func median(_ values: [Double]) -> Double? {
        guard !values.isEmpty else { return nil }
        let s = values.sorted()
        let m = s.count / 2
        return s.count % 2 == 1 ? s[m] : (s[m - 1] + s[m]) / 2
    }

    static func clusterLevels(_ elevations: [Double], reference: Double) -> [Double] {
        var clusters: [[Double]] = []
        for e in elevations.sorted() {
            if let last = clusters.last?.last, e - last < levelGapM {
                clusters[clusters.count - 1].append(e)
            } else {
                clusters.append([e])
            }
        }
        return clusters.compactMap { median($0) }.map { round2($0 - reference) }
    }

    static func round2(_ x: Double) -> Double { (x * 100).rounded() / 100 }
}

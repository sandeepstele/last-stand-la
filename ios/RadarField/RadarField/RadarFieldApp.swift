import SwiftUI

/// Radar Field: scan a room with RoomPlan (iPhone LiDAR) and send it to Retrofit Radar
/// as a "field check". The backend treats the scan as a bound or a sample, never as a
/// whole-building measurement.
@main
struct RadarFieldApp: App {
    @State private var store = ScanStore()

    var body: some Scene {
        WindowGroup {
            HomeView()
                .environment(store)
        }
    }
}

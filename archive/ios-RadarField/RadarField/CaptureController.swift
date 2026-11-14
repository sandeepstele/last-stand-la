import ARKit
import RoomPlan
import SwiftUI

/// Receives RoomPlan callbacks. Kept separate from the controller because
/// RoomCaptureViewDelegate requires NSCoding.
final class CaptureDelegate: NSObject, RoomCaptureViewDelegate {
    var onPresented: ((CapturedRoom, Error?) -> Void)?

    override init() { super.init() }
    required init?(coder: NSCoder) { nil }
    func encode(with coder: NSCoder) {}

    func captureView(shouldPresent roomDataForProcessing: CapturedRoomData, error: Error?) -> Bool {
        true  // let RoomPlan process the scan and show its 3D preview
    }

    func captureView(didPresent processedResult: CapturedRoom, error: Error?) {
        let callback = onPresented
        DispatchQueue.main.async { callback?(processedResult, error) }
    }
}

/// Drives one scanning session. Every room is scanned in the same ARSession, so rooms share
/// one world frame and StructureBuilder can merge them (and floor elevations are comparable).
@MainActor
@Observable
final class CaptureController {
    enum Phase: Equatable {
        case scanning, processing, reviewing, merging, finished
        case failed(String)
    }

    private(set) var phase: Phase = .scanning
    private(set) var rooms: [CapturedRoom] = []
    private(set) var structure: CapturedStructure?
    private(set) var mergeError: String?

    @ObservationIgnored let arSession = ARSession()
    @ObservationIgnored let view: RoomCaptureView
    @ObservationIgnored private let delegate = CaptureDelegate()

    init() {
        view = RoomCaptureView(frame: .zero, arSession: arSession)
        view.delegate = delegate
        delegate.onPresented = { [weak self] room, error in
            MainActor.assumeIsolated { self?.handlePresented(room, error: error) }
        }
    }

    func start() {
        var configuration = RoomCaptureSession.Configuration()
        configuration.isCoachingEnabled = true
        view.captureSession.run(configuration: configuration)
        phase = .scanning
    }

    /// Stop scanning this room but keep the ARSession alive for the next one.
    func doneWithRoom() {
        phase = .processing
        view.captureSession.stop(pauseARSession: false)
    }

    func scanNextRoom() { start() }

    func finish() async {
        arSession.pause()
        if rooms.count > 1 {
            phase = .merging
            do {
                let builder = StructureBuilder(options: [.beautifyObjects])
                structure = try await builder.capturedStructure(from: rooms)
            } catch {
                mergeError = error.localizedDescription
            }
        }
        phase = .finished
    }

    func cancel() {
        view.captureSession.stop()
        arSession.pause()
    }

    func fail(_ message: String) { phase = .failed(message) }

    private func handlePresented(_ room: CapturedRoom, error: Error?) {
        if let error {
            phase = rooms.isEmpty ? .failed(error.localizedDescription) : .reviewing
            return
        }
        rooms.append(room)
        phase = .reviewing
    }
}

struct RoomCaptureContainer: UIViewRepresentable {
    let controller: CaptureController

    func makeUIView(context: Context) -> RoomCaptureView { controller.view }
    func updateUIView(_ uiView: RoomCaptureView, context: Context) {}
}

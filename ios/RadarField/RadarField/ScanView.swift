import SwiftUI

/// Full-screen RoomPlan capture. "Done with room" processes the current room; from the review
/// state you can scan the next connected room in the same session or finish.
struct ScanView: View {
    @Environment(ScanStore.self) private var store
    @Environment(\.dismiss) private var dismiss
    @State private var controller = CaptureController()
    let onSaved: (SavedScan) -> Void

    var body: some View {
        ZStack(alignment: .bottom) {
            RoomCaptureContainer(controller: controller)
                .ignoresSafeArea()
            controls
                .padding()
                .background(.ultraThinMaterial, in: .rect(cornerRadius: 16))
                .padding()
        }
        .onAppear { controller.start() }
        .interactiveDismissDisabled()
        .statusBarHidden()
    }

    @ViewBuilder private var controls: some View {
        switch controller.phase {
        case .scanning:
            HStack {
                Button("Cancel", role: .cancel) {
                    controller.cancel()
                    dismiss()
                }
                Spacer()
                Text("Room \(controller.rooms.count + 1)").font(.headline)
                Spacer()
                Button("Done with room") { controller.doneWithRoom() }
                    .buttonStyle(.borderedProminent)
            }
        case .processing:
            ProgressView("Processing room…")
        case .reviewing:
            HStack {
                Button("Scan next room") { controller.scanNextRoom() }
                Spacer()
                Button("Finish (\(controller.rooms.count))") {
                    Task { await finish() }
                }
                .buttonStyle(.borderedProminent)
            }
        case .merging:
            ProgressView("Merging rooms…")
        case .finished:
            ProgressView("Saving…")
        case .failed(let message):
            VStack(spacing: 12) {
                Label(message, systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                Button("Close") {
                    controller.cancel()
                    dismiss()
                }
                .buttonStyle(.borderedProminent)
            }
        }
    }

    private func finish() async {
        await controller.finish()
        do {
            let saved = try store.save(rooms: controller.rooms, structure: controller.structure)
            dismiss()
            onSaved(saved)
        } catch {
            controller.fail(error.localizedDescription)
        }
    }
}

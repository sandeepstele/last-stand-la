import SwiftUI
import UIKit

struct ResultView: View {
    @Environment(ScanStore.self) private var store
    let scanID: UUID
    @State private var uploading = false
    @State private var shareItems: [URL] = []
    @State private var sharing = false
    @State private var shareError: String?

    var body: some View {
        if let scan = store.scan(id: scanID) {
            content(scan)
        } else {
            ContentUnavailableView("Scan not found", systemImage: "questionmark.folder")
        }
    }

    private func content(_ scan: SavedScan) -> some View {
        let s = scan.summary
        return List {
            Section("Measured") {
                metric("Ceiling height", s.ceilingHeightM.map { String(format: "%.2f m ± 0.05", $0) } ?? "n/a")
                metric("Net floor area", String(format: "%.1f m² (%.0f sq ft) ± 3%%", s.netAreaM2, s.netAreaM2 * 10.7639))
                metric("Rooms", "\(s.rooms)")
                metric("Levels vs. first room", s.levelOffsetsM.map { String(format: "%+.2f m", $0) }.joined(separator: ", "))
                metric("Walls / doors / windows", "\(s.walls) / \(s.doors) / \(s.windows)")
            }

            if !s.warnings.isEmpty {
                Section("Warnings") {
                    ForEach(s.warnings, id: \.self) { warning in
                        Label(warning, systemImage: "exclamationmark.triangle").foregroundStyle(.orange)
                    }
                }
            }

            Section {
                Text("This is interior (usable) area, so it should read below a listed rentable figure. Ceiling height caps how many floors can fit; it is never a floor-to-floor height.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } header: {
                Text("What this can prove")
            }

            Section("Use") {
                TextField("Property ID", text: binding(scan, \.propertyId))
                    .textInputAutocapitalization(.characters)
                    .autocorrectionDisabled()
                Toggle("Stand-in room", isOn: binding(scan, \.standIn))
                Toggle("Checked for stairs going down", isOn: binding(scan, \.searchedBelow))
                Toggle("First room is at the entrance level", isOn: binding(scan, \.firstRoomAtEntrance))
            }

            Section("Send") {
                Button {
                    uploading = true
                    Task {
                        await store.upload(scan)
                        uploading = false
                    }
                } label: {
                    if uploading { ProgressView() } else { Label("Upload to Radar", systemImage: "arrow.up.circle.fill") }
                }
                .disabled(uploading)

                Button {
                    do {
                        shareItems = try store.shareableFiles(for: scan)
                        sharing = true
                    } catch {
                        shareError = error.localizedDescription
                    }
                } label: {
                    Label("Share JSON and 3D model", systemImage: "square.and.arrow.up")
                }

                if let uploaded = scan.uploadedAt {
                    Label("Uploaded \(uploaded.formatted(date: .omitted, time: .shortened))", systemImage: "checkmark.circle")
                        .foregroundStyle(.green)
                }
                if let message = scan.serverMessage {
                    Text(message).font(.callout)
                }
                if let error = scan.lastError ?? shareError {
                    Text(error).font(.callout).foregroundStyle(.red)
                }
            }
        }
        .navigationTitle(scan.propertyId)
        .navigationBarTitleDisplayMode(.inline)
        .sheet(isPresented: $sharing) { ActivityView(items: shareItems) }
    }

    private func metric(_ label: String, _ value: String) -> some View {
        LabeledContent(label) { Text(value).monospacedDigit() }
    }

    private func binding<Value>(_ scan: SavedScan, _ keyPath: WritableKeyPath<SavedScan, Value>) -> Binding<Value> {
        Binding(
            get: { store.scan(id: scan.id)?[keyPath: keyPath] ?? scan[keyPath: keyPath] },
            set: { newValue in store.update(scan.id) { $0[keyPath: keyPath] = newValue } }
        )
    }
}

struct ActivityView: UIViewControllerRepresentable {
    let items: [URL]

    func makeUIViewController(context: Context) -> UIActivityViewController {
        UIActivityViewController(activityItems: items, applicationActivities: nil)
    }

    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}

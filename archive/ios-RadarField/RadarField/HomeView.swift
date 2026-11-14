import RoomPlan
import SwiftUI

struct HomeView: View {
    @Environment(ScanStore.self) private var store
    @State private var scanning = false
    @State private var path: [UUID] = []

    var body: some View {
        @Bindable var store = store
        NavigationStack(path: $path) {
            Form {
                Section("Building") {
                    TextField("Property ID, e.g. TEST-A", text: $store.settings.propertyId)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                    TextField("Your name", text: $store.settings.operatorName)
                }

                Section {
                    Toggle("Stand-in room", isOn: $store.settings.standIn)
                    Toggle("I checked for stairs going down", isOn: $store.settings.searchedBelow)
                    Toggle("First room is at the entrance level", isOn: $store.settings.firstRoomAtEntrance)
                } header: {
                    Text("How Radar should use this scan")
                } footer: {
                    Text("Keep \"Stand-in room\" on unless you are inside the building you entered above: a stand-in is shown as a preview and never changes a verdict. Turn on \"checked for stairs\" only if someone actually looked for a basement or lower level. Start scanning in a room at the entrance level, so lower levels can be measured from it.")
                }

                Section("Notes") {
                    TextField("Optional", text: $store.settings.notes, axis: .vertical)
                }

                Section {
                    if RoomCaptureSession.isSupported {
                        Button {
                            scanning = true
                        } label: {
                            Label("Start scan", systemImage: "viewfinder")
                                .font(.headline)
                        }
                        .disabled(store.settings.propertyId.trimmingCharacters(in: .whitespaces).isEmpty)
                    } else {
                        Label("This device has no LiDAR scanner. Use an iPhone 12 Pro or later Pro model, or an iPad Pro (2020 or later).",
                              systemImage: "exclamationmark.triangle")
                            .foregroundStyle(.orange)
                    }
                } footer: {
                    Text("Best results: one room under about 6 x 6 m, ceiling under 3.6 m, good light, no glass walls. Walk slowly along the walls.")
                }

                Section("Backend") {
                    TextField("Upload URL", text: $store.settings.backendURL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    SecureField("Upload token", text: $store.settings.uploadToken)
                }

                if !store.scans.isEmpty {
                    Section("Scans") {
                        ForEach(store.scans) { scan in
                            NavigationLink(value: scan.id) { ScanRow(scan: scan) }
                        }
                        .onDelete { store.delete(at: $0) }
                    }
                }
            }
            .navigationTitle("Radar Field")
            .navigationDestination(for: UUID.self) { id in ResultView(scanID: id) }
            .fullScreenCover(isPresented: $scanning) {
                ScanView { saved in path.append(saved.id) }
                    .environment(store)
            }
            .onChange(of: store.settings) { store.persistSettings() }
        }
    }
}

struct ScanRow: View {
    let scan: SavedScan

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text(scan.propertyId).font(.headline)
                if scan.standIn {
                    Text("stand-in").font(.caption).padding(.horizontal, 6).background(.yellow.opacity(0.3), in: .capsule)
                }
                Spacer()
                Image(systemName: scan.uploadedAt == nil ? "icloud.slash" : "checkmark.icloud")
                    .foregroundStyle(scan.uploadedAt == nil ? Color.secondary : Color.green)
            }
            Text(detail).font(.subheadline).foregroundStyle(.secondary)
        }
    }

    private var detail: String {
        let ceiling = scan.summary.ceilingHeightM.map { String(format: "ceiling %.2f m", $0) } ?? "no ceiling"
        let area = String(format: "%.1f m²", scan.summary.netAreaM2)
        return "\(scan.summary.rooms) room(s) · \(ceiling) · \(area) · \(scan.capturedAt.formatted(date: .omitted, time: .shortened))"
    }
}

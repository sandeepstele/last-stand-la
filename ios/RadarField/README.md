# Radar Field (iOS)

> **Not part of the current demo.** This is a stretch tool from the Friday plan: a LiDAR field check that can feed a case. The auditor demo runs entirely on the web app, the agent server and iMessage.

Scan a room with iPhone LiDAR (Apple RoomPlan) and send it to Retrofit Radar as a **field check**. SwiftUI app for iOS 17+. It compiles for a device with Xcode 27.2 and the iOS 27.2 SDK; it has not yet been run on a phone.

## What it does

- **Scan:** scan one room, or several connected rooms in one session. Multiple rooms are merged with `StructureBuilder`.
- **On the phone:** shows ceiling height (median wall height), net floor area (from the floor outlines), level offsets and warnings.
- **Saved files:** raw RoomPlan JSON (`CapturedRoom` / `CapturedStructure`) plus a USDZ model, kept on the phone.
- **Upload:** sends everything to `POST /field/scan` with an `X-Radar-Token` header, then shows the server's one-line reply.
- **Backup:** share the JSON and USDZ through AirDrop or Files.

## Run it on your iPhone (about 10 minutes)

You need a Mac with Xcode 26 or later, a LiDAR device (iPhone 12 Pro through 17 Pro, Pro or Pro Max, or an iPad Pro from 2020 or later) and a free Apple ID.

1. Open `ios/RadarField/RadarField.xcodeproj`.
2. Under target **RadarField** > **Signing & Capabilities**:
   - Set **Team** to your Apple ID (Personal Team).
   - If Xcode says the bundle ID is taken, change it to something unique, e.g. `com.<yourname>.RadarField`.
3. Plug in the phone, then:
   - Turn on **Settings > Privacy & Security > Developer Mode** (the phone restarts).
   - Trust the Mac when asked.
4. Choose the phone as the run destination and press Run.
5. On first launch, go to **Settings > General > VPN & Device Management** and trust your developer certificate.
6. **For the real demo, launch the app from the home screen, not from Xcode.** Developers report corrupted captures when RoomPlan apps are launched from Xcode on iOS 26.

A free Apple ID signs the app for 7 days, which covers the weekend.

## Point it at the backend

The upload route runs inside the agent server. `RADAR_FIELD_TOKEN` must be set in `.env`; uploads are refused without it. On the Mac, in the repo:

```bash
.venv/bin/langgraph dev --host 0.0.0.0 --port 2024 --no-browser
ipconfig getifaddr en0          # the Mac's LAN IP
```

In the app, set **Upload URL** to `http://<that IP>:2024/field/scan` and **Upload token** to the `RADAR_FIELD_TOKEN` value from `.env`.

**If venue Wi-Fi blocks phone-to-laptop traffic** (client isolation), either:
- join the Mac to the phone's hotspot, or
- start the server with `--tunnel` and paste the `https://…/field/scan` URL it prints.

Scans are stored in the agent's Store, so the same route works on the LangSmith deployment.

## Using it

1. **Property ID:** the building the check is for, e.g. `TEST-A`.
2. **Stand-in room:** keep this **on** unless you are standing inside that building. A stand-in is shown as a preview and never changes a verdict.
3. **I checked for stairs going down:** turn this on only if someone actually looked for a basement or lower level. It's the only way a field scan can rule a basement out.
4. **Start scan:** walk slowly along the walls, then tap **Done with room**. Next, either **Scan next room** (same session, so the rooms share one coordinate frame) or **Finish**.
5. **Upload to Radar:** the server's reply appears under the button.

## What the numbers can and can't prove

| Measured | Tolerance | How Radar uses it |
|---|---|---|
| Ceiling height (≤ 3.6 m) | ±5 cm | **Caps** how many floors fit in the aerial height. Never used as floor-to-floor height. |
| Net floor area | ±3% (±5% with glass or clutter) | Interior/usable area, so it reads below rentable. Shown; never reconciled against the listing. |
| Level offsets in one session | about ±15 cm, inferred | A level about 2 m or more below the first room counts as a lower level. |

RoomPlan is designed for rooms up to 15 × 15 m with ceilings up to 3.6 m. A taller ceiling is reported as unverified.

## Demo tips

- **Pick the room:** pre-scout one under about 6 × 6 m, with a ceiling under 3.6 m, good light (50 lux or more) and no glass walls.
- **Capture it early:** scan it again during the Sunday 8–9:30 am pre-warm.
- **Bring a laser measure** so a judge can check the ceiling against the card.
- **Have a fallback:** AirDrop the JSON to both demo laptops.
- **Don't update iOS** before Sunday.

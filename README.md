# Voting Rooms (GitHub Pages)

Static HTML/CSS/JS app hosted on GitHub Pages, using peer-to-peer WebRTC data channels.

## Features
- Host creates a room (local)
- Participants connect via **QR signaling** (offer/answer)
- Participants upload images (sent to host, then rebroadcast)
- Host starts voting phase
- Everyone rates each image 1–5
- Live averages + ranked results

## How it works
- Uses WebRTC with Google STUN (`stun:stun.l.google.com:19302`) to establish connections.
- **No persistence**: when the host leaves, the room ends.
- **No central signaling server**: participants connect by exchanging WebRTC offer/answer via QR.

## Limitations
- Host must keep the tab open.
- Upload limit is set to **2MB per image** (base64 over data channels).
- Large groups will stress the host (uploads are relayed).

## GitHub Pages
- Commit/push the files.
- In GitHub: **Settings → Pages → Build and deployment → Source: Deploy from a branch**.
- Choose branch `main` and folder `/ (root)`.

# Quietline — free two-person voice calls

A minimalist, audio-only WebRTC website. GitHub Pages hosts the static frontend. [PeerJS Cloud](https://peerjs.com/) provides free signaling. No user accounts, cameras, application server, or database.

## Deploy to GitHub Pages

1. Create a **public** GitHub repository named `quietline` at https://github.com/new.
2. Upload `index.html`, `styles.css`, `app.js`, and `.nojekyll` to the repository root, commit to `main`.
3. In **Settings → Pages → Build and deployment**, choose **Deploy from a branch**, `main`, `/(root)`, and **Save**.
4. Your URL will be `https://YOUR_USERNAME.github.io/quietline/`. HTTPS enables microphone permissions.
5. Open the site, tap **Create a private call**, allow mic access, and send **Copy link** to one other person. They open it and tap **Join**.

## 90-minute iPhone Safari test

- First do a 90-minute baseline with the phone awake and Safari in the foreground.
- Then repeat with the iPhone auto-locking. Ask both people to confirm they can hear and speak at 5, 30, 60, 75, and 90 minutes.
- Open **Audio diagnostics** before and after; copy the event log. Note exact iOS version and any Screen Time boundary.
- If Safari asks for interaction to resume audio, a user tap may be unavoidable. This app does **not** bypass Screen Time or iOS autoplay restrictions.

## Technical limitations / privacy

- The 36-character room token uses cryptographically secure randomness; keep the link secret. A room has one host and one guest PeerJS ID.
- WebRTC encrypts media in transit (DTLS-SRTP); calls are intended to be peer-to-peer, though network metadata and signaling necessarily reach third-party services. No call recordings or user accounts are created by this app.
- Public PeerJS Cloud is third-party infrastructure. Reliability and availability are outside the website's control.
- Only public STUN servers are configured; some restrictive networks require a TURN relay, which is *not* included and may cost money. GitHub Pages cannot supply TURN.
- A lost microphone track or iOS user-gesture restriction may require reopening the page or tapping to rejoin. Automatic redial cannot override browser permissions.
- Rejoining on the same link after leaving may give a temporary `unavailable-id` error while the old PeerJS session times out. Retry after a short interval.
- Do not use for emergencies or communications that require guaranteed uptime.

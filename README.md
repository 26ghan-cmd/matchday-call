# Matchday Call

Video calls for watching Premier League matches with friends. Each person watches
the match on their own TV or stream; this app is the "second screen" where you see
and hear each other.

## Run it

You need [Node.js](https://nodejs.org) 18 or newer.

```bash
cd matchday-call
npm install
npm start
```

Open http://localhost:3000, allow camera and mic, enter your name and join.

**Try a call on one computer:** open a second browser tab (or a different browser)
at the same room link. You'll see yourself twice. Wear headphones or mute one tab
to avoid feedback.

## What's in it

- **Rooms by link:** share `?room=your-room-name` and up to 6 people can join.
- **The telly:** the big area at the top shows a shared screen or whoever you've
  pinned. Full-screen button included.
- **Match mode:** a compact strip of faces under the telly.
- **Halftime mode:** a big grid of faces, or telly on the left and faces on the
  right when something is on the telly.
- **Screen sharing** (desktop browsers): your screen goes on everyone's telly and
  your camera stays visible in your tile. If several people share, the most recent
  one shows; pin someone to choose. Not available on phones.
- **Pinning:** 📌 on any tile (or double-click it) puts that person on your telly.
  Only you see your pins.
- **Chat:** side panel with history for late joiners, clickable links and an
  unread badge. History is forgotten when everyone leaves.
- **People list:** everyone's mic/camera/sharing status, pin buttons, and a
  volume slider per person.
- **Reactions:** ⚽ 🔥 😱 👏 😂 🟥 float over your tile and the telly.
- **Settings:** choose microphone, camera and speakers (speaker choice works in
  Chrome and Edge).
- **Talking ring:** a green outline around whoever is speaking.
- Keyboard shortcuts: **M** mic, **V** camera, **S** share, **C** chat,
  **H** layout, **1–6** reactions, **Esc** close panel.
- Echo cancellation and noise suppression are on, to keep TV commentary out of the call.

## How it works

```
server.js        Introduces people in the same room and relays connection details.
                 It never touches video.
                 Also relays chat (keeping recent history per room) and reactions.
public/app.js    WebRTC: every browser connects directly to every other (a "mesh").
                 Each connection has three fixed slots (mic, camera, screen), so
                 sharing or switching devices never interrupts the call.
public/*.html/css  The interface.
```

## Calling friends in other places

`localhost` only works on your own machine. To invite friends:

1. **Quick test:** run a tunnel such as `npx localtunnel --port 3000` or
   `ngrok http 3000`, and share the https link it gives you.
   Browsers only allow camera access on https (or localhost).
2. **Proper hosting:** deploy to any Node host with websockets (Render, Railway,
   Fly.io). They provide https automatically.
3. **TURN relay (needed for most real calls):** many home, office and mobile
   networks block direct connections, so both people see "Couldn't reach…".
   A TURN server relays the video instead. Set **one** of these as environment
   variables on your host (Render: your service → Environment). Never put the
   keys in the code. The server hands browsers short-lived credentials at `/ice`.

   | Provider | Variables | Cost |
   |---|---|---|
   | [Metered](https://www.metered.ca/stun-turn) | `METERED_APP_NAME`, `METERED_API_KEY` | Free 500 MB/month: fine for testing, not a full match |
   | [Cloudflare](https://developers.cloudflare.com/calls/turn/) | `CLOUDFLARE_TURN_KEY_ID`, `CLOUDFLARE_TURN_API_TOKEN` | $0.05/GB, a few cents per match |
   | Any other / self-hosted coturn | `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` | Varies |

   On startup the server log says which relay it's using, e.g. `TURN relay: Metered`.
   To check from a browser, open `https://your-app/ice`: you should see `turn:` URLs.

## Limits and next steps

- A mesh works well for about 6 people. For bigger "pub" rooms, move video to an
  SFU such as LiveKit; the interface can stay the same.
- Next: live score in the pitch area, then the sync calibration and spoiler shield.

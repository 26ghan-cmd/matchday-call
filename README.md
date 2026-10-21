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
- **Match mode:** a compact strip of faces along the bottom, with space above
  reserved for the live score and match events (next step).
- **Halftime mode:** a big grid so you can actually chat.
- **Talking ring:** a green outline around whoever is speaking.
- **Mute and camera toggles** that show up for everyone.
- Keyboard shortcuts: **M** mic, **V** camera, **H** switch Match/Halftime.
- Echo cancellation and noise suppression are on, to keep TV commentary out of the call.

## How it works

```
server.js        Introduces people in the same room and relays connection details.
                 It never touches video.
public/app.js    WebRTC: every browser connects directly to every other (a "mesh").
public/*.html/css  The interface.
```

## Calling friends in other places

`localhost` only works on your own machine. To invite friends:

1. **Quick test:** run a tunnel such as `npx localtunnel --port 3000` or
   `ngrok http 3000`, and share the https link it gives you.
   Browsers only allow camera access on https (or localhost).
2. **Proper hosting:** deploy to any Node host with websockets (Render, Railway,
   Fly.io). They provide https automatically.
3. **TURN server:** about 1 in 10 connections (strict office or mobile networks)
   can't connect directly and need a relay. Get TURN credentials from a provider
   such as Twilio, Metered or Cloudflare, or self-host `coturn`, then add it to
   `ICE_SERVERS` at the top of `public/app.js`:

   ```js
   const ICE_SERVERS = [
     { urls: 'stun:stun.l.google.com:19302' },
     { urls: 'turn:your.turn.host:3478', username: 'USER', credential: 'PASS' },
   ];
   ```

## Limits and next steps

- A mesh works well for about 6 people. For bigger "pub" rooms, move video to an
  SFU such as LiveKit; the interface can stay the same.
- Next: live score in the pitch area, then the sync calibration and spoiler shield.

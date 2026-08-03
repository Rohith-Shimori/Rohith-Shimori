// worker.js — Cloudflare Worker
//
// Merges Spotify "now playing" + a live visitor count into ONE generated SVG.
// Runs entirely on Cloudflare — the same account you already use for DNS/WAF.
// No Vercel, no Upstash: the visitor counter lives in Workers KV.
//
// DEPLOY (dashboard, no CLI needed):
//   1. Cloudflare dashboard → Workers & Pages → Create → Create Worker
//   2. Paste this file's contents into the editor, Deploy
//   3. Worker → Settings → Variables:
//        - Add secrets: SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REFRESH_TOKEN
//          (mark each as "Encrypt" so they're not visible after saving)
//   4. Worker → Settings → Bindings → KV Namespace binding:
//        - Create a namespace called "PULSE_KV", bind it to variable name PULSE_KV
//   5. Worker → Settings → Triggers → Custom Domains:
//        - Add pulse.rohith.is-a.dev (since it's already on Cloudflare, this is instant)
//   6. Embed in README:
//        <img src="https://pulse.rohith.is-a.dev" width="440" alt="Live Pulse" />

export default {
  async fetch(request, env) {
    const { SPOTIFY_CLIENT_ID, SPOTIFY_CLIENT_SECRET, SPOTIFY_REFRESH_TOKEN, PULSE_KV } = env;

    // 1. Refresh the Spotify access token
    let access_token = null;
    try {
      const tokenRes = await fetch("https://accounts.spotify.com/api/token", {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: "Basic " + btoa(`${SPOTIFY_CLIENT_ID}:${SPOTIFY_CLIENT_SECRET}`),
        },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: SPOTIFY_REFRESH_TOKEN,
        }),
      });
      const tokenData = await tokenRes.json();
      access_token = tokenData.access_token || null;
    } catch (e) {
      access_token = null;
    }

    // 2. Currently playing track (or null if offline/paused)
    let track = null;
    if (access_token) {
      try {
        const nowRes = await fetch("https://api.spotify.com/v1/me/player/currently-playing", {
          headers: { Authorization: `Bearer ${access_token}` },
        });
        if (nowRes.status === 200) {
          const data = await nowRes.json();
          if (data && data.item) {
            track = {
              name: data.item.name,
              artist: data.item.artists.map((a) => a.name).join(", "),
              albumArt: data.item.album.images?.[0]?.url,
              progress: data.progress_ms,
              duration: data.item.duration_ms,
            };
          }
        }
      } catch (e) {
        track = null;
      }
    }

    // 3. Fetch album art bytes and inline as base64.
    //    (A nested external <image href> inside the SVG would get dropped by
    //    GitHub's camo proxy — it only fetches the top-level image URL. Baking
    //    the art in as a data URI makes the whole card one self-contained resource.)
    let albumArtDataUri = null;
    if (track?.albumArt) {
      try {
        const imgRes = await fetch(track.albumArt);
        const imgBuffer = await imgRes.arrayBuffer();
        const bytes = new Uint8Array(imgBuffer);
        let binary = "";
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
        albumArtDataUri = `data:image/jpeg;base64,${btoa(binary)}`;
      } catch (e) {
        albumArtDataUri = null;
      }
    }

    // 4. Visitor counter — Workers KV, incremented on every request to this endpoint
    let visitors = 0;
    try {
      const current = await PULSE_KV.get("pulse_visitors");
      visitors = (parseInt(current) || 0) + 1;
      await PULSE_KV.put("pulse_visitors", visitors.toString());
    } catch (e) {
      visitors = 0;
    }

    // 5. Build the merged SVG card
    const progressPct = track ? Math.min(100, (track.progress / track.duration) * 100) : 0;
    const statusLine = track ? `${track.name} — ${track.artist}` : "offline · probably deep in a bug";
    const trimmedLine = statusLine.length > 34 ? statusLine.slice(0, 31) + "..." : statusLine;

    const svg = `
<svg width="440" height="130" viewBox="0 0 440 130" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <clipPath id="artClip"><rect x="16" y="16" width="98" height="98" rx="10"/></clipPath>
  </defs>
  <rect width="440" height="130" rx="14" fill="#0B0B0C" stroke="#27272A" stroke-width="1.5"/>
  ${
    albumArtDataUri
      ? `<image href="${albumArtDataUri}" x="16" y="16" width="98" height="98" clip-path="url(#artClip)" preserveAspectRatio="xMidYMid slice"/>`
      : `<rect x="16" y="16" width="98" height="98" rx="10" fill="#18181C"/><text x="65" y="74" font-size="34" text-anchor="middle" fill="#E05315" font-family="monospace">◎</text>`
  }
  <text x="130" y="38" font-family="'Courier New', monospace" font-size="11" fill="#E05315" font-weight="700">${track ? "NOW VIBING" : "STATUS"}</text>
  <text x="130" y="62" font-family="'Courier New', monospace" font-size="15" fill="#F4F4F5" font-weight="700">${trimmedLine}</text>
  <rect x="130" y="76" width="290" height="4" rx="2" fill="#222227"/>
  <rect x="130" y="76" width="${(290 * progressPct) / 100}" height="4" rx="2" fill="#E05315"/>
  <line x1="130" y1="96" x2="420" y2="96" stroke="#27272A" stroke-width="1"/>
  <text x="130" y="115" font-family="'Courier New', monospace" font-size="12" fill="#9DA3AE">visitor #${visitors} stopped by while this played</text>
</svg>`.trim();

    return new Response(svg, {
      headers: {
        "Content-Type": "image/svg+xml",
        "Cache-Control": "no-cache, no-store, must-revalidate",
        "Access-Control-Allow-Origin": "*",
      },
    });
  },
};

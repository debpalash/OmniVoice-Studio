/**
 * VoiceStudio installer redirect — one URL for every platform.
 *
 *   curl -fsSL https://voicestudio.sh/install | sh     # macOS / Linux / WSL
 *   irm  https://voicestudio.sh/install | iex          # Windows PowerShell
 *
 * `/install` sniffs the User-Agent and serves the matching script;
 * `/install.sh` and `/install.ps1` force a format explicitly.
 * Scripts are proxied live from `main` on GitHub, so pushing to main
 * updates what the URL serves — no redeploy needed (5-min edge cache).
 */

const REPO_RAW = "https://raw.githubusercontent.com/debpalash/VoiceStudio/main/scripts";

const HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Install VoiceStudio</title>
<style>
  body { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; background: #14121f; color: #e8e6f0;
         display: flex; min-height: 100vh; align-items: center; justify-content: center; margin: 0; }
  main { max-width: 42rem; padding: 2rem; }
  h1 { color: #b9a7ff; }
  code { display: block; background: #221f33; padding: .8rem 1rem; border-radius: .5rem;
         overflow-x: auto; margin: .4rem 0 1.2rem; color: #8fdcb0; }
  p.dim { color: #8a86a0; }
</style>
</head>
<body>
<main>
  <h1>🎙 Install VoiceStudio</h1>
  <p>macOS / Linux / WSL (prebuilt app):</p>
  <code>curl -fsSL https://voicestudio.sh/install | sh</code>
  <p>Pick a version, or build from source:</p>
  <code>curl -fsSL https://voicestudio.sh/install | sh -s -- --version 0.5.2<br>curl -fsSL https://voicestudio.sh/install | sh -s -- --source</code>
  <p>Windows PowerShell:</p>
  <code>irm https://voicestudio.sh/install | iex</code>
  <p class="dim">PowerShell source mode: set $env:VOICESTUDIO_INSTALL_MODE = "source" first.</p>
  <p class="dim">First launch downloads ~5 GB of model weights. Everything runs locally.</p>
  <p class="dim"><a style="color:#8a86a0" href="https://github.com/debpalash/VoiceStudio">GitHub →</a></p>
</main>
</body>
</html>`;

function pickFormat(request, pathname) {
    if (pathname === "/install.sh") return "sh";
    if (pathname === "/install.ps1") return "ps1";
    const ua = request.headers.get("User-Agent") || "";
    if (/PowerShell|Pwsh/i.test(ua)) return "ps1";
    return "sh";
}

export default {
    async fetch(request) {
        const url = new URL(request.url);
        const { pathname } = url;

        if (pathname === "/install" || pathname === "/install.sh" || pathname === "/install.ps1") {
            // Browsers hitting /install get the landing page instead of script soup.
            const accept = request.headers.get("Accept") || "";
            if (pathname === "/install" && accept.includes("text/html")) {
                return new Response(HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
            }
            const format = pickFormat(request, pathname);
            const upstream = await fetch(`${REPO_RAW}/install.${format}`, {
                cf: { cacheTtl: 300, cacheEverything: true },
            });
            if (!upstream.ok) {
                return new Response("Installer script unavailable — try again shortly.", { status: 502 });
            }
            return new Response(upstream.body, {
                status: 200,
                headers: {
                    "Content-Type": format === "sh"
                        ? "application/x-sh; charset=utf-8"
                        : "text/plain; charset=utf-8",
                    "Cache-Control": "public, max-age=300",
                },
            });
        }

        return Response.redirect(`https://github.com/debpalash/VoiceStudio${pathname}`, 302);
    },
};

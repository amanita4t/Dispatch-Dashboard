/**
 * One-time helper: obtains a Google OAuth refresh token for DispatchBoard.
 *
 * Usage:
 *   node scripts/get-refresh-token.js <CLIENT_ID> <CLIENT_SECRET>
 *
 * Opens a consent URL; after you approve in the browser, the refresh token
 * is printed so it can be placed in .env.local as GOOGLE_OAUTH_REFRESH_TOKEN.
 */
const http = require("http");
const { google } = require("googleapis");

const [clientId, clientSecret] = process.argv.slice(2);
if (!clientId || !clientSecret) {
  console.error("Usage: node scripts/get-refresh-token.js <CLIENT_ID> <CLIENT_SECRET>");
  process.exit(1);
}

const PORT = 53682;
const REDIRECT = `http://localhost:${PORT}/callback`;
const oauth2 = new google.auth.OAuth2(clientId, clientSecret, REDIRECT);

const url = oauth2.generateAuthUrl({
  access_type: "offline",
  prompt: "consent",
  scope: ["https://www.googleapis.com/auth/drive"],
});

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, REDIRECT);
  if (u.pathname !== "/callback") {
    res.writeHead(404).end();
    return;
  }
  const code = u.searchParams.get("code");
  if (!code) {
    res.writeHead(400).end("Missing code");
    return;
  }
  try {
    const { tokens } = await oauth2.getToken(code);
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end("<h2>Done! You can close this tab and return to the terminal.</h2>");
    console.log("\n=== SUCCESS ===");
    console.log("GOOGLE_OAUTH_REFRESH_TOKEN=" + tokens.refresh_token);
    console.log("===============\n");
  } catch (e) {
    res.writeHead(500).end("Token exchange failed: " + e.message);
    console.error("Token exchange failed:", e.message);
  }
  server.close();
  process.exit(0);
});

server.listen(PORT, () => {
  console.log("\nOpen this URL in your browser and sign in with the Google account that owns the dispatch folder:\n");
  console.log(url + "\n");
  console.log("Waiting for you to approve…");
});

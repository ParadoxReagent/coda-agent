#!/usr/bin/env tsx
/**
 * Interactive CLI for setting up Gmail OAuth2 authentication.
 *
 * Usage: pnpm run setup:email-oauth
 *
 * Prerequisites:
 *   1. Create a Google Cloud OAuth client (Desktop app type)
 *   2. Set GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET in .env
 *   3. Set GMAIL_USER in .env
 *   4. Database must be running (for token storage)
 */

import { readFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";

// Load .env file manually (avoid dotenv dependency)
function loadEnvFile() {
  const envPath = ".env";
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    const value = trimmed.slice(eqIdx + 1).trim();
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}
loadEnvFile();
import { OAuthManager } from "../auth/oauth-manager.js";
import { TokenStorage } from "../auth/token-storage.js";
import { createDatabase } from "../db/index.js";

const DEFAULT_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.modify",
];

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  console.log("\n=== Gmail OAuth2 Setup ===\n");

  // Gather config from env or prompt
  const clientId = process.env.GMAIL_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GMAIL_OAUTH_CLIENT_SECRET;
  const databaseUrl = process.env.DATABASE_URL ?? "postgresql://coda:coda@localhost:5432/coda";
  const redirectPort = parseInt(process.env.GMAIL_OAUTH_REDIRECT_PORT ?? "3000", 10);

  if (!clientId || !clientSecret) {
    console.error("Error: GMAIL_OAUTH_CLIENT_ID and GMAIL_OAUTH_CLIENT_SECRET must be set in .env");
    console.error("\nTo create OAuth credentials:");
    console.error("  1. Go to https://console.cloud.google.com/apis/credentials");
    console.error("  2. Create an OAuth 2.0 Client ID (Desktop app type)");
    console.error("  3. Add the Client ID and Secret to your .env file");
    process.exit(1);
  }

  let gmailUser = process.env.GMAIL_USER;
  if (!gmailUser) {
    gmailUser = await prompt("Enter your Gmail address: ");
    if (!gmailUser) {
      console.error("Error: Gmail address is required.");
      process.exit(1);
    }
  }

  console.log(`\nGmail user: ${gmailUser}`);
  console.log(`OAuth redirect port: ${redirectPort}`);
  console.log(`Scopes: ${DEFAULT_SCOPES.join(", ")}`);

  // Initialize OAuth manager
  const oauthManager = new OAuthManager({
    clientId,
    clientSecret,
    redirectPort,
    scopes: DEFAULT_SCOPES,
  });

  // Generate authorization URL
  const authUrl = oauthManager.getAuthorizationUrl();

  console.log("\n--- Step 1: Authorize with Google ---\n");
  console.log("Opening browser for Google authorization...\n");
  console.log(`If the browser doesn't open, visit this URL manually:\n\n${authUrl}\n`);

  // Open browser
  try {
    const open = (await import("open")).default;
    await open(authUrl);
  } catch {
    console.log("(Could not open browser automatically. Please open the URL above manually.)");
  }

  console.log("Waiting for authorization callback...\n");

  // Wait for callback and exchange code
  let tokens;
  try {
    tokens = await oauthManager.authorize();
  } catch (err) {
    console.error(`\nAuthorization failed: ${err instanceof Error ? err.message : "Unknown error"}`);
    process.exit(1);
  }

  console.log("\n--- Step 2: Saving tokens ---\n");

  // Connect to database and save tokens
  const { db, client: dbClient } = createDatabase(databaseUrl);
  const tokenStorage = new TokenStorage(db);

  try {
    await tokenStorage.saveTokens("gmail", gmailUser, tokens);
    console.log("OAuth tokens saved to database successfully!");
  } catch (err) {
    console.error(`Failed to save tokens: ${err instanceof Error ? err.message : "Unknown error"}`);
    console.error("\nMake sure the database is running and the oauth_tokens table exists.");
    console.error("Run: pnpm run db:migrate");
    process.exit(1);
  } finally {
    await dbClient.end();
  }

  console.log("\n=== Setup Complete ===\n");
  console.log("Your Gmail OAuth2 authentication is configured.");
  console.log("Make sure these are in your .env:");
  console.log(`  GMAIL_OAUTH_CLIENT_ID=${clientId}`);
  console.log(`  GMAIL_OAUTH_CLIENT_SECRET=${clientSecret}`);
  console.log(`  GMAIL_USER=${gmailUser}`);
  console.log("\nRestart coda-agent to use Gmail API with OAuth2.\n");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});

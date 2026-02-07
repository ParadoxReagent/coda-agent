import { google } from "googleapis";
import { createServer } from "node:http";
import type { StoredTokens } from "./token-storage.js";

type OAuth2Client = InstanceType<typeof google.auth.OAuth2>;

export interface OAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectPort: number;
  scopes: string[];
}

export class OAuthManager {
  private config: OAuthConfig;

  constructor(config: OAuthConfig) {
    this.config = config;
  }

  private get redirectUri(): string {
    return `http://localhost:${this.config.redirectPort}/oauth/callback`;
  }

  private createOAuth2Client(): OAuth2Client {
    return new google.auth.OAuth2(
      this.config.clientId,
      this.config.clientSecret,
      this.redirectUri
    );
  }

  getAuthorizationUrl(): string {
    const client = this.createOAuth2Client();
    return client.generateAuthUrl({
      access_type: "offline",
      scope: this.config.scopes,
      prompt: "consent",
    });
  }

  async authorize(): Promise<StoredTokens> {
    const code = await this.waitForCallback();
    return this.exchangeCode(code);
  }

  async exchangeCode(code: string): Promise<StoredTokens> {
    const client = this.createOAuth2Client();
    const { tokens } = await client.getToken(code);

    if (!tokens.access_token || !tokens.refresh_token) {
      throw new Error("OAuth response missing required tokens. Ensure prompt=consent is set.");
    }

    return {
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      tokenType: tokens.token_type ?? "Bearer",
      expiryDate: new Date(tokens.expiry_date ?? Date.now() + 3600_000),
      scope: tokens.scope ?? this.config.scopes.join(" "),
    };
  }

  async refreshAccessToken(refreshToken: string): Promise<StoredTokens> {
    const client = this.createOAuth2Client();
    client.setCredentials({ refresh_token: refreshToken });

    const { credentials } = await client.refreshAccessToken();

    if (!credentials.access_token) {
      throw new Error("Failed to refresh access token. User may have revoked access.");
    }

    return {
      accessToken: credentials.access_token,
      refreshToken: credentials.refresh_token ?? refreshToken,
      tokenType: credentials.token_type ?? "Bearer",
      expiryDate: new Date(credentials.expiry_date ?? Date.now() + 3600_000),
      scope: credentials.scope ?? this.config.scopes.join(" "),
    };
  }

  isTokenValid(expiryDate: Date): boolean {
    const bufferMs = 5 * 60 * 1000; // 5-minute buffer
    return expiryDate.getTime() - bufferMs > Date.now();
  }

  getAuthenticatedClient(accessToken: string): OAuth2Client {
    const client = this.createOAuth2Client();
    client.setCredentials({ access_token: accessToken });
    return client;
  }

  waitForCallback(): Promise<string> {
    return new Promise<string>((resolve, reject) => {
      const timeoutMs = 5 * 60 * 1000; // 5 minutes

      const server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", `http://localhost:${this.config.redirectPort}`);

        if (url.pathname === "/oauth/callback") {
          const code = url.searchParams.get("code");
          const error = url.searchParams.get("error");

          if (error) {
            res.writeHead(400, { "Content-Type": "text/html" });
            res.end(`<html><body><h1>Authorization Failed</h1><p>Error: ${error}</p><p>You can close this window.</p></body></html>`);
            cleanup();
            reject(new Error(`OAuth authorization denied: ${error}`));
            return;
          }

          if (code) {
            res.writeHead(200, { "Content-Type": "text/html" });
            res.end("<html><body><h1>Authorization Successful!</h1><p>You can close this window and return to the terminal.</p></body></html>");
            cleanup();
            resolve(code);
            return;
          }

          res.writeHead(400, { "Content-Type": "text/plain" });
          res.end("Missing authorization code");
        } else {
          res.writeHead(404, { "Content-Type": "text/plain" });
          res.end("Not found");
        }
      });

      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("OAuth callback timed out after 5 minutes. Please try again."));
      }, timeoutMs);

      function cleanup() {
        clearTimeout(timeout);
        server.close();
      }

      server.listen(this.config.redirectPort, () => {
        // Server is ready for OAuth callback
      });

      server.on("error", (err) => {
        cleanup();
        reject(new Error(`Failed to start OAuth callback server: ${err.message}`));
      });
    });
  }
}

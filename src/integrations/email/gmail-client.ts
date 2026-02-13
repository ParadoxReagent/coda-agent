import { google, type gmail_v1 } from "googleapis";
import { OAuthManager } from "../../auth/oauth-manager.js";
import { TokenStorage } from "../../auth/token-storage.js";

export class GmailClient {
  private oauthManager: OAuthManager;
  private tokenStorage: TokenStorage;
  private gmailUser: string;

  constructor(
    oauthManager: OAuthManager,
    tokenStorage: TokenStorage,
    gmailUser: string
  ) {
    this.oauthManager = oauthManager;
    this.tokenStorage = tokenStorage;
    this.gmailUser = gmailUser;
  }

  private async getGmailApi(): Promise<gmail_v1.Gmail> {
    const stored = await this.tokenStorage.getTokens("gmail", this.gmailUser);
    if (!stored) {
      throw new Error("No OAuth tokens found. Please run: pnpm run setup:email-oauth");
    }

    let accessToken = stored.accessToken;

    if (!this.oauthManager.isTokenValid(stored.expiryDate)) {
      const refreshed = await this.oauthManager.refreshAccessToken(stored.refreshToken);
      await this.tokenStorage.saveTokens("gmail", this.gmailUser, refreshed);
      accessToken = refreshed.accessToken;
    }

    const auth = this.oauthManager.getAuthenticatedClient(accessToken);
    return google.gmail({ version: "v1", auth });
  }

  async listMessages(
    labelIds: string[],
    maxResults = 100,
    pageToken?: string,
    query?: string
  ): Promise<gmail_v1.Schema$ListMessagesResponse> {
    const gmail = await this.getGmailApi();
    const res = await gmail.users.messages.list({
      userId: "me",
      labelIds,
      maxResults,
      pageToken,
      q: query,
    });
    return res.data;
  }

  async getMessage(
    messageId: string,
    format: "full" | "metadata" | "minimal" = "metadata"
  ): Promise<gmail_v1.Schema$Message> {
    const gmail = await this.getGmailApi();
    const res = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format,
    });
    return res.data;
  }

  async modifyMessage(
    messageId: string,
    addLabels?: string[],
    removeLabels?: string[]
  ): Promise<gmail_v1.Schema$Message> {
    const gmail = await this.getGmailApi();
    const res = await gmail.users.messages.modify({
      userId: "me",
      id: messageId,
      requestBody: {
        addLabelIds: addLabels,
        removeLabelIds: removeLabels,
      },
    });
    return res.data;
  }
}

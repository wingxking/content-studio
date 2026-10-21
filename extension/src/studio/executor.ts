import { z } from "zod";
import { checkPlatformAuth } from "../adapters";
import { performSync } from "../background/sync-service";
import {
  normalizeStudioReceipt,
  studioHello,
  studioPlatforms,
  studioSaveSchema,
  studioJournalKey,
  studioJournalConfirmationSchema,
  type StudioSave,
} from "./protocol";
import { hasUnresolvedJournal, studioJournalSchema, journalStatus } from "./journal";

export const journalKey = studioJournalKey;
type Journal = z.infer<typeof studioJournalSchema>;

export class StudioExecutor {
  private busy = false;

  isBusy(): boolean {
    return this.busy;
  }

  async handle(
    method: string,
    params?: Record<string, unknown>,
    sessionActive: () => boolean = () => true,
  ): Promise<unknown> {
    if (method === "studio.hello") return studioHello;
    if (method === 'studio.journal') {
      const stored = await chrome.storage.local.get(journalKey);
      return journalStatus(stored[journalKey]);
    }
    if (method === 'studio.confirmReceipt') {
      if (this.busy) throw new Error('Studio executor is busy');
      this.busy = true;
      try { return await this.confirmReceipt(params, sessionActive); }
      finally { this.busy = false; }
    }
    if (method === "checkAuth") {
      const { platform } = z
        .object({ platform: z.enum(studioPlatforms) })
        .strict()
        .parse(params);
      // Only the explicitly selected account is checked; no all-platform login scan.
      const auth = await checkPlatformAuth(platform);
      if ("error" in auth && auth.error)
        throw new Error("Studio account check unavailable");
      return {
        isAuthenticated: auth.isAuthenticated,
        ...("userId" in auth && auth.userId !== undefined
          ? { userId: String(auth.userId) }
          : {}),
        ...("username" in auth && typeof auth.username === "string"
          ? { username: auth.username }
          : {}),
      };
    }
    if (method !== "syncArticle") throw new Error("Unsupported Studio method");
    const request = studioSaveSchema.parse(params);
    if (this.busy) throw new Error("Studio executor is busy");
    this.busy = true;
    try {
      return await this.save(request, sessionActive);
    } finally {
      this.busy = false;
    }
  }

  private async confirmReceipt(params: unknown, sessionActive: () => boolean): Promise<unknown> {
    const { request, receipt: input } = studioJournalConfirmationSchema.parse(params);
    const receipt = normalizeStudioReceipt(input, request.platforms[0]);
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(request)));
    const requestHash = [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
    const stored = await chrome.storage.local.get(journalKey);
    const journal = studioJournalSchema.parse(stored[journalKey] ?? {});
    const previous = journal[request.execution.jobId];
    if (!previous || previous.requestHash !== requestHash) throw new Error('Receipt does not match the original draft request');
    if (previous.status === 'completed' && previous.receipt && (previous.receipt.postId !== receipt.postId || previous.receipt.postUrl !== receipt.postUrl)) throw new Error('Existing receipt differs');
    if (!sessionActive()) throw new Error('Studio session disconnected');
    const auth = await checkPlatformAuth(request.platforms[0]);
    if (!sessionActive() || !auth.isAuthenticated || !('userId' in auth) || String(auth.userId) !== request.execution.expectedUserId) throw new Error('Studio target account changed');
    if (previous.status !== 'completed' || !previous.receipt) {
      journal[request.execution.jobId] = { ...previous, status: 'completed', receipt, reconciliation: { verification: 'operator_verified', verifiedAt: new Date().toISOString() } };
      await chrome.storage.local.set({ [journalKey]: journal });
    }
    return { synchronized: true, jobId: request.execution.jobId };
  }

  private async save(
    request: StudioSave,
    sessionActive: () => boolean,
  ): Promise<unknown> {
    const platform = request.platforms[0];
    const execution = request.execution;
    // Bind duplicate detection to the full wire payload as well as Studio's approval hash.
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(JSON.stringify(request)),
    );
    const requestHash = [...new Uint8Array(digest)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
    const stored: Record<string, unknown> =
      await chrome.storage.local.get(journalKey);
    const journal: Journal = studioJournalSchema.parse(
      stored[journalKey] === undefined ? {} : stored[journalKey],
    );
    const previous = journal[execution.jobId];
    if (previous) {
      if (previous.requestHash !== requestHash)
        throw new Error("Studio job payload changed");
      if (previous.status !== "completed" || !previous.receipt)
        throw new Error("Draft outcome requires reconciliation");
      return { results: [previous.receipt], execution };
    }
    // A recovered transport or extension reload must not authorize a different
    // write while an earlier platform outcome is unknown. Completed receipts
    // above remain readable without another platform call.
    if (hasUnresolvedJournal(journal))
      throw new Error(
        "Draft outcome requires reconciliation before new writes",
      );
    // Never evict uncertain entries to make space; fail closed at the local bound.
    if (Object.keys(journal).length >= 2000)
      throw new Error("Studio draft journal requires operator maintenance");
    const verifyAccount = async () => {
      if (!sessionActive()) throw new Error("Studio session disconnected");
      const auth = await checkPlatformAuth(platform);
      if (
        !sessionActive() ||
        !auth.isAuthenticated ||
        !("userId" in auth) ||
        String(auth.userId) !== execution.expectedUserId
      )
        throw new Error("Studio target account changed");
    };
    await verifyAccount();
    // Persist BEFORE preprocessing, image uploads or a draft write. A worker restart
    // leaves this job uncertain; replay must never call a platform writer again.
    journal[execution.jobId] = { status: "started", requestHash };
    await chrome.storage.local.set({ [journalKey]: journal });
    const { results } = await performSync(
      { ...request.article, html: request.article.content },
      [platform],
      {
        source: "content-studio",
        skipHistory: true,
        beforeSync: verifyAccount,
      },
    );
    if (results.length !== 1) throw new Error("Missing draft receipt");
    const receipt = normalizeStudioReceipt(results[0], platform);
    journal[execution.jobId] = { status: "completed", requestHash, receipt };
    await chrome.storage.local.set({ [journalKey]: journal });
    return { results: [receipt], execution };
  }
}

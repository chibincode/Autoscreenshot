import path from "node:path";
import type {
  EagleFlatFolder,
  EagleFolderNode,
  EagleImportInput,
  EagleImportResult,
} from "../types.js";

interface EagleResponse<T = unknown> {
  status?: string;
  message?: string;
  data?: T;
}

interface EagleFolderListData {
  folders?: EagleFolderNode[];
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
}

export class EagleClient {
  private readonly baseUrl: string;
  private readonly token?: string;

  constructor(baseUrl = "http://localhost:41595", token?: string) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.token = token;
  }

  async healthCheck(): Promise<boolean> {
    try {
      const candidatePaths = ["/api/library/info", "/api/application/info"];
      for (const endpoint of candidatePaths) {
        const response = await this.request<EagleResponse>(
          endpoint,
          "GET",
          undefined,
          false,
        );
        if (response.ok) {
          return true;
        }
      }
      return false;
    } catch {
      return false;
    }
  }

  async createFolderIfNeeded(folderName?: string): Promise<string | undefined> {
    if (!folderName) {
      return undefined;
    }
    const body = this.withToken({
      folderName,
    });
    try {
      const response = await this.request<EagleResponse<{ id?: string }>>(
        "/api/folder/create",
        "POST",
        body,
      );
      if (response.json?.status && response.json.status !== "success") {
        return undefined;
      }
      if (response.json?.data?.id) {
        return response.json.data.id;
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  async listFolders(): Promise<EagleFolderNode[]> {
    const response = await this.request<EagleResponse<EagleFolderNode[] | EagleFolderListData>>(
      "/api/folder/list",
      "GET",
    );
    if (!response.ok || !response.json) {
      throw new Error("Eagle API /api/folder/list failed");
    }

    const payload = response.json;
    if (payload.status && payload.status !== "success") {
      throw new Error(payload.message ?? "Eagle folder list request failed");
    }

    const data = payload.data;
    if (Array.isArray(data)) {
      return data;
    }
    if (data && typeof data === "object" && Array.isArray((data as EagleFolderListData).folders)) {
      return (data as EagleFolderListData).folders ?? [];
    }
    return [];
  }

  flattenFolders(folders: EagleFolderNode[]): EagleFlatFolder[] {
    const flattened: EagleFlatFolder[] = [];

    const walk = (nodes: EagleFolderNode[], parentPath: string): void => {
      for (const node of nodes) {
        const currentPath = parentPath ? `${parentPath}/${node.name}` : node.name;
        flattened.push({
          id: node.id,
          name: node.name,
          path: currentPath,
        });
        if (node.children && node.children.length > 0) {
          walk(node.children, currentPath);
        }
      }
    };

    walk(folders, "");
    return flattened;
  }

  async addImageFromPath(input: EagleImportInput): Promise<EagleImportResult> {
    const payload = this.withToken({
      path: input.asset.filePath,
      name: path.basename(input.asset.fileName, path.extname(input.asset.fileName)),
      website: input.asset.sourceUrl,
      tags: input.extraTags,
      annotation: input.annotation,
      folderId: input.folderId,
      star: input.star,
    });

    try {
      const response = await this.request<EagleResponse<{ id?: string }>>(
        "/api/item/addFromPath",
        "POST",
        payload,
      );
      if (response.json?.status && response.json.status !== "success") {
        return {
          ok: false,
          error: response.json.message ?? "Eagle rejected import request",
        };
      }
      return {
        ok: true,
        eagleId: response.json?.data?.id,
      };
    } catch (error) {
      return {
        ok: false,
        error: String(error instanceof Error ? error.message : error),
      };
    }
  }

  private withToken<T extends Record<string, unknown>>(payload: T): T & { token?: string } {
    if (!this.token) {
      return payload;
    }
    return {
      ...payload,
      token: this.token,
    };
  }

  private async request<T>(
    endpoint: string,
    method: "GET" | "POST",
    body?: Record<string, unknown>,
    shouldThrowOnError = true,
  ): Promise<{ ok: boolean; json?: T }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch(`${this.baseUrl}${endpoint}`, {
        method,
        headers:
          method === "POST"
            ? {
                "Content-Type": "application/json",
              }
            : undefined,
        body: method === "POST" && body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        if (shouldThrowOnError) {
          throw new Error(
            `Eagle API ${endpoint} failed: HTTP ${response.status} ${errorText}`.trim(),
          );
        }
        return { ok: false };
      }

      const json = (await response.json()) as T;
      return { ok: true, json };
    } finally {
      clearTimeout(timeout);
    }
  }
}

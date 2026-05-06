import type {
  DkgPrivateStorageStatus,
  DkgPublishDiagnostics,
  DkgPublishError,
  DkgPublishResult,
  DkgPublishStatus,
} from "./types";

type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface DkgV10Config {
  apiUrl: string;
  authToken?: string;
  contextGraphId?: string;
  publishRoute?: string;
  queryRoute?: string;
  fetch?: FetchLike;
}

export interface DkgV10PublishInput {
  public: Record<string, unknown>;
  private?: Record<string, unknown>;
  contextGraphId?: string;
}

export interface DkgWorkerFeedbackEvidence {
  jobId?: string;
  satisfied?: boolean;
  proofURI?: string;
  dkgUal?: string;
  publicJobMetadata?: Record<string, unknown>;
  summary?: string;
}

interface RawDkgV10QueryResponse {
  result?: { bindings?: Array<Record<string, { value?: unknown } | unknown>> };
  results?: { bindings?: Array<Record<string, { value?: unknown } | unknown>> };
  data?: Array<Record<string, unknown>>;
  bindings?: Array<Record<string, { value?: unknown } | unknown>>;
  error?: { code?: string; message?: string; retryable?: boolean } | string;
  message?: string;
}

interface RawDkgV10Response {
  status?: string;
  contextGraphId?: string;
  kcId?: string | number;
  txHash?: string;
  receiptUri?: string;
  localId?: string;
  privateStoredLocally?: boolean;
  privateStorageStatus?: DkgPrivateStorageStatus;
  diagnostics?: DkgPublishDiagnostics;
  error?: { code?: string; message?: string; retryable?: boolean } | string;
  message?: string;
}

export class V10NodeDkgClient {
  private readonly apiUrl: string;
  private readonly authToken?: string;
  private readonly contextGraphId?: string;
  private readonly publishRoute: string;
  private readonly queryRoute: string;
  private readonly fetchImpl: FetchLike;

  constructor(config: DkgV10Config) {
    this.apiUrl = config.apiUrl.replace(/\/$/, "");
    this.authToken = config.authToken;
    this.contextGraphId = config.contextGraphId;
    this.publishRoute = config.publishRoute ?? "/api/publish-direct";
    this.queryRoute = config.queryRoute ?? "/api/query";
    this.fetchImpl = config.fetch ?? fetch;
  }

  async publishPublic(input: DkgV10PublishInput): Promise<DkgPublishResult> {
    return this.publish(input, false);
  }

  async publishPrivate(input: DkgV10PublishInput): Promise<DkgPublishResult> {
    return this.publish(input, true);
  }

  async query(sparql: string, opts?: { contextGraphId?: string; includeSharedMemory?: boolean; view?: string }): Promise<Array<Record<string, unknown>>> {
    const contextGraphId = opts?.contextGraphId ?? this.contextGraphId ?? "";
    const response = await this.fetchImpl(`${this.apiUrl}${this.queryRoute}`, {
      method: "POST",
      headers: this.buildHeaders(),
      body: JSON.stringify({
        sparql,
        contextGraphId,
        includeSharedMemory: opts?.includeSharedMemory ?? true,
        view: opts?.view,
      }),
    });

    const raw = await this.safeReadQueryJson(response);
    if (!response.ok) {
      const message = this.errorMessage(raw as RawDkgV10Response) || `DKG V10 query failed with HTTP ${response.status}`;
      throw new Error(this.redact(message));
    }

    return this.extractBindings(raw);
  }

  async queryWorkerFeedbackEvidence(
    wallet: string,
    jobSpec: Record<string, unknown>,
    opts?: { contextGraphId?: string },
  ): Promise<DkgWorkerFeedbackEvidence[]> {
    const sparql = this.buildWorkerFeedbackEvidenceQuery(wallet, jobSpec);
    const rows = await this.query(sparql, { contextGraphId: opts?.contextGraphId });
    return rows.map((row) => ({
      jobId: this.optionalString(row.jobId),
      proofURI: this.optionalString(row.proofURI),
      dkgUal: this.optionalString(row.feedback),
      satisfied: this.optionalBoolean(row.satisfied),
      summary: this.optionalString(row.summary),
      publicJobMetadata: this.optionalJsonObject(row.publicJobMetadata),
    }));
  }

  private async publish(input: DkgV10PublishInput, isPrivate: boolean): Promise<DkgPublishResult> {
    const contextGraphId = input.contextGraphId ?? this.contextGraphId ?? "";

    try {
      const response = await this.fetchImpl(`${this.apiUrl}${this.publishRoute}`, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify({
          contextGraphId,
          public: input.public,
          ...(isPrivate && input.private ? { private: input.private } : {}),
        }),
      });

      const raw = await this.safeReadJson(response);

      if (!response.ok) {
        return {
          status: "failed",
          contextGraphId,
          error: this.mapError(raw, response.status),
        };
      }

      return this.mapResponse(raw, contextGraphId, isPrivate);
    } catch (error) {
      return {
        status: "failed",
        contextGraphId,
        error: {
          code: "DKG_V10_REQUEST_FAILED",
          message: this.redact(String(error instanceof Error ? error.message : error)),
          retryable: true,
        },
      };
    }
  }

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };

    if (this.authToken) {
      headers.Authorization = `Bearer ${this.authToken}`;
    }

    return headers;
  }

  private async safeReadJson(response: Response): Promise<RawDkgV10Response> {
    try {
      return (await response.json()) as RawDkgV10Response;
    } catch {
      const text = await response.text().catch(() => "");
      return { message: text };
    }
  }

  private async safeReadQueryJson(response: Response): Promise<RawDkgV10QueryResponse> {
    try {
      return (await response.json()) as RawDkgV10QueryResponse;
    } catch {
      const text = await response.text().catch(() => "");
      return { message: text };
    }
  }

  private extractBindings(raw: RawDkgV10QueryResponse): Array<Record<string, unknown>> {
    const bindings = raw.result?.bindings ?? raw.results?.bindings ?? raw.bindings;
    if (bindings) {
      return bindings.map((binding) => Object.fromEntries(
        Object.entries(binding).map(([key, value]) => [key, this.bindingValue(value)]),
      ));
    }
    return raw.data ?? [];
  }

  private bindingValue(value: { value?: unknown } | unknown): unknown {
    if (value && typeof value === "object" && "value" in value) return (value as { value?: unknown }).value;
    return value;
  }

  private mapResponse(raw: RawDkgV10Response, fallbackContextGraphId: string, isPrivate: boolean): DkgPublishResult {
    const status = this.normalizeStatus(raw.status);
    const error = this.mapRawError(raw);
    const result: DkgPublishResult = {
      status,
      contextGraphId: raw.contextGraphId ?? fallbackContextGraphId,
      kcId: raw.kcId === undefined ? undefined : String(raw.kcId),
      txHash: raw.txHash,
      receiptUri: raw.receiptUri,
      localId: raw.localId,
      diagnostics: raw.diagnostics,
      ...(error ? { error } : {}),
    };

    if (isPrivate) {
      result.publicAnchorStatus = status;
      result.privateStorageStatus = this.mapPrivateStorageStatus(raw, status);
      result.privateLocalOnly = result.privateStorageStatus === "local";
    }

    return result;
  }

  private normalizeStatus(status: string | undefined): DkgPublishStatus {
    if (status === "confirmed" || status === "tentative" || status === "failed") {
      return status;
    }
    return "failed";
  }

  private mapPrivateStorageStatus(raw: RawDkgV10Response, status: DkgPublishStatus): DkgPrivateStorageStatus {
    if (raw.privateStorageStatus) return raw.privateStorageStatus;
    if (raw.privateStoredLocally) return "local";
    if (status === "confirmed") return "confirmed";
    if (status === "failed") return "failed";
    return "none";
  }

  private mapRawError(raw: RawDkgV10Response): DkgPublishError | undefined {
    const message = this.errorMessage(raw);
    if (!message && raw.status !== "failed") return undefined;

    if (this.isAckQuorumFailure(message, raw.diagnostics)) {
      return {
        code: "DKG_ACK_QUORUM_INSUFFICIENT",
        message: this.redact(message || "DKG ACK quorum insufficient"),
        retryable: true,
      };
    }

    if (!message) return undefined;

    return {
      code: raw.status === "failed" ? "DKG_V10_PUBLISH_FAILED" : "DKG_V10_PUBLISH_WARNING",
      message: this.redact(message),
      retryable: raw.status !== "failed",
    };
  }

  private mapError(raw: RawDkgV10Response, httpStatus: number): DkgPublishError {
    const message = this.errorMessage(raw) || `DKG V10 request failed with HTTP ${httpStatus}`;
    return {
      code: this.isAckQuorumFailure(message, raw.diagnostics)
        ? "DKG_ACK_QUORUM_INSUFFICIENT"
        : "DKG_V10_HTTP_ERROR",
      message: this.redact(message),
      retryable: httpStatus >= 500,
    };
  }

  private buildWorkerFeedbackEvidenceQuery(wallet: string, jobSpec: Record<string, unknown>): string {
    const walletLiteral = this.sparqlString(wallet.toLowerCase());
    const signalFilters = this.jobSpecSignals(jobSpec)
      .map((signal) => `CONTAINS(LCASE(STR(?searchText)), ${this.sparqlString(signal)})`)
      .join(" || ");
    const filter = signalFilters ? `FILTER(${signalFilters})` : "";

    return `
      PREFIX repnet: <http://repnet.io/schema/>
      SELECT ?feedback ?jobId ?proofURI ?satisfied ?summary ?publicJobMetadata
      WHERE {
        ?feedback a repnet:JobFeedback .
        ?feedback repnet:jobId ?jobId .
        ?feedback repnet:worker ${walletLiteral} .
        OPTIONAL { ?feedback repnet:proofURI ?proofURI . }
        OPTIONAL { ?feedback repnet:publicJobMetadata ?publicJobMetadata . }
        OPTIONAL { ?feedback repnet:contractorRating ?satisfied . }
        OPTIONAL {
          ?party repnet:role "contractor" .
          ?party repnet:aboutWallet ${walletLiteral} .
          OPTIONAL { ?party repnet:summary ?summary . }
          OPTIONAL { ?party repnet:tags ?tags . }
        }
        BIND(CONCAT(STR(?publicJobMetadata), " ", STR(?summary), " ", STR(?tags)) AS ?searchText)
        ${filter}
      }
      ORDER BY DESC(?jobId)
      LIMIT 25
    `;
  }

  private jobSpecSignals(jobSpec: Record<string, unknown>): string[] {
    const keys = ["category", "workType", "languages", "frameworks", "domains", "deliverableType"];
    const signals = keys.flatMap((key) => this.listValues(jobSpec[key]));
    return Array.from(new Set(signals.map((signal) => signal.toLowerCase()).filter(Boolean)));
  }

  private listValues(value: unknown): string[] {
    if (Array.isArray(value)) return value.map(String);
    return value ? [String(value)] : [];
  }

  private sparqlString(value: string): string {
    return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  }

  private optionalString(value: unknown): string | undefined {
    if (value === undefined || value === null || value === "") return undefined;
    return this.unwrapDkgLiteral(String(value));
  }

  private optionalBoolean(value: unknown): boolean | undefined {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value === "boolean") return value;
    const normalized = this.unwrapDkgLiteral(String(value)).toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0" || normalized === "-1") return false;
    return undefined;
  }

  private optionalJsonObject(value: unknown): Record<string, unknown> | undefined {
    if (!value) return undefined;
    if (typeof value === "object" && !Array.isArray(value)) return value as Record<string, unknown>;
    if (typeof value !== "string") return undefined;
    const normalized = this.unwrapDkgLiteral(value);
    try {
      const parsed = JSON.parse(normalized);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private unwrapDkgLiteral(value: string): string {
    const trimmed = value.trim();
    if (trimmed.startsWith('"') && trimmed.endsWith('"')) {
      try {
        return JSON.parse(trimmed);
      } catch {
        return trimmed.slice(1, -1);
      }
    }
    return trimmed;
  }

  private errorMessage(raw: RawDkgV10Response): string {
    if (typeof raw.error === "string") return raw.error;
    if (raw.error?.message) return raw.error.message;
    if (raw.message) return raw.message;
    return "";
  }

  private isAckQuorumFailure(message: string, diagnostics?: DkgPublishDiagnostics): boolean {
    return (
      message.includes("storage_ack_insufficient") ||
      message.includes("MinSignaturesRequirementNotMet") ||
      diagnostics?.finalityReason === "storage_ack_insufficient"
    );
  }

  private redact(message: string): string {
    if (!this.authToken) return message;
    return message.split(this.authToken).join("[REDACTED]");
  }
}

import { REPNET_OFFICIAL_CONTEXT_GRAPH_ID } from "./defaults";
import type {
  DkgPrivateStorageStatus,
  DkgPublishDiagnostics,
  DkgPublishError,
  DkgPublishResult,
  DkgPublishStatus,
} from "./types";

type FetchLike = (url: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface DkgMemoryConfig {
  apiUrl: string;
  authToken?: string;
  contextGraphId?: string;
  publishRoute?: string;
  queryRoute?: string;
  publisherNodeIdentityIdOverride?: string | number;
  fetch?: FetchLike;
}

export interface DkgMemoryPublishInput {
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

export type DkgReputationRole = "contractor" | "worker";

export interface DkgReputationQueryOptions {
  role?: DkgReputationRole;
  filters?: {
    skills?: string[];
    domains?: string[];
    frameworks?: string[];
    text?: string[];
  };
  since?: string;
  until?: string;
  terminalPath?: string;
  counterparty?: string;
  paymentMode?: string;
  jobType?: string;
  amountMin?: string | number;
  amountMax?: string | number;
  limit?: number;
  contextGraphId?: string;
}

export interface DkgReputationEvent {
  event?: string;
  jobId?: string;
  role?: DkgReputationRole;
  summary?: string;
  tags?: string[];
  terminalPath?: string;
  contractor?: string;
  worker?: string;
  paymentMode?: string;
  jobType?: string;
  amount?: string;
  publishedAt?: string;
  finalActionAt?: string;
  feedbackWindowClosedAt?: string;
  dkgUal?: string;
}

export interface DkgRoleReputationSummary {
  eventCount: number;
  highlights: string[];
  jobIds: string[];
}

export interface DkgReputationEvidenceResult extends DkgRoleReputationSummary {
  identityOrWallet: string;
  roles: Record<DkgReputationRole, DkgRoleReputationSummary>;
  events: DkgReputationEvent[];
}

interface RawDkgQueryResponse {
  result?: { bindings?: Array<Record<string, { value?: unknown } | unknown>> };
  results?: { bindings?: Array<Record<string, { value?: unknown } | unknown>> };
  data?: Array<Record<string, unknown>>;
  bindings?: Array<Record<string, { value?: unknown } | unknown>>;
  error?: { code?: string; message?: string; retryable?: boolean } | string;
  message?: string;
}

interface RawDkgResponse {
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

const RDF_TYPE = "http://www.w3.org/1999/02/22-rdf-syntax-ns#type";
const REPNET_NS = "https://repnet.io/ns#";

export class DkgMemoryClient {
  private readonly apiUrl: string;
  private readonly authToken?: string;
  private readonly contextGraphId?: string;
  private readonly publishRoute: string;
  private readonly queryRoute: string;
  private readonly publisherNodeIdentityIdOverride?: string;
  private readonly fetchImpl: FetchLike;

  constructor(config: DkgMemoryConfig) {
    this.apiUrl = config.apiUrl.replace(/\/$/, "");
    this.authToken = config.authToken;
    this.contextGraphId = config.contextGraphId ?? REPNET_OFFICIAL_CONTEXT_GRAPH_ID;
    this.publishRoute = config.publishRoute ?? "/api/publish-direct";
    this.queryRoute = config.queryRoute ?? "/api/query";
    this.publisherNodeIdentityIdOverride = config.publisherNodeIdentityIdOverride === undefined
      ? undefined
      : String(config.publisherNodeIdentityIdOverride);
    this.fetchImpl = config.fetch ?? fetch;
  }

  async publishPublic(input: DkgMemoryPublishInput): Promise<DkgPublishResult> {
    return this.publish(input, false);
  }

  async publishPrivate(input: DkgMemoryPublishInput): Promise<DkgPublishResult> {
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
      const message = this.errorMessage(raw as RawDkgResponse) || `DKG query failed with HTTP ${response.status}`;
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

  async queryReputationEvidence(
    identityOrWallet: string,
    opts: DkgReputationQueryOptions = {},
  ): Promise<DkgReputationEvidenceResult> {
    const sparql = this.buildReputationEvidenceQuery(identityOrWallet, opts);
    const rows = await this.query(sparql, { contextGraphId: opts.contextGraphId });
    const events = rows.map((row) => this.mapReputationEvent(row));
    return this.summarizeReputation(identityOrWallet, events);
  }

  async queryReputationJob(jobId: string, opts: { contextGraphId?: string } = {}): Promise<DkgReputationEvent[]> {
    const rows = await this.query(this.buildReputationJobQuery(jobId), { contextGraphId: opts.contextGraphId });
    return rows.map((row) => this.mapReputationEvent(row));
  }

  private async publish(input: DkgMemoryPublishInput, isPrivate: boolean): Promise<DkgPublishResult> {
    const contextGraphId = input.contextGraphId ?? this.contextGraphId ?? "";

    try {
      const response = await this.fetchImpl(`${this.apiUrl}${this.publishRoute}`, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify({
          contextGraphId,
          public: input.public,
          ...(this.publisherNodeIdentityIdOverride !== undefined
            ? { publisherNodeIdentityIdOverride: this.publisherNodeIdentityIdOverride }
            : {}),
          ...(isPrivate && input.private ? { private: input.private } : {}),
        }),
      });

      const raw = await this.safeReadJson(response);

      if (!response.ok) {
        if (!isPrivate && response.status === 404 && this.isNotFound(raw)) {
          return this.publishViaAssertionLifecycle(input, contextGraphId);
        }
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
          code: "DKG_REQUEST_FAILED",
          message: this.redact(String(error instanceof Error ? error.message : error)),
          retryable: true,
        },
      };
    }
  }


  private async publishViaAssertionLifecycle(input: DkgMemoryPublishInput, contextGraphId: string): Promise<DkgPublishResult> {
    const assertionName = this.assertionName(input.public);
    const quads = this.publicObjectToQuads(input.public, contextGraphId);
    try {
      const create = await this.fetchImpl(`${this.apiUrl}/api/assertion/create`, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify({
          contextGraphId,
          name: assertionName,
          quads,
          finalize: true,
          promote: true,
        }),
      });
      const createRaw = await this.safeReadJson(create);
      if (!create.ok) {
        return { status: "failed", contextGraphId, error: this.mapError(createRaw, create.status) };
      }

      const publish = await this.fetchImpl(`${this.apiUrl}/api/shared-memory/publish`, {
        method: "POST",
        headers: this.buildHeaders(),
        body: JSON.stringify({ contextGraphId, assertionName,
          ...(this.publisherNodeIdentityIdOverride !== undefined
            ? { publisherNodeIdentityIdOverride: this.publisherNodeIdentityIdOverride }
            : {}),
        }),
      });
      const publishRaw = await this.safeReadJson(publish);
      if (!publish.ok) {
        return { status: "failed", contextGraphId, error: this.mapError(publishRaw, publish.status) };
      }

      return this.mapResponse(publishRaw, contextGraphId, false);
    } catch (error) {
      return {
        status: "failed",
        contextGraphId,
        error: {
          code: "DKG_ASSERTION_LIFECYCLE_FAILED",
          message: this.redact(String(error instanceof Error ? error.message : error)),
          retryable: true,
        },
      };
    }
  }

  private assertionName(publicPayload: Record<string, unknown>): string {
    const explicitAssertionName = this.optionalString(publicPayload.assertionName)
      || this.optionalString(publicPayload.dkgAssertionName);
    if (explicitAssertionName) return this.slug(explicitAssertionName).startsWith("repnet-public-")
      ? this.slug(explicitAssertionName)
      : `repnet-public-${this.slug(explicitAssertionName)}`;
    const jobId = this.optionalString(publicPayload.jobId);
    if (jobId) return `repnet-public-${this.slug(jobId)}`;
    const id = this.optionalString(publicPayload["@id"]);
    if (id) return `repnet-public-${this.slug(id)}`;
    return `repnet-public-${Date.now().toString(36)}`;
  }

  private publicObjectToQuads(publicPayload: Record<string, unknown>, contextGraphId: string): Array<Record<string, string>> {
    const subject = this.optionalString(publicPayload["@id"]) || `urn:repnet:dkg:${this.assertionName(publicPayload)}`;
    const graph = `did:dkg:context-graph:${contextGraphId}`;
    const quads: Array<Record<string, string>> = [];
    const typeValue = this.optionalString(publicPayload["@type"]);
    if (typeValue) {
      quads.push({ subject, predicate: RDF_TYPE, object: this.typeIri(typeValue), graph });
    }

    for (const [key, value] of Object.entries(publicPayload)) {
      if (key === "@id" || key === "@type" || key === "@context" || key === "assertionName" || key === "dkgAssertionName") continue;
      if (value === null || value === undefined || typeof value === "object") continue;
      quads.push({ subject, predicate: `${REPNET_NS}${key}`, object: this.literal(value), graph });
    }
    return quads;
  }

  private typeIri(value: string): string {
    if (value.startsWith("repnet:")) return `${REPNET_NS}${value.slice("repnet:".length)}`;
    return value;
  }

  private literal(value: unknown): string {
    if (typeof value === "boolean") return `"${value}"^^<http://www.w3.org/2001/XMLSchema#boolean>`;
    if (typeof value === "number" && Number.isFinite(value)) return `"${value}"^^<http://www.w3.org/2001/XMLSchema#decimal>`;
    const escaped = String(value)
      .replace(/\\/g, "\\\\")
      .replace(/"/g, '\\"')
      .replace(/\n/g, "\\n")
      .replace(/\r/g, "\\r");
    return `"${escaped}"`;
  }

  private slug(value: string): string {
    return value.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || Date.now().toString(36);
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

  private async safeReadJson(response: Response): Promise<RawDkgResponse> {
    try {
      return (await response.json()) as RawDkgResponse;
    } catch {
      const text = await response.text().catch(() => "");
      return { message: text };
    }
  }

  private async safeReadQueryJson(response: Response): Promise<RawDkgQueryResponse> {
    try {
      return (await response.json()) as RawDkgQueryResponse;
    } catch {
      const text = await response.text().catch(() => "");
      return { message: text };
    }
  }

  private extractBindings(raw: RawDkgQueryResponse): Array<Record<string, unknown>> {
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

  private mapResponse(raw: RawDkgResponse, fallbackContextGraphId: string, isPrivate: boolean): DkgPublishResult {
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

  private mapPrivateStorageStatus(raw: RawDkgResponse, status: DkgPublishStatus): DkgPrivateStorageStatus {
    if (raw.privateStorageStatus) return raw.privateStorageStatus;
    if (raw.privateStoredLocally) return "local";
    if (status === "confirmed") return "confirmed";
    if (status === "failed") return "failed";
    return "none";
  }

  private mapRawError(raw: RawDkgResponse): DkgPublishError | undefined {
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
      code: raw.status === "failed" ? "DKG_PUBLISH_FAILED" : "DKG_PUBLISH_WARNING",
      message: this.redact(message),
      retryable: raw.status !== "failed",
    };
  }

  private mapError(raw: RawDkgResponse, httpStatus: number): DkgPublishError {
    const message = this.errorMessage(raw) || `DKG request failed with HTTP ${httpStatus}`;
    return {
      code: this.isAckQuorumFailure(message, raw.diagnostics)
        ? "DKG_ACK_QUORUM_INSUFFICIENT"
        : "DKG_HTTP_ERROR",
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
        OPTIONAL { ?feedback repnet:contractorSatisfied ?satisfied . }
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

  private buildReputationEvidenceQuery(identityOrWallet: string, opts: DkgReputationQueryOptions): string {
    const subjectLiteral = this.sparqlString(identityOrWallet.toLowerCase());
    const roleFilter = opts.role
      ? `FILTER(LCASE(STR(?subjectRole)) = ${this.sparqlString(opts.role)})`
      : "";
    const signalClauses = this.reputationSignals(opts.filters)
      .map((signal) => `CONTAINS(LCASE(STR(?searchText)), ${this.sparqlString(signal)})`);
    const requiredClauses: string[] = [];
    if (signalClauses.length) {
      requiredClauses.push(`(${signalClauses.join(" || ")})`);
    }
    const signalFilter = requiredClauses.length ? `FILTER(${requiredClauses.join(" && ")})` : "";
    const timeClauses = [
      opts.since ? `STR(?eventTime) >= ${this.sparqlString(opts.since)}` : undefined,
      opts.until ? `STR(?eventTime) <= ${this.sparqlString(opts.until)}` : undefined,
    ].filter((clause): clause is string => !!clause);
    const timeFilter = timeClauses.length ? `FILTER(BOUND(?eventTime) && ${timeClauses.join(" && ")})` : "";
    const exactClauses = [
      opts.terminalPath ? `LCASE(STR(?terminalPath)) = ${this.sparqlString(opts.terminalPath.toLowerCase())}` : undefined,
      opts.paymentMode ? `LCASE(STR(?paymentMode)) = ${this.sparqlString(opts.paymentMode.toLowerCase())}` : undefined,
      opts.jobType ? `LCASE(STR(?jobType)) = ${this.sparqlString(opts.jobType.toLowerCase())}` : undefined,
      opts.counterparty ? `(LCASE(STR(?contractor)) = ${this.sparqlString(opts.counterparty.toLowerCase())} || LCASE(STR(?worker)) = ${this.sparqlString(opts.counterparty.toLowerCase())})` : undefined,
    ].filter((clause): clause is string => !!clause);
    const exactFilter = exactClauses.length ? `FILTER(${exactClauses.join(" && ")})` : "";
    const amountClauses = [
      opts.amountMin !== undefined ? `xsd:decimal(STR(?amount)) >= ${this.decimalLiteral(opts.amountMin)}` : undefined,
      opts.amountMax !== undefined ? `xsd:decimal(STR(?amount)) <= ${this.decimalLiteral(opts.amountMax)}` : undefined,
    ].filter((clause): clause is string => !!clause);
    const amountFilter = amountClauses.length ? `FILTER(BOUND(?amount) && ${amountClauses.join(" && ")})` : "";
    const limit = Math.max(1, Math.min(100, Math.floor(opts.limit ?? 25)));

    return `
      PREFIX repnet: <https://repnet.io/ns#>
      PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
      SELECT ?event ?jobId ?subjectRole ?summary ?tags ?terminalPath ?contractor ?worker ?paymentMode ?jobType ?amount ?publishedAt ?finalActionAt ?feedbackWindowClosedAt ?eventTime ?dkgUal
      WHERE {
        ?event a repnet:JobReputationEvent .
        ?event repnet:subjectIdentity ?subjectIdentity .
        FILTER(LCASE(STR(?subjectIdentity)) = ${subjectLiteral})
        OPTIONAL { ?event repnet:jobId ?jobId . }
        OPTIONAL { ?event repnet:subjectRole ?subjectRole . }
        OPTIONAL { ?event repnet:feedbackSummary ?summary . }
        OPTIONAL { ?event repnet:summary ?summary . }
        OPTIONAL { ?event repnet:tags ?tags . }
        OPTIONAL { ?event repnet:terminalPath ?terminalPath . }
        OPTIONAL { ?event repnet:contractor ?contractor . }
        OPTIONAL { ?event repnet:worker ?worker . }
        OPTIONAL { ?event repnet:paymentMode ?paymentMode . }
        OPTIONAL { ?event repnet:jobType ?jobType . }
        OPTIONAL { ?event repnet:workType ?jobType . }
        OPTIONAL { ?event repnet:amount ?amount . }
        OPTIONAL { ?event repnet:publishedAt ?publishedAt . }
        OPTIONAL { ?event repnet:finalActionAt ?finalActionAt . }
        OPTIONAL { ?event repnet:feedbackWindowClosedAt ?feedbackWindowClosedAt . }
        OPTIONAL { ?event repnet:dkgUal ?dkgUal . }
        BIND(COALESCE(?publishedAt, ?finalActionAt, ?feedbackWindowClosedAt) AS ?eventTime)
        BIND(CONCAT(STR(?jobId), " ", STR(?summary), " ", STR(?tags), " ", STR(?terminalPath), " ", STR(?paymentMode), " ", STR(?jobType)) AS ?searchText)
        ${roleFilter}
        ${signalFilter}
        ${timeFilter}
        ${exactFilter}
        ${amountFilter}
      }
      ORDER BY DESC(?eventTime) DESC(?jobId)
      LIMIT ${limit}
    `;
  }

  private mapReputationEvent(row: Record<string, unknown>): DkgReputationEvent {
    const role = this.optionalString(row.subjectRole)?.toLowerCase();
    return {
      event: this.optionalString(row.event),
      jobId: this.optionalString(row.jobId),
      role: role === "contractor" || role === "worker" ? role : undefined,
      summary: this.optionalString(row.summary),
      tags: this.optionalStringList(row.tags),
      terminalPath: this.optionalString(row.terminalPath),
      contractor: this.optionalString(row.contractor),
      worker: this.optionalString(row.worker),
      paymentMode: this.optionalString(row.paymentMode),
      jobType: this.optionalString(row.jobType),
      amount: this.optionalString(row.amount),
      publishedAt: this.optionalString(row.publishedAt),
      finalActionAt: this.optionalString(row.finalActionAt),
      feedbackWindowClosedAt: this.optionalString(row.feedbackWindowClosedAt),
      dkgUal: this.optionalString(row.dkgUal),
    };
  }

  private buildReputationJobQuery(jobId: string): string {
    return `
      PREFIX repnet: <https://repnet.io/ns#>
      SELECT ?event ?jobId ?subjectRole ?summary ?tags ?terminalPath ?dkgUal
      WHERE {
        ?event a repnet:JobReputationEvent .
        ?event repnet:jobId ?jobId .
        FILTER(STR(?jobId) = ${this.sparqlString(jobId)})
        OPTIONAL { ?event repnet:subjectRole ?subjectRole . }
        OPTIONAL { ?event repnet:feedbackSummary ?summary . }
        OPTIONAL { ?event repnet:summary ?summary . }
        OPTIONAL { ?event repnet:tags ?tags . }
        OPTIONAL { ?event repnet:terminalPath ?terminalPath . }
        OPTIONAL { ?event repnet:dkgUal ?dkgUal . }
      }
      ORDER BY ?subjectRole
      LIMIT 10
    `;
  }

  private summarizeReputation(identityOrWallet: string, events: DkgReputationEvent[]): DkgReputationEvidenceResult {
    const contractor = this.summarizeRole(events.filter((event) => event.role === "contractor"));
    const worker = this.summarizeRole(events.filter((event) => event.role === "worker"));
    const overall = this.summarizeRole(events);
    return {
      identityOrWallet,
      ...overall,
      roles: { contractor, worker },
      events,
    };
  }

  private summarizeRole(events: DkgReputationEvent[]): DkgRoleReputationSummary {
    const highlights = Array.from(new Set(events.map((event) => event.summary).filter((summary): summary is string => !!summary))).slice(0, 3);
    const jobIds = Array.from(new Set(events.map((event) => event.jobId).filter((jobId): jobId is string => !!jobId)));
    return {
      eventCount: events.length,
      highlights,
      jobIds,
    };
  }

  private reputationSignals(filters: DkgReputationQueryOptions["filters"]): string[] {
    if (!filters) return [];
    return Array.from(new Set([
      ...this.listValues(filters.skills),
      ...this.listValues(filters.domains),
      ...this.listValues(filters.frameworks),
      ...this.listValues(filters.text),
    ].map((signal) => signal.toLowerCase()).filter(Boolean)));
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

  private decimalLiteral(value: string | number): string {
    const normalized = String(value);
    if (!/^-?\d+(\.\d+)?$/.test(normalized)) {
      throw new Error(`Invalid amount filter: ${normalized}`);
    }
    return normalized;
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

  private optionalNumber(value: unknown): number | undefined {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    const parsed = Number(this.unwrapDkgLiteral(String(value)));
    return Number.isFinite(parsed) ? parsed : undefined;
  }

  private optionalStringList(value: unknown): string[] | undefined {
    if (value === undefined || value === null || value === "") return undefined;
    if (Array.isArray(value)) return value.map(String).map((item) => item.trim()).filter(Boolean);
    const normalized = this.unwrapDkgLiteral(String(value));
    if (!normalized) return undefined;
    try {
      const parsed = JSON.parse(normalized);
      if (Array.isArray(parsed)) return parsed.map(String).map((item) => item.trim()).filter(Boolean);
    } catch {
      // Fall through to comma-separated tag parsing.
    }
    return normalized.split(",").map((item) => item.trim()).filter(Boolean);
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

  private errorMessage(raw: RawDkgResponse): string {
    if (typeof raw.error === "string") return raw.error;
    if (raw.error?.message) return raw.error.message;
    if (raw.message) return raw.message;
    return "";
  }

  private isNotFound(raw: RawDkgResponse): boolean {
    return this.errorMessage(raw).toLowerCase().includes("not found");
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

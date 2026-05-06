import type { RepNet } from "../client";
import {
  buildAgentProfileAsset,
  buildAgreementAsset,
  buildReceiptAsset,
  type AgreementAsset,
  type PublishAgreementDKGParams,
  type RepNetAgentProfile,
  type RepNetReceipt,
} from "../dkg/assets";
import type { DkgPublishResult } from "../dkg/types";
import {
  V10NodeDkgClient,
  type DkgV10Config,
  type DkgV10PublishInput,
  type DkgWorkerFeedbackEvidence,
} from "../dkg/v10-client";

export type DkgMode = "disabled" | "v10-node";

interface DkgV10ClientLike {
  publishPublic(input: DkgV10PublishInput): Promise<DkgPublishResult>;
  publishPrivate(input: DkgV10PublishInput): Promise<DkgPublishResult>;
  query?(sparql: string, opts?: { contextGraphId?: string; includeSharedMemory?: boolean; view?: string }): Promise<Array<Record<string, unknown>>>;
  queryWorkerFeedbackEvidence?(wallet: string, jobSpec: Record<string, unknown>): Promise<DkgWorkerFeedbackEvidence[]>;
}

export interface DKGConfig {
  /** Runtime mode. Defaults to disabled unless a DKG node/gateway is explicitly configured. */
  mode: DkgMode;
  /** DKG node/gateway client config. Used only when mode is v10-node. */
  v10?: DkgV10Config;
  /** Injectable DKG client for tests/custom runtimes. */
  v10Client?: DkgV10ClientLike;
  /** Deprecated legacy fields retained only so old config objects do not break TypeScript users. */
  endpoint?: string;
  port?: number;
  blockchain?: string;
  epochsNum?: number;
  maxNumberOfRetries?: number;
  frequency?: number;
  minimumNumberOfFinalizationConfirmations?: number;
}

export class DKGModule {
  private v10Client?: DkgV10ClientLike;
  private config: DKGConfig;

  constructor(
    private repnet: RepNet,
    config?: Partial<DKGConfig>
  ) {
    this.config = {
      mode: config?.mode || "disabled",
      v10: config?.v10,
      v10Client: config?.v10Client,
      endpoint: config?.endpoint,
      port: config?.port,
      blockchain: config?.blockchain,
      epochsNum: config?.epochsNum,
      maxNumberOfRetries: config?.maxNumberOfRetries,
      frequency: config?.frequency,
      minimumNumberOfFinalizationConfirmations: config?.minimumNumberOfFinalizationConfirmations,
    };

    if (this.config.mode === "v10-node") {
      this.v10Client = this.config.v10Client || new V10NodeDkgClient(this.config.v10 || {
        apiUrl: "http://127.0.0.1:9200",
      });
    }
  }

  getMode(): DkgMode {
    return this.config.mode;
  }

  async publishPublicV10(input: DkgV10PublishInput): Promise<DkgPublishResult> {
    if (this.config.mode === "disabled") {
      return this.disabledResult(input.contextGraphId);
    }

    if (this.config.mode !== "v10-node" || !this.v10Client) {
      return {
        status: "failed",
        contextGraphId: input.contextGraphId ?? this.config.v10?.contextGraphId ?? "",
        error: {
          code: "DKG_NODE_NOT_CONFIGURED",
          message: "DKG module is not configured for node publishing",
          retryable: false,
        },
      };
    }

    return this.v10Client.publishPublic(input);
  }

  async publishPrivateV10(input: DkgV10PublishInput): Promise<DkgPublishResult> {
    if (this.config.mode === "disabled") {
      return this.disabledResult(input.contextGraphId);
    }

    if (this.config.mode !== "v10-node" || !this.v10Client) {
      return {
        status: "failed",
        contextGraphId: input.contextGraphId ?? this.config.v10?.contextGraphId ?? "",
        error: {
          code: "DKG_NODE_NOT_CONFIGURED",
          message: "DKG module is not configured for node publishing",
          retryable: false,
        },
      };
    }

    return this.v10Client.publishPrivate(input);
  }

  async queryWorkerFeedbackEvidence(
    wallet: string,
    jobSpec: Record<string, unknown>,
  ): Promise<DkgWorkerFeedbackEvidence[]> {
    if (this.config.mode !== "v10-node" || !this.v10Client?.queryWorkerFeedbackEvidence) {
      return [];
    }

    return this.v10Client.queryWorkerFeedbackEvidence(wallet, jobSpec);
  }

  private disabledResult(contextGraphId?: string): DkgPublishResult {
    return {
      status: "failed",
      contextGraphId: contextGraphId ?? this.config.v10?.contextGraphId ?? "",
      error: {
        code: "DKG_DISABLED",
        message: "DKG publishing is disabled",
        retryable: false,
      },
    };
  }

  private requirePublishLocator(result: DkgPublishResult, label: string): string {
    const locator = result.receiptUri || result.localId || result.kcId || result.txHash;
    if (locator) return locator;

    const message = result.error?.message || `${label} completed without a receipt URI`;
    throw new Error(message);
  }

  private async query(sparql: string): Promise<Array<Record<string, unknown>>> {
    if (this.config.mode !== "v10-node" || !this.v10Client?.query) {
      return [];
    }

    return this.v10Client.query(sparql, { contextGraphId: this.config.v10?.contextGraphId });
  }

  /**
   * Legacy standalone client initialization is intentionally unsupported in public v1.
   * Configure `mode: "v10-node"` with a DKG node/gateway instead.
   */
  async connect(): Promise<void> {
    if (this.config.mode === "v10-node") return;
    throw new Error("Legacy dkg.js client mode was removed; configure DKG mode v10-node with a node/gateway API URL.");
  }

  /**
   * Check if the configured DKG node/gateway is reachable.
   */
  async isNodeAvailable(): Promise<boolean> {
    const apiUrl = this.config.v10?.apiUrl;
    if (!apiUrl) return false;

    try {
      const response = await fetch(`${apiUrl.replace(/\/$/, "")}/info`);
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Get configured DKG node/gateway info.
   */
  async getNodeInfo(): Promise<any> {
    const apiUrl = this.config.v10?.apiUrl;
    if (!apiUrl) throw new Error("DKG node/gateway API URL is not configured");

    const response = await fetch(`${apiUrl.replace(/\/$/, "")}/info`);
    return response.json();
  }

  /**
   * Publish a public Agent Profile to the configured DKG node/gateway.
   */
  async publishAgentProfile(profile: RepNetAgentProfile): Promise<string> {
    const asset = buildAgentProfileAsset(profile);
    const result = await this.publishPublicV10({
      ...asset,
      contextGraphId: this.config.v10?.contextGraphId,
    });

    return this.requirePublishLocator(result, "DKG agent profile publish");
  }

  /**
   * Build an Agent Profile asset object without publishing.
   * Useful for testing and inspection.
   */
  buildAgentProfileAsset(profile: RepNetAgentProfile) {
    return buildAgentProfileAsset(profile);
  }

  /**
   * Publish a RepNet receipt to the configured DKG node/gateway.
   */
  async publishReceipt(receipt: RepNetReceipt): Promise<string> {
    const asset = buildReceiptAsset(receipt);
    const result = await this.publishPublicV10({
      ...asset,
      contextGraphId: this.config.v10?.contextGraphId,
    });

    return this.requirePublishLocator(result, "DKG receipt publish");
  }

  /**
   * Publish feedback as a receipt after on-chain submission.
   * Convenience method that builds the receipt from on-chain data.
   */
  async publishFeedbackReceipt(params: {
    txHash: string;
    jobId: string;
    contractorWallet: string;
    workerWallet: string;
    paymentAmount: number;
    satisfied: boolean;
    category: string;
    tag?: string;
    techStack?: string[];
    deliverableType?: string;
    reviewText?: string;
    source?: RepNetReceipt["source"];
  }): Promise<string> {
    const contractorAgentId = await this.repnet.contracts.identity.walletToAgent(
      params.contractorWallet
    );
    const workerAgentId = await this.repnet.contracts.identity.walletToAgent(
      params.workerWallet
    );

    const receipt: RepNetReceipt = {
      jobId: params.jobId,
      contractorAgentId: contractorAgentId.toString(),
      workerAgentId: workerAgentId.toString(),
      contractorWallet: params.contractorWallet,
      workerWallet: params.workerWallet,
      paymentAmount: params.paymentAmount,
      feeAmount: params.paymentAmount * 0.01,
      satisfied: params.satisfied,
      tag: params.tag || "job-completed",
      category: params.category,
      source: params.source || { type: "individual" },
      techStack: params.techStack,
      deliverableType: params.deliverableType,
      reviewText: params.reviewText,
      jobCompletedAt: new Date().toISOString(),
      txHash: params.txHash,
      chainId: this.repnet.chainId,
    };

    return this.publishReceipt(receipt);
  }

  /**
   * Query the DKG for an agent's reputation receipts via SPARQL.
   */
  async queryReputation(agentWallet: string): Promise<any[]> {
    const query = `
      PREFIX repnet: <http://repnet.io/schema/>
      SELECT ?receipt ?satisfied ?paymentAmount ?category ?tag ?jobCompletedAt ?txHash ?source
      WHERE {
        ?receipt a repnet:ReputationReceipt .
        ?receipt repnet:workerWallet "${agentWallet}" .
        ?receipt repnet:satisfied ?satisfied .
        ?receipt repnet:paymentAmount ?paymentAmount .
        ?receipt repnet:category ?category .
        ?receipt repnet:tag ?tag .
        ?receipt repnet:jobCompletedAt ?jobCompletedAt .
        ?receipt repnet:txHash ?txHash .
        OPTIONAL { ?receipt repnet:source ?source . }
      }
      ORDER BY DESC(?jobCompletedAt)
    `;

    return this.query(query);
  }

  /**
   * Query receipts where this agent was the contractor.
   */
  async queryAsContractor(agentWallet: string): Promise<any[]> {
    const query = `
      PREFIX repnet: <http://repnet.io/schema/>
      SELECT ?receipt ?satisfied ?paymentAmount ?category ?workerWallet ?jobCompletedAt
      WHERE {
        ?receipt a repnet:ReputationReceipt .
        ?receipt repnet:contractorWallet "${agentWallet}" .
        ?receipt repnet:satisfied ?satisfied .
        ?receipt repnet:paymentAmount ?paymentAmount .
        ?receipt repnet:category ?category .
        ?receipt repnet:workerWallet ?workerWallet .
        ?receipt repnet:jobCompletedAt ?jobCompletedAt .
      }
      ORDER BY DESC(?jobCompletedAt)
    `;

    return this.query(query);
  }

  /**
   * Get a specific receipt by transaction hash.
   */
  async getReceiptByTx(txHash: string): Promise<any | null> {
    const query = `
      PREFIX repnet: <http://repnet.io/schema/>
      SELECT *
      WHERE {
        ?receipt a repnet:ReputationReceipt .
        ?receipt repnet:txHash "${txHash}" .
        ?receipt ?predicate ?object .
      }
    `;

    const rows = await this.query(query);
    return rows.length ? rows : null;
  }

  /**
   * Get the receipt asset content from JSON-LD format.
   * Useful for building the receipt object.
   */
  buildReceiptAsset(receipt: RepNetReceipt) {
    return buildReceiptAsset(receipt);
  }

  // ─── Agreement Methods ─────────────────────────────

  /**
   * Publish a Job Agreement to the configured DKG node/gateway.
   */
  async publishAgreement(params: PublishAgreementDKGParams): Promise<string> {
    const result = await this.publishAgreementV10(params);
    return this.requirePublishLocator(result, "DKG agreement publish");
  }

  /**
   * Publish a Job Agreement to a DKG node/gateway as a product-native Knowledge Asset.
   * Private agreements keep specs/requirements in the private assertion and publish only metadata publicly.
   */
  async publishAgreementV10(params: PublishAgreementDKGParams): Promise<DkgPublishResult> {
    const asset = buildAgreementAsset(params);
    const input = {
      ...asset,
      contextGraphId: this.config.v10?.contextGraphId,
    };

    if (params.specVisibility === "private") {
      return this.publishPrivateV10(input);
    }

    return this.publishPublicV10(input);
  }

  /**
   * Retrieve an agreement Knowledge Asset by its UAL.
   * Direct asset retrieval must be implemented by the configured DKG node/gateway API.
   */
  async getAgreement(_ual: string, _includePrivate?: boolean): Promise<any> {
    throw new Error("Direct DKG asset retrieval is not configured in the SDK node/gateway client yet.");
  }

  /**
   * Find an agreement Knowledge Asset by its agreement hash via SPARQL.
   */
  async getAgreementByHash(agreementHash: string): Promise<any | null> {
    const query = `
      PREFIX repnet: <http://repnet.io/schema/>
      SELECT ?agreement ?jobId ?contractor ?worker ?amount ?deliveryDeadline ?createdAt
      WHERE {
        ?agreement a repnet:JobAgreement .
        ?agreement repnet:agreementHash "${agreementHash}" .
        ?agreement repnet:jobId ?jobId .
        ?agreement repnet:contractor ?contractor .
        ?agreement repnet:worker ?worker .
        ?agreement repnet:amount ?amount .
        ?agreement repnet:deliveryDeadline ?deliveryDeadline .
        ?agreement repnet:createdAt ?createdAt .
      }
      LIMIT 1
    `;

    const rows = await this.query(query);
    return rows.length ? rows[0] : null;
  }

  /**
   * Build an agreement asset object without publishing.
   * Useful for testing and inspection.
   */
  buildAgreementAsset(params: PublishAgreementDKGParams): AgreementAsset {
    return buildAgreementAsset(params);
  }

  /**
   * Retrieve agreement specs from a Knowledge Asset by UAL.
   * Direct asset retrieval must be implemented by the configured DKG node/gateway API.
   */
  async getAgreementSpecs(_ual: string): Promise<{
    jobId: string;
    agreementHash: string;
    contractor: string;
    worker: string;
    amount: string;
    deliveryDeadline: number;
    createdAt: number;
    specs: Array<{ id: string; description: string; weight: number }>;
    description?: string;
    reviewPeriod?: number;
  }> {
    throw new Error("Direct DKG asset retrieval is not configured in the SDK node/gateway client yet.");
  }
}

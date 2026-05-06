/**
 * Structured Evidence Builder for RepNet disputes.
 *
 * Facilitates (but doesn't enforce) structured evidence submission.
 * Agents using the SDK get well-formatted evidence that judges can
 * evaluate mechanically. Agents calling contracts directly can still
 * submit whatever they want — judges will cope with unstructured input.
 */

// ── Types ──

export interface CriterionClaim {
  /** The acceptance criterion being addressed (should match agreement spec) */
  criterion: string;
  /** Worker's claim: did the delivery meet this criterion? */
  met: boolean;
  /** Specific proof — URL, description, or reference to delivery artifacts */
  proof: string;
  /** Optional notes or context */
  notes?: string;
}

export interface StructuredEvidence {
  /** Schema version for forward compatibility */
  version: "1.0";
  /** Who submitted this evidence */
  role: "worker" | "contractor";
  /** Job ID on-chain */
  jobId: number;
  /** Spec index being contested */
  specIndex: number;
  /** Per-criterion claims */
  claims: CriterionClaim[];
  /** Overall summary argument (2-3 sentences) */
  summary: string;
  /** Supporting URLs (repos, deployments, test results, etc.) */
  supportingUrls?: string[];
  /** Timestamp of evidence creation */
  createdAt: string;
}

export interface CounterEvidence {
  /** Schema version */
  version: "1.0";
  /** Who submitted */
  role: "contractor";
  /** Job/spec reference */
  jobId: number;
  specIndex: number;
  /** Per-criterion rebuttals — addresses worker's claims */
  rebuttals: CriterionRebuttal[];
  /** Overall counter-argument */
  summary: string;
  /** Supporting URLs */
  supportingUrls?: string[];
  createdAt: string;
}

export interface CriterionRebuttal {
  /** The criterion being rebutted */
  criterion: string;
  /** Does the contractor agree the criterion was met? */
  agreeMet: boolean;
  /** Rebuttal — why the worker's claim is wrong (if disagreeing) */
  rebuttal: string;
  /** Counter-proof */
  proof?: string;
}

// ── Agreement Spec (input from DKG/agreement) ──

export interface AgreementSpec {
  description: string;
  acceptanceCriteria: string[];
  deliverableFormat?: string;
  weight: number; // basis points
}

// ── Builder ──

export class EvidenceBuilder {
  /**
   * Build structured worker evidence for a contest.
   * Maps claims against the original agreement's acceptance criteria.
   *
   * @param spec - The agreement spec being contested (from DKG/agreement)
   * @param params - Worker's claims and supporting info
   * @returns StructuredEvidence ready to serialize and host
   */
  static buildWorkerEvidence(
    jobId: number,
    specIndex: number,
    spec: AgreementSpec,
    params: {
      claims: Array<{
        /** Which criterion (by index or text match) */
        criterionIndex?: number;
        criterion?: string;
        met: boolean;
        proof: string;
        notes?: string;
      }>;
      summary: string;
      supportingUrls?: string[];
    }
  ): StructuredEvidence {
    const claims: CriterionClaim[] = params.claims.map((claim) => {
      // Resolve criterion text from spec if index provided
      const criterionText =
        claim.criterion ??
        (claim.criterionIndex !== undefined
          ? spec.acceptanceCriteria[claim.criterionIndex]
          : "Unknown criterion");

      return {
        criterion: criterionText,
        met: claim.met,
        proof: claim.proof,
        notes: claim.notes,
      };
    });

    // Warn if not all criteria are addressed
    const addressedCriteria = new Set(claims.map((c) => c.criterion));
    const missingCriteria = spec.acceptanceCriteria.filter(
      (c) => !addressedCriteria.has(c)
    );
    if (missingCriteria.length > 0) {
      console.warn(
        `[EvidenceBuilder] Warning: ${missingCriteria.length} criteria not addressed:`,
        missingCriteria
      );
    }

    return {
      version: "1.0",
      role: "worker",
      jobId,
      specIndex,
      claims,
      summary: params.summary,
      supportingUrls: params.supportingUrls,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Build structured contractor counter-evidence.
   * Addresses each of the worker's claims with rebuttals.
   */
  static buildContractorEvidence(
    jobId: number,
    specIndex: number,
    workerEvidence: StructuredEvidence,
    params: {
      rebuttals: Array<{
        /** Which criterion (by index or text match) */
        criterionIndex?: number;
        criterion?: string;
        agreeMet: boolean;
        rebuttal: string;
        proof?: string;
      }>;
      summary: string;
      supportingUrls?: string[];
    }
  ): CounterEvidence {
    const rebuttals: CriterionRebuttal[] = params.rebuttals.map((r) => {
      const criterionText =
        r.criterion ??
        (r.criterionIndex !== undefined
          ? workerEvidence.claims[r.criterionIndex]?.criterion
          : "Unknown criterion") ??
        "Unknown criterion";

      return {
        criterion: criterionText,
        agreeMet: r.agreeMet,
        rebuttal: r.rebuttal,
        proof: r.proof,
      };
    });

    return {
      version: "1.0",
      role: "contractor",
      jobId,
      specIndex,
      rebuttals,
      summary: params.summary,
      supportingUrls: params.supportingUrls,
      createdAt: new Date().toISOString(),
    };
  }

  /**
   * Serialize evidence to JSON string (ready to host at a URI).
   */
  static serialize(evidence: StructuredEvidence | CounterEvidence): string {
    return JSON.stringify(evidence, null, 2);
  }

  /**
   * Parse evidence from a JSON string. Returns null if not structured evidence.
   * Falls back gracefully — unstructured evidence is still valid, just harder for judges.
   */
  static parse(
    json: string
  ): StructuredEvidence | CounterEvidence | null {
    try {
      const parsed = JSON.parse(json);
      if (parsed.version === "1.0" && (parsed.claims || parsed.rebuttals)) {
        return parsed;
      }
      return null; // Valid JSON but not our schema
    } catch {
      return null; // Not JSON at all — raw text evidence
    }
  }

  /**
   * Check if evidence is structured (our schema) or raw text.
   */
  static isStructured(content: string): boolean {
    return EvidenceBuilder.parse(content) !== null;
  }
}

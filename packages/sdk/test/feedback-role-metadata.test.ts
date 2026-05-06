import { describe, expect, it, vi, afterEach } from "vitest";
import { FeedbackModule } from "../src/modules/feedback";

const signer = {
  getAddress: async () => "0xContractor",
  signMessage: async (message: string) => `sig:${message}`,
};

const repnet = {
  getSigner: () => signer,
} as any;

describe("role-aware publisher feedback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("submits contractor feedback with public searchable job metadata", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ bothSubmitted: false, role: "contractor" }),
    } as Response);

    const feedback = new FeedbackModule(repnet);
    const result = await feedback.submitJobFeedback({
      jobId: 9,
      publisherUrl: "http://localhost:8787",
      reviewerRole: "contractor",
      rating: 1,
      summary: "Delivered a Python FastAPI ingestion API",
      tags: ["python", "fastapi"],
      proofURI: "base-sepolia:tx/0xpay",
      publicJobMetadata: {
        category: "software-development",
        workType: "coding",
        languages: ["python"],
        frameworks: ["fastapi"],
        domains: ["data-ingestion"],
        deliverableType: "api",
        publicJobSummary: "Built a Python FastAPI ingestion service",
      },
    });

    expect(result).toMatchObject({ success: true, bothSubmitted: false, role: "contractor" });
    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.publicJobMetadata.languages).toEqual(["python"]);
    expect(body.publicJobMetadata.frameworks).toEqual(["fastapi"]);
    expect(body.contractorFeedback).toBeUndefined();
    expect(body.proofURI).toBe("base-sepolia:tx/0xpay");
  });

  it("submits worker feedback with public contractor behavior metadata", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      json: async () => ({ bothSubmitted: true, role: "worker" }),
    } as Response);

    const feedback = new FeedbackModule(repnet);
    await feedback.submitJobFeedback({
      jobId: 9,
      publisherUrl: "http://localhost:8787",
      reviewerRole: "worker",
      rating: 1,
      summary: "Clear scope and fair review",
      proofURI: "repnet:escrow:9",
      contractorFeedback: {
        requirementsClarity: "clear",
        scopeDiscipline: "stable",
        reviewFairness: "fair",
        responsiveness: "fast",
        paymentPromptness: "prompt",
      },
    });

    const body = JSON.parse(String(fetchMock.mock.calls[0][1]?.body));
    expect(body.contractorFeedback).toEqual({
      requirementsClarity: "clear",
      scopeDiscipline: "stable",
      reviewFairness: "fair",
      responsiveness: "fast",
      paymentPromptness: "prompt",
    });
    expect(body.publicJobMetadata).toBeUndefined();
  });

  it("rejects contractor submissions without public job metadata", async () => {
    const feedback = new FeedbackModule(repnet);

    await expect(feedback.submitJobFeedback({
      jobId: 9,
      publisherUrl: "http://localhost:8787",
      reviewerRole: "contractor",
      rating: 1,
      summary: "Good work",
      proofURI: "base-sepolia:tx/0xpay",
    })).rejects.toThrow("contractor feedback requires publicJobMetadata");
  });
});

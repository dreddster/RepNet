import { describe, expect, it } from "vitest";
import {
  DKG_PRIVATE_STORAGE_STATUSES,
  DKG_PUBLISH_STATUSES,
  type DkgPrivateStorageStatus,
  type DkgPublishResult,
  type DkgPublishStatus,
} from "../src/dkg/types";

function acceptPublishStatus(status: DkgPublishStatus): DkgPublishStatus {
  return status;
}

function acceptPrivateStorageStatus(status: DkgPrivateStorageStatus): DkgPrivateStorageStatus {
  return status;
}

describe("DKG V10 result types", () => {
  it("supports explicit publish finality states", () => {
    expect(acceptPublishStatus("confirmed")).toBe("confirmed");
    expect(acceptPublishStatus("tentative")).toBe("tentative");
    expect(acceptPublishStatus("failed")).toBe("failed");
  });

  it("supports split private storage states", () => {
    expect(acceptPrivateStorageStatus("none")).toBe("none");
    expect(acceptPrivateStorageStatus("local")).toBe("local");
    expect(acceptPrivateStorageStatus("replicated")).toBe("replicated");
    expect(acceptPrivateStorageStatus("confirmed")).toBe("confirmed");
    expect(acceptPrivateStorageStatus("failed")).toBe("failed");
  });

  it("exports runtime status lists for callers that need validation", () => {
    expect(DKG_PUBLISH_STATUSES).toEqual(["confirmed", "tentative", "failed"]);
    expect(DKG_PRIVATE_STORAGE_STATUSES).toEqual([
      "none",
      "local",
      "replicated",
      "confirmed",
      "failed",
    ]);
  });

  it("models tentative ACK diagnostics without pretending finality", () => {
    const result: DkgPublishResult = {
      status: "tentative",
      contextGraphId: "0xbAf8B569786A051b237C9609d6DE685138399811/repnet-dev",
      kcId: "0",
      publicAnchorStatus: "tentative",
      privateStorageStatus: "none",
      diagnostics: {
        ackCount: 0,
        requiredAckCount: 3,
        finalityReason: "storage_ack_insufficient",
      },
      error: {
        code: "DKG_ACK_QUORUM_INSUFFICIENT",
        message: "storage_ack_insufficient: got 0/3 valid ACKs",
        retryable: true,
      },
    };

    expect(result.status).toBe("tentative");
    expect(result.diagnostics?.requiredAckCount).toBe(3);
    expect(result.error?.retryable).toBe(true);
  });
});

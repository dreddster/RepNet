import { describe, expect, it } from "vitest";
import { V10NodeDkgClient } from "../src/dkg/v10-client";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("V10NodeDkgClient", () => {
  it("maps confirmed public publish responses", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init ?? {} });
      return jsonResponse({
        status: "confirmed",
        contextGraphId: "repnet-dev",
        kcId: "12",
        txHash: "0xconfirmed",
      });
    };

    const client = new V10NodeDkgClient({
      apiUrl: "http://127.0.0.1:9200",
      authToken: "secret-token",
      contextGraphId: "repnet-dev",
      fetch: fetchMock,
    });

    const result = await client.publishPublic({ public: { "@id": "urn:test" } });

    expect(result.status).toBe("confirmed");
    expect(result.contextGraphId).toBe("repnet-dev");
    expect(result.kcId).toBe("12");
    expect(result.txHash).toBe("0xconfirmed");
    expect(calls[0].url).toBe("http://127.0.0.1:9200/api/publish-direct");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
  });

  it("maps tentative ACK quorum diagnostics without claiming confirmed finality", async () => {
    const client = new V10NodeDkgClient({
      apiUrl: "http://127.0.0.1:9200",
      contextGraphId: "repnet-dev",
      fetch: async () =>
        jsonResponse({
          status: "tentative",
          contextGraphId: "repnet-dev",
          kcId: "0",
          diagnostics: {
            ackCount: 0,
            requiredAckCount: 3,
            finalityReason: "storage_ack_insufficient",
          },
          error: {
            message: "storage_ack_insufficient: got 0/3 valid ACKs",
          },
        }),
    });

    const result = await client.publishPublic({ public: { "@id": "urn:test" } });

    expect(result.status).toBe("tentative");
    expect(result.diagnostics?.ackCount).toBe(0);
    expect(result.diagnostics?.requiredAckCount).toBe(3);
    expect(result.error?.code).toBe("DKG_ACK_QUORUM_INSUFFICIENT");
    expect(result.error?.retryable).toBe(true);
  });

  it("never leaks auth token into mapped errors", async () => {
    const client = new V10NodeDkgClient({
      apiUrl: "http://127.0.0.1:9200",
      authToken: "super-secret-token",
      contextGraphId: "repnet-dev",
      fetch: async () => jsonResponse({ message: "super-secret-token failed" }, false, 500),
    });

    const result = await client.publishPublic({ public: { "@id": "urn:test" } });

    expect(result.status).toBe("failed");
    expect(JSON.stringify(result)).not.toContain("super-secret-token");
    expect(result.error?.message).toContain("[REDACTED]");
  });

  it("maps private publish with split public anchor and private storage status", async () => {
    const client = new V10NodeDkgClient({
      apiUrl: "http://127.0.0.1:9200",
      contextGraphId: "repnet-dev",
      fetch: async () =>
        jsonResponse({
          status: "tentative",
          contextGraphId: "repnet-dev",
          kcId: "0",
          privateStoredLocally: true,
          diagnostics: { finalityReason: "private_ack_collection_skipped" },
        }),
    });

    const result = await client.publishPrivate({
      public: { "@id": "urn:private-anchor" },
      private: { "@graph": [{ "@id": "urn:private-payload" }] },
    });

    expect(result.status).toBe("tentative");
    expect(result.publicAnchorStatus).toBe("tentative");
    expect(result.privateStorageStatus).toBe("local");
    expect(result.privateLocalOnly).toBe(true);
  });

  it("queries public JobFeedback evidence through the documented V10 /api/query envelope", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new V10NodeDkgClient({
      apiUrl: "http://127.0.0.1:9200",
      authToken: "secret-token",
      contextGraphId: "repnet-dev",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return jsonResponse({
          result: {
            bindings: [
              {
                feedback: { value: "repnet:feedback:123" },
                jobId: { value: "123" },
                proofURI: { value: "repnet:escrow:123" },
                satisfied: { value: "true" },
                summary: { value: "Built a Python FastAPI DKG API" },
                publicJobMetadata: { value: JSON.stringify({
                  category: "software-development",
                  workType: "coding",
                  languages: ["python"],
                  frameworks: ["fastapi"],
                  domains: ["dkg"],
                  deliverableType: "api",
                }) },
              },
            ],
          },
        });
      },
    });

    const evidence = await client.queryWorkerFeedbackEvidence("0xWorker", {
      languages: ["python"],
      frameworks: ["fastapi"],
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe("http://127.0.0.1:9200/api/query");
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe("Bearer secret-token");
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.contextGraphId).toBe("repnet-dev");
    expect(body.sparql).toContain("repnet:JobFeedback");
    expect(body.sparql).toContain("0xworker");
    expect(body.sparql).toContain("python");
    expect(evidence).toEqual([
      {
        jobId: "123",
        proofURI: "repnet:escrow:123",
        dkgUal: "repnet:feedback:123",
        satisfied: true,
        summary: "Built a Python FastAPI DKG API",
        publicJobMetadata: {
          category: "software-development",
          workType: "coding",
          languages: ["python"],
          frameworks: ["fastapi"],
          domains: ["dkg"],
          deliverableType: "api",
        },
      },
    ]);
  });

  it("unwraps DKG RDF literal quoting when mapping public JobFeedback evidence", async () => {
    const client = new V10NodeDkgClient({
      apiUrl: "http://127.0.0.1:9200",
      contextGraphId: "repnet-dev",
      fetch: async () => jsonResponse({
        bindings: [
          {
            feedback: "urn:repnet:feedback:quoted",
            jobId: "\"synthetic-job\"",
            proofURI: "\"repnet:proof\"",
            satisfied: "\"true\"",
            summary: "\"Delivered Python FastAPI DKG API\"",
            publicJobMetadata: "\"{\\\"category\\\":\\\"software-development\\\",\\\"languages\\\":[\\\"python\\\"],\\\"frameworks\\\":[\\\"fastapi\\\"]}\"",
          },
        ],
      }),
    });

    const evidence = await client.queryWorkerFeedbackEvidence("0xWorker", { languages: ["python"] });

    expect(evidence[0]).toMatchObject({
      jobId: "synthetic-job",
      proofURI: "repnet:proof",
      dkgUal: "urn:repnet:feedback:quoted",
      satisfied: true,
      summary: "Delivered Python FastAPI DKG API",
      publicJobMetadata: {
        category: "software-development",
        languages: ["python"],
        frameworks: ["fastapi"],
      },
    });
  });
});

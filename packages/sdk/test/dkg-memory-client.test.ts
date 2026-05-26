import { describe, expect, it } from "vitest";
import { DkgMemoryClient } from "../src/dkg/memory-client";

function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

describe("DkgMemoryClient", () => {
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

    const client = new DkgMemoryClient({
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

  it("falls back to the assertion/shared-memory publish lifecycle when direct publish is absent", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body || "{}")) });
      if (String(url).endsWith("/api/publish-direct")) {
        return jsonResponse({ message: "Not found" }, false, 404);
      }
      if (String(url).endsWith("/api/assertion/create")) {
        return jsonResponse({ assertionUri: "urn:assertion:final-event", authorAddress: "0xauthor", merkleRoot: "0xmerkle" });
      }
      if (String(url).endsWith("/api/shared-memory/publish")) {
        return jsonResponse({ status: "tentative", contextGraphId: "repnet-dev", kcId: "0", diagnostics: { finalityReason: "storage_ack_insufficient" } });
      }
      return jsonResponse({ ok: true });
    };
    const client = new DkgMemoryClient({
      apiUrl: "http://127.0.0.1:9200",
      authToken: "secret-token",
      contextGraphId: "repnet-dev",
      fetch: fetchMock,
    });

    const result = await client.publishPublic({
      public: {
        "@id": "urn:repnet:job-reputation-event:1",
        "@type": "repnet:JobReputationEvent",
        jobId: "1",
        contractor: "0xcontractor",
        worker: "0xworker",
        terminalPath: "cancelled",
        contractorFeedback: { satisfaction: "not_submitted" },
      },
    });

    expect(result.status).toBe("tentative");
    expect(result.contextGraphId).toBe("repnet-dev");
    expect(calls.map((call) => call.url)).toEqual([
      "http://127.0.0.1:9200/api/publish-direct",
      "http://127.0.0.1:9200/api/assertion/create",
      "http://127.0.0.1:9200/api/shared-memory/publish",
    ]);
    expect(calls[1].body).toMatchObject({
      contextGraphId: "repnet-dev",
      name: "repnet-public-1",
      finalize: true,
      promote: true,
    });
    expect(calls[1].body.quads).toEqual(expect.arrayContaining([
      expect.objectContaining({ subject: "urn:repnet:job-reputation-event:1", predicate: "http://www.w3.org/1999/02/22-rdf-syntax-ns#type", object: "https://repnet.io/ns#JobReputationEvent" }),
      expect.objectContaining({ subject: "urn:repnet:job-reputation-event:1", predicate: "https://repnet.io/ns#jobId", object: "\"1\"" }),
      expect.objectContaining({ subject: "urn:repnet:job-reputation-event:1", predicate: "https://repnet.io/ns#terminalPath", object: "\"cancelled\"" }),
    ]));
    expect(JSON.stringify(calls)).not.toContain("secret-token");
  });

  it("uses explicit DKG assertion names for retryable same-job final-event publication", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body || "{}")) });
      if (String(url).endsWith("/api/publish-direct")) {
        return jsonResponse({ message: "Not found" }, false, 404);
      }
      if (String(url).endsWith("/api/shared-memory/publish")) {
        return jsonResponse({ status: "confirmed", contextGraphId: "repnet-dev", kcId: "42", txHash: "0xconfirmed" });
      }
      return jsonResponse({ ok: true });
    };
    const client = new DkgMemoryClient({
      apiUrl: "http://127.0.0.1:9200",
      contextGraphId: "repnet-dev",
      publisherNodeIdentityIdOverride: "0",
      fetch: fetchMock,
    });

    const result = await client.publishPublic({
      public: {
        "@id": "urn:repnet:job-reputation-event:1:retry-1",
        "@type": "repnet:JobReputationEvent",
        jobId: "1",
        dkgAssertionName: "repnet-public-base-sepolia-1-worker-123-attempt-1",
      },
    });

    expect(result.status).toBe("confirmed");
    expect(calls[1].body).toMatchObject({
      name: "repnet-public-base-sepolia-1-worker-123-attempt-1",
      finalize: true,
      promote: true,
    });
    expect(calls[1].body.quads.some((quad: any) => quad.predicate === "https://repnet.io/ns#dkgAssertionName")).toBe(false);
    expect(calls[calls.length - 1]?.body.assertionName).toBe("repnet-public-base-sepolia-1-worker-123-attempt-1");
  });

  it("passes explicit publisher identity override through finalized-assertion publish fallback", async () => {
    const calls: Array<{ url: string; body: any }> = [];
    const fetchMock = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), body: JSON.parse(String(init?.body || "{}")) });
      if (String(url).endsWith("/api/publish-direct")) {
        return jsonResponse({ message: "Not found" }, false, 404);
      }
      if (String(url).endsWith("/api/shared-memory/publish")) {
        return jsonResponse({ status: "confirmed", contextGraphId: "repnet-dev", kcId: "11", txHash: "0xconfirmed" });
      }
      return jsonResponse({ ok: true });
    };
    const client = new DkgMemoryClient({
      apiUrl: "http://127.0.0.1:9200",
      contextGraphId: "repnet-dev",
      publisherNodeIdentityIdOverride: "0",
      fetch: fetchMock,
    });

    const result = await client.publishPublic({ public: { "@id": "urn:repnet:open-job:1", "@type": "repnet:OpenJob", jobId: "1" } });

    expect(result.status).toBe("confirmed");
    expect(calls.at(-1)?.url).toBe("http://127.0.0.1:9200/api/shared-memory/publish");
    expect(calls.at(-1)?.body).toMatchObject({
      contextGraphId: "repnet-dev",
      assertionName: "repnet-public-1",
      publisherNodeIdentityIdOverride: "0",
    });
  });

  it("maps tentative ACK quorum diagnostics without claiming confirmed finality", async () => {
    const client = new DkgMemoryClient({
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
    const client = new DkgMemoryClient({
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
    const client = new DkgMemoryClient({
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

  it("queries public JobFeedback evidence through the documented DKG /api/query envelope", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new DkgMemoryClient({
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
    const client = new DkgMemoryClient({
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

  it("defaults reputation queries to the canonical RepNet DKG context graph", async () => {
    const calls: Array<{ body: any }> = [];
    const client = new DkgMemoryClient({
      apiUrl: "http://127.0.0.1:9200",
      fetch: async (_url, init) => {
        calls.push({ body: JSON.parse(String(init?.body || "{}")) });
        return jsonResponse({ bindings: [] });
      },
    });

    await client.queryReputationEvidence("0xAgent");

    expect(calls[0].body.contextGraphId).toBe("0x8fb6dcd4B3e07E610958750DbD72Ae4acdce3738/repnet-v2-official");
  });

  it("queries general wallet reputation evidence without ratings or universal scores", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const client = new DkgMemoryClient({
      apiUrl: "http://127.0.0.1:9200",
      contextGraphId: "repnet-official",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return jsonResponse({
          bindings: [
            {
              event: "urn:repnet:job-reputation-event:1",
              jobId: `"101"`,
              subjectRole: `"contractor"`,
              summary: `"Clear scope and fast review cycle."`,
              tags: `"scope,review,python"`,
              terminalPath: `"released"`,
            },
            {
              event: "urn:repnet:job-reputation-event:2",
              jobId: `"102"`,
              subjectRole: `"worker"`,
              summary: `"Delivered Python API and handled one amendment."`,
              tags: `"python,api,amendment"`,
              terminalPath: `"released"`,
            },
          ],
        });
      },
    });

    const result = await client.queryReputationEvidence("0xAgent", {
      filters: { skills: ["python"], text: ["api"] },
    });

    const body = JSON.parse(calls[0].init.body as string);
    expect(calls[0].url).toBe("http://127.0.0.1:9200/api/query");
    expect(body.contextGraphId).toBe("repnet-official");
    expect(body.sparql).toContain("JobReputationEvent");
    expect(body.sparql).not.toContain("rating");
    expect(body.sparql).toContain("0xagent");
    expect(body.sparql).toContain("python");
    expect(body.sparql).toContain("api");
    expect(body.sparql).toContain("ORDER BY DESC(?eventTime) DESC(?jobId)");
    expect(result).toEqual({
      identityOrWallet: "0xAgent",
      eventCount: 2,
      highlights: [
        "Clear scope and fast review cycle.",
        "Delivered Python API and handled one amendment.",
      ],
      jobIds: ["101", "102"],
      roles: {
        contractor: {
          eventCount: 1,
          highlights: ["Clear scope and fast review cycle."],
          jobIds: ["101"],
        },
        worker: {
          eventCount: 1,
          highlights: ["Delivered Python API and handled one amendment."],
          jobIds: ["102"],
        },
      },
      events: [
        {
          event: "urn:repnet:job-reputation-event:1",
          jobId: "101",
          role: "contractor",
          summary: "Clear scope and fast review cycle.",
          tags: ["scope", "review", "python"],
          terminalPath: "released",
        },
        {
          event: "urn:repnet:job-reputation-event:2",
          jobId: "102",
          role: "worker",
          summary: "Delivered Python API and handled one amendment.",
          tags: ["python", "api", "amendment"],
          terminalPath: "released",
        },
      ],
    });
  });

  it("matches any supplied reputation signal instead of requiring every job-spec term", async () => {
    const calls: Array<{ body: any }> = [];
    const client = new DkgMemoryClient({
      apiUrl: "http://127.0.0.1:9200",
      contextGraphId: "repnet-official",
      fetch: async (_url, init) => {
        calls.push({ body: JSON.parse(String(init?.body || "{}")) });
        return jsonResponse({ bindings: [] });
      },
    });

    await client.queryReputationEvidence("0xAgent", { filters: { skills: ["python"], text: ["api"] } });

    expect(calls[0].body.sparql).toContain('CONTAINS(LCASE(STR(?searchText)), "python") || CONTAINS(LCASE(STR(?searchText)), "api")');
  });

  it("ignores unsupported rating filters because RepNet does not use ratings", async () => {
    const calls: Array<{ body: any }> = [];
    const client = new DkgMemoryClient({
      apiUrl: "http://127.0.0.1:9200",
      contextGraphId: "repnet-official",
      fetch: async (_url, init) => {
        calls.push({ body: JSON.parse(String(init?.body || "{}")) });
        return jsonResponse({ bindings: [] });
      },
    });

    const unsupportedFilters = { skills: ["python", "api"], ["rating" + "Min"]: 4 } as any;
    await client.queryReputationEvidence("0xAgent", { filters: unsupportedFilters });

    expect(calls[0].body.sparql).toContain('FILTER((CONTAINS(LCASE(STR(?searchText)), "python") || CONTAINS(LCASE(STR(?searchText)), "api")))');
    expect(calls[0].body.sparql).not.toContain("rating");
  });

  it("narrows general reputation evidence by role", async () => {
    const calls: Array<{ body: any }> = [];
    const client = new DkgMemoryClient({
      apiUrl: "http://127.0.0.1:9200",
      contextGraphId: "repnet-official",
      fetch: async (_url, init) => {
        calls.push({ body: JSON.parse(String(init?.body || "{}")) });
        return jsonResponse({ bindings: [] });
      },
    });

    await client.queryReputationEvidence("0xAgent", { role: "worker" });

    expect(calls[0].body.sparql).toContain('FILTER(LCASE(STR(?subjectRole)) = "worker")');
  });

  it("supports last-N and timestamp-bounded reputation evidence queries", async () => {
    const calls: Array<{ body: any }> = [];
    const client = new DkgMemoryClient({
      apiUrl: "http://127.0.0.1:9200",
      contextGraphId: "repnet-official",
      fetch: async (_url, init) => {
        calls.push({ body: JSON.parse(String(init?.body || "{}")) });
        return jsonResponse({ bindings: [] });
      },
    });

    await client.queryReputationEvidence("0xAgent", {
      since: "2026-05-01T00:00:00.000Z",
      until: "2026-05-15T00:00:00.000Z",
      terminalPath: "released",
      counterparty: "0xCounterparty",
      paymentMode: "REVIEW_GATED_DELIVERY_HOLD",
      jobType: "security-assessment",
      amountMin: "100000000",
      amountMax: "500000000",
      limit: 15,
    });

    const sparql = calls[0].body.sparql;
    expect(sparql).toContain("LIMIT 15");
    expect(sparql).toContain('STR(?eventTime) >= "2026-05-01T00:00:00.000Z"');
    expect(sparql).toContain('STR(?eventTime) <= "2026-05-15T00:00:00.000Z"');
    expect(sparql).toContain("FILTER(BOUND(?eventTime)");
    expect(sparql).toContain('LCASE(STR(?terminalPath)) = "released"');
    expect(sparql).toContain('LCASE(STR(?paymentMode)) = "review_gated_delivery_hold"');
    expect(sparql).toContain('LCASE(STR(?jobType)) = "security-assessment"');
    expect(sparql).toContain('LCASE(STR(?contractor)) = "0xcounterparty"');
    expect(sparql).toContain("xsd:decimal(STR(?amount)) >= 100000000");
    expect(sparql).toContain("xsd:decimal(STR(?amount)) <= 500000000");
    expect(sparql).toContain("ORDER BY DESC(?eventTime) DESC(?jobId)");
  });

  it("queries detailed public reputation events by job id", async () => {
    const calls: Array<{ body: any }> = [];
    const client = new DkgMemoryClient({
      apiUrl: "http://127.0.0.1:9200",
      contextGraphId: "repnet-official",
      fetch: async (_url, init) => {
        calls.push({ body: JSON.parse(String(init?.body || "{}")) });
        return jsonResponse({ bindings: [
          { event: "urn:repnet:job-reputation-event:102", jobId: `"102"`, subjectRole: `"worker"`, summary: `"Delivered Python API."`, terminalPath: `"released"` },
        ] });
      },
    });

    const events = await client.queryReputationJob("102");

    expect(calls[0].body.sparql).toContain('FILTER(STR(?jobId) = "102")');
    expect(events).toEqual([
      { event: "urn:repnet:job-reputation-event:102", jobId: "102", role: "worker", summary: "Delivered Python API.", terminalPath: "released" },
    ]);
  });

});

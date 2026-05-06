import { describe, expect, it } from "vitest";
import { verifyPrivateContent } from "../src/verify";
import { calculateKnowledgeCollectionMerkleRoot } from "../src/merkle";

const validQuad = '<urn:repnet:test> <https://schema.org/name> "RepNet" .';
const secondQuad = '<urn:repnet:test> <https://schema.org/description> "Verifiable reputation" .';

// Fixtures generated from assertion-tools@8.0.6 kcTools.calculateMerkleRoot.
// They lock compatibility without forcing assertion-tools into SDK runtime deps.
const fixtures = {
  single: "0x70eaa4843b3360040f5233b9c05f5ebe2485c968d1e5390fc25d882d7ddfd639",
  multi: "0x58cbda7cd474300fea15cb694ca47cad79950c2db6ec4bc2173ce104db44ddce",
  chunked: "0x65747cdd802af9d040b4a77687f3faa7f0d7c69a525fbc993957cbce1b45a788",
};

describe("calculateKnowledgeCollectionMerkleRoot", () => {
  it("matches assertion-tools@8.0.6 for a single private quad", () => {
    expect(calculateKnowledgeCollectionMerkleRoot([validQuad])).toBe(fixtures.single);
  });

  it("matches assertion-tools@8.0.6 for multiple private quads", () => {
    expect(calculateKnowledgeCollectionMerkleRoot([validQuad, secondQuad])).toBe(fixtures.multi);
  });

  it("matches assertion-tools@8.0.6 across chunk boundaries", () => {
    expect(calculateKnowledgeCollectionMerkleRoot([`${validQuad} ${secondQuad}`])).toBe(fixtures.chunked);
  });
});

describe("verifyPrivateContent", () => {
  it("returns true when private content array matches the expected Merkle root", () => {
    expect(verifyPrivateContent([validQuad], fixtures.single)).toBe(true);
  });

  it("returns true when private content string matches the expected Merkle root", () => {
    expect(verifyPrivateContent(`\n${validQuad}\n`, fixtures.single)).toBe(true);
  });

  it("returns false instead of throwing when private content does not match the expected Merkle root", () => {
    expect(verifyPrivateContent(validQuad, "0xdeadbeef")).toBe(false);
  });

  it("returns false for empty private content", () => {
    expect(verifyPrivateContent("\n\n", "0xdeadbeef")).toBe(false);
  });

  it("ignores blank entries in private content arrays", () => {
    expect(verifyPrivateContent(["", "   ", validQuad], fixtures.single)).toBe(true);
  });

  it("preserves non-blank content bytes instead of trimming before hashing", () => {
    expect(verifyPrivateContent([` ${validQuad} `], fixtures.single)).toBe(false);
  });
});

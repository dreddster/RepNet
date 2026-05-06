import { keccak256, solidityPackedKeccak256 } from "ethers";

const DEFAULT_CHUNK_SIZE_BYTES = 32;

function splitIntoChunks(quads: string[], chunkSizeBytes = DEFAULT_CHUNK_SIZE_BYTES): string[] {
  const encoder = new TextEncoder();
  const concatenatedQuads = quads.join("\n");
  const encodedBytes = encoder.encode(concatenatedQuads);
  const chunks: string[] = [];
  let start = 0;

  while (start < encodedBytes.length) {
    const end = Math.min(start + chunkSizeBytes, encodedBytes.length);
    const chunk = encodedBytes.slice(start, end);
    chunks.push(Buffer.from(chunk).toString("utf-8"));
    start = end;
  }

  return chunks;
}

/**
 * Calculate the same Merkle root as OriginTrail assertion-tools kcTools.
 *
 * This intentionally mirrors assertion-tools@8.0.6 `calculateMerkleRoot` for
 * already-canonical N-Quads so SDK private-content verification does not need
 * the full jsonld/web3/assertion-tools dependency chain at runtime.
 */
export function calculateKnowledgeCollectionMerkleRoot(
  quads: string[],
  chunkSizeBytes = DEFAULT_CHUNK_SIZE_BYTES,
): string {
  const chunks = splitIntoChunks(quads, chunkSizeBytes);
  let leaves = chunks.map((chunk, index) =>
    Buffer.from(
      solidityPackedKeccak256(["string", "uint256"], [chunk, index]).replace("0x", ""),
      "hex",
    ),
  );

  if (leaves.length === 0) {
    throw new Error("Cannot calculate a Merkle root for empty content");
  }

  while (leaves.length > 1) {
    const nextLevel = [];

    for (let i = 0; i < leaves.length; i += 2) {
      const left = leaves[i];

      if (i + 1 >= leaves.length) {
        nextLevel.push(left);
        break;
      }

      const right = leaves[i + 1];
      const combined = [left, right].sort(Buffer.compare);
      const hash = Buffer.from(keccak256(Buffer.concat(combined)).replace("0x", ""), "hex");
      nextLevel.push(hash);
    }

    leaves = nextLevel;
  }

  return `0x${leaves[0].toString("hex")}`;
}

export function normalizePrivateContent(privateContent: string | string[]): string[] {
  const quads = Array.isArray(privateContent) ? privateContent : privateContent.split("\n");
  return quads.filter((quad) => quad.trim().length > 0);
}

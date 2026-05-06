import { calculateKnowledgeCollectionMerkleRoot, normalizePrivateContent } from "./merkle";

/**
 * Verify that private content matches the on-chain Merkle root.
 *
 * @param privateContent - The private n-quads (as returned by DKG get)
 * @param expectedMerkleRoot - The privateMerkleRoot from the public assertion
 * @returns true if content matches the on-chain root
 */
export function verifyPrivateContent(
  privateContent: string | string[],
  expectedMerkleRoot: string
): boolean {
  const quads = normalizePrivateContent(privateContent);

  if (quads.length === 0) {
    return false;
  }

  const computedRoot = calculateKnowledgeCollectionMerkleRoot(quads);
  return computedRoot.toLowerCase() === expectedMerkleRoot.toLowerCase();
}

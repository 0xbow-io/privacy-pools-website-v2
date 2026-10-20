export async function getVerifiedPoolAssociationSetLeaves(chainId: number) {
  const { createASPClient, createHashService, createMerkleService } = await import('./sdk-runtime');
  const hashService = await createHashService();
  const client = await createASPClient(chainId, createMerkleService(hashService));
  return client.getAssociationSetLeaves();
}

// Runs in the worker. Keep verification in the pinned SDK, including its
// depth limit, string comparison, registry retry and provider error handling.
import { ASPClient, MerkleService, PoseidonHashService } from '@privacy-pools-v2/sdk';
import type { Hash, IASPDataProvider } from '@privacy-pools-v2/sdk';

export type AssociationSetReads = {
  leaves: () => Promise<Hash[]>;
  root: () => Promise<Hash>;
};

let merkleService: Promise<MerkleService> | undefined;

export async function verifyAssociationSet(read: AssociationSetReads, legacy = false): Promise<Hash[]> {
  merkleService ??= PoseidonHashService.create()
    .then(hashService => new MerkleService({ hashService }))
    .catch(error => { merkleService = undefined; throw error; });
  const merkle = await merkleService;
  const unsupported = async (): Promise<never> => { throw new Error('Unsupported public association-set operation'); };
  const provider: IASPDataProvider = {
    getLeaves: read.leaves,
    getRoot: unsupported,
    getLabelStatus: unsupported,
    getASPPublicKey: unsupported,
    getEventSnapshot: unsupported,
    getNoteEvents: unsupported,
  };
  const root = legacy ? async () => merkle.computeRoot(await read.leaves()) : read.root;
  return new ASPClient({
    providers: [provider],
    merkleService: merkle,
    aspRegistryInteractor: {
      getLatestASPRoot: root,
      getLatestAssociationSetData: unsupported,
    },
  }).getAssociationSetLeaves();
}

// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Append-only release attestations published by an immutable owner multisig.
/// @dev This anchors a claim. The bundle and manifest must still be verified off-chain.
contract ReleaseAnchor {
    address public immutable owner;
    struct Release {
        bytes20 sourceCommit;
        bytes32 manifestSha256;
        string siteCid;
    }
    mapping(bytes32 versionHash => Release) private releases;
    error Unauthorized();
    error InvalidRelease();
    error AlreadyPublished();
    event ReleasePublished(bytes32 indexed versionHash, bytes20 indexed sourceCommit, bytes32 manifestSha256, string version, string siteCid);

    constructor(address owner_) {
        if (owner_ == address(0)) revert InvalidRelease();
        owner = owner_;
    }

    function publishRelease(string calldata version, bytes20 sourceCommit, bytes32 manifestSha256, string calldata siteCid) external {
        if (msg.sender != owner) revert Unauthorized();
        if (bytes(version).length == 0 || bytes(version).length > 64 || sourceCommit == bytes20(0)
            || manifestSha256 == bytes32(0) || bytes(siteCid).length == 0 || bytes(siteCid).length > 128) revert InvalidRelease();
        bytes32 versionHash = keccak256(bytes(version));
        if (releases[versionHash].manifestSha256 != bytes32(0)) revert AlreadyPublished();
        releases[versionHash] = Release(sourceCommit, manifestSha256, siteCid);
        emit ReleasePublished(versionHash, sourceCommit, manifestSha256, version, siteCid);
    }

    function getRelease(string calldata version) external view returns (Release memory) {
        return releases[keccak256(bytes(version))];
    }
}

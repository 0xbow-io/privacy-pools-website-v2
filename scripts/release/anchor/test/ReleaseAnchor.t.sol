// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;
import {ReleaseAnchor} from '../src/ReleaseAnchor.sol';

contract Outsider {
    function publish(ReleaseAnchor anchor) external {
        anchor.publishRelease('v1.5.0', bytes20(uint160(1)), bytes32(uint256(2)), 'bafy-test');
    }
}
contract ReleaseAnchorTest {
    function testOwnerCanPublishAndCannotOverwrite() external {
        ReleaseAnchor anchor = new ReleaseAnchor(address(this));
        anchor.publishRelease('v1.5.0', bytes20(uint160(1)), bytes32(uint256(2)), 'bafy-test');
        ReleaseAnchor.Release memory r = anchor.getRelease('v1.5.0');
        require(r.sourceCommit == bytes20(uint160(1)) && r.manifestSha256 == bytes32(uint256(2)));
        require(keccak256(bytes(r.siteCid)) == keccak256('bafy-test'));
        try anchor.publishRelease('v1.5.0', bytes20(uint160(3)), bytes32(uint256(4)), 'different') { revert('overwritten'); }
        catch (bytes memory reason) { require(bytes4(reason) == ReleaseAnchor.AlreadyPublished.selector); }
    }
    function testNonOwnerCannotPublish() external {
        ReleaseAnchor anchor = new ReleaseAnchor(address(this));
        try new Outsider().publish(anchor) { revert('unauthorized publication'); }
        catch (bytes memory reason) { require(bytes4(reason) == ReleaseAnchor.Unauthorized.selector); }
    }
    function testInvalidOwnerAndEmptyReleaseRejected() external {
        try new ReleaseAnchor(address(0)) { revert('zero owner'); }
        catch (bytes memory reason) { require(bytes4(reason) == ReleaseAnchor.InvalidRelease.selector); }
        ReleaseAnchor anchor = new ReleaseAnchor(address(this));
        try anchor.publishRelease('', bytes20(uint160(1)), bytes32(uint256(2)), 'cid') { revert('empty version'); }
        catch (bytes memory reason) { require(bytes4(reason) == ReleaseAnchor.InvalidRelease.selector); }
    }
}

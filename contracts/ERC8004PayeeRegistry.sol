// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/**
 * @title IERC8004PayeeRegistry
 * @notice Interface for the ERC-8004 Confirmation of Payee (CoP) Identity-to-Address Registry
 *         on QDay Aevum Testnet (Chain ID: 44005).
 */
interface IERC8004PayeeRegistry {
    function verifyPayee(address payee, bytes32 expectedIdentityHash) external view returns (bool);
    function getPayeeIdentityHash(address payee) external view returns (bytes32);
}

/**
 * @title ERC8004PayeeRegistry
 * @notice Implements on-chain Confirmation of Payee (ERC-8004) for tUSD8 stablecoin payments on QDay Aevum.
 *         Prevents address-poisoning and fat-finger transfers by binding recipient addresses to
 *         cryptographic identity hashes (`keccak256(abi.encodePacked(normalizedName))`) and metadata URIs.
 */
contract ERC8004PayeeRegistry is IERC8004PayeeRegistry {
    struct PayeeRecord {
        bytes32 identityHash;
        string displayName;
        string metadataUri;
        uint64 registeredAt;
        bool active;
    }

    mapping(address => PayeeRecord) private _payees;
    mapping(bytes32 => address) private _hashToPrimaryAddress;

    event PayeeRegistered(
        address indexed payee,
        bytes32 indexed identityHash,
        string displayName,
        string metadataUri
    );
    event PayeeRevoked(address indexed payee, bytes32 indexed identityHash);

    error EmptyDisplayName();
    error IdentityHashCollision(bytes32 identityHash, address existingOwner);
    error PayeeNotRegistered(address payee);

    /**
     * @notice Computes the canonical ERC-8004 identity hash for a merchant or payee name.
     */
    function computeIdentityHash(string calldata displayName) external pure returns (bytes32) {
        return keccak256(abi.encodePacked(displayName));
    }

    /**
     * @notice Registers or updates the caller's Confirmation of Payee record on QDay Aevum.
     */
    function registerPayee(
        string calldata displayName,
        string calldata metadataUri
    ) external returns (bytes32 identityHash) {
        if (bytes(displayName).length == 0) revert EmptyDisplayName();

        identityHash = keccak256(abi.encodePacked(displayName));
        address existing = _hashToPrimaryAddress[identityHash];
        if (existing != address(0) && existing != msg.sender) {
            revert IdentityHashCollision(identityHash, existing);
        }

        // Clear old primary mapping if updating name
        bytes32 oldHash = _payees[msg.sender].identityHash;
        if (oldHash != bytes32(0) && oldHash != identityHash) {
            delete _hashToPrimaryAddress[oldHash];
        }

        _payees[msg.sender] = PayeeRecord({
            identityHash: identityHash,
            displayName: displayName,
            metadataUri: metadataUri,
            registeredAt: uint64(block.timestamp),
            active: true
        });
        _hashToPrimaryAddress[identityHash] = msg.sender;

        emit PayeeRegistered(msg.sender, identityHash, displayName, metadataUri);
    }

    /**
     * @notice Deactivates the caller's Confirmation of Payee registration.
     */
    function revokePayee() external {
        PayeeRecord storage rec = _payees[msg.sender];
        if (!rec.active) revert PayeeNotRegistered(msg.sender);

        bytes32 oldHash = rec.identityHash;
        rec.active = false;
        delete _hashToPrimaryAddress[oldHash];

        emit PayeeRevoked(msg.sender, oldHash);
    }

    /**
     * @notice Verifies that `payee` is active and matches `expectedIdentityHash`.
     */
    function verifyPayee(
        address payee,
        bytes32 expectedIdentityHash
    ) external view override returns (bool) {
        PayeeRecord storage rec = _payees[payee];
        return rec.active && rec.identityHash == expectedIdentityHash;
    }

    /**
     * @notice Returns the registered identity hash for `payee` (or `bytes32(0)` if inactive).
     */
    function getPayeeIdentityHash(address payee) external view override returns (bytes32) {
        PayeeRecord storage rec = _payees[payee];
        return rec.active ? rec.identityHash : bytes32(0);
    }

    /**
     * @notice Returns the full PayeeRecord for `payee`.
     */
    function getPayeeRecord(address payee) external view returns (PayeeRecord memory) {
        return _payees[payee];
    }

    /**
     * @notice Resolves a registered `identityHash` to its primary payee address.
     */
    function resolvePayeeAddress(bytes32 identityHash) external view returns (address) {
        return _hashToPrimaryAddress[identityHash];
    }
}

// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title PodToken — the title to a job that passed.
/// @notice One token per job, minted to the person who paid, holding the facts nobody should be able
///         to edit afterwards: the seal the idea was posted under, the commit that was graded, the
///         hash of the receipt, the crew and their seats, and where the thing itself lives.
///
/// It is transferable on purpose. The repository follows the token: whoever holds this is who the
/// code belongs to, and a sale hands over both. The handover itself is a claim made off chain,
/// because a GitHub repository cannot be pushed to somebody who has not asked for it.
///
/// What this contract does NOT do: decide whether the work was good. It records a verdict that was
/// reached elsewhere, and it will only take it from the one address it was deployed with.
///
/// The ERC-721 here is written out rather than inherited. The repository has one dependency, and
/// adding a library to save eighty lines of a standard everybody knows is not a trade worth making.
contract PodToken {
    struct Seat {
        address agent;
        uint8 role; // the same order as PodJobs.Role
    }

    struct Pod {
        bytes32 seal; // the hash the idea was sealed under, before the job opened
        bytes32 commitHash; // the commit that was graded
        bytes32 receiptHash; // the receipt the verdict points at
        uint64 mintedAt;
        string uri; // where the job, and the thing it built, can be read
    }

    string public constant name = "Proof of Development";
    string public constant symbol = "POD";

    /// @notice the only address allowed to mint: the validator that reports verdicts.
    address public immutable minter;

    uint256 public nextTokenId = 1;

    mapping(uint256 => address) internal owners;
    mapping(address => uint256) internal balances;
    mapping(uint256 => address) internal tokenApprovals;
    mapping(address => mapping(address => bool)) internal operatorApprovals;

    mapping(uint256 => Pod) internal pods;
    mapping(uint256 => Seat[]) internal crews;
    /// @notice one token per job, so a second verdict cannot mint a second title.
    mapping(uint256 => uint256) public tokenOfJob;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);
    event Minted(uint256 indexed tokenId, uint256 indexed jobId, address indexed to, bytes32 commitHash);

    error NotMinter();
    error AlreadyMinted();
    error NoSuchToken();
    error NotOwnerOrApproved();
    error WrongOwner();
    error ToZeroAddress();
    error NotReceiver();

    constructor(address minter_) {
        if (minter_ == address(0)) revert ToZeroAddress();
        minter = minter_;
    }

    /// @notice Mint the title to a job that passed.
    /// @dev Only the validator, once per job. Everything stored here was already public before it
    ///      was minted: the seal, the commit, and a receipt anybody can fetch and check.
    function mint(
        address to,
        uint256 jobId,
        bytes32 seal,
        bytes32 commitHash,
        bytes32 receiptHash,
        Seat[] calldata seats,
        string calldata uri
    ) external returns (uint256 tokenId) {
        if (msg.sender != minter) revert NotMinter();
        if (to == address(0)) revert ToZeroAddress();
        if (tokenOfJob[jobId] != 0) revert AlreadyMinted();

        tokenId = nextTokenId++;
        tokenOfJob[jobId] = tokenId;
        pods[tokenId] = Pod({
            seal: seal,
            commitHash: commitHash,
            receiptHash: receiptHash,
            mintedAt: uint64(block.timestamp),
            uri: uri
        });
        for (uint256 i; i < seats.length; i++) crews[tokenId].push(seats[i]);

        owners[tokenId] = to;
        balances[to] += 1;

        emit Transfer(address(0), to, tokenId);
        emit Minted(tokenId, jobId, to, commitHash);
    }

    /// @notice What the token holds, which is the whole reason to keep it.
    function pod(uint256 tokenId) external view returns (Pod memory) {
        if (owners[tokenId] == address(0)) revert NoSuchToken();
        return pods[tokenId];
    }

    /// @notice The crew that built it, and the seat each one held.
    function crew(uint256 tokenId) external view returns (Seat[] memory) {
        if (owners[tokenId] == address(0)) revert NoSuchToken();
        return crews[tokenId];
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        if (owners[tokenId] == address(0)) revert NoSuchToken();
        return pods[tokenId].uri;
    }

    // --- ERC-721 ---

    function ownerOf(uint256 tokenId) public view returns (address owner) {
        owner = owners[tokenId];
        if (owner == address(0)) revert NoSuchToken();
    }

    function balanceOf(address owner) external view returns (uint256) {
        if (owner == address(0)) revert ToZeroAddress();
        return balances[owner];
    }

    function approve(address to, uint256 tokenId) external {
        address owner = ownerOf(tokenId);
        if (msg.sender != owner && !operatorApprovals[owner][msg.sender]) revert NotOwnerOrApproved();
        tokenApprovals[tokenId] = to;
        emit Approval(owner, to, tokenId);
    }

    function getApproved(uint256 tokenId) external view returns (address) {
        if (owners[tokenId] == address(0)) revert NoSuchToken();
        return tokenApprovals[tokenId];
    }

    function setApprovalForAll(address operator, bool approved) external {
        operatorApprovals[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function isApprovedForAll(address owner, address operator) external view returns (bool) {
        return operatorApprovals[owner][operator];
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        if (ownerOf(tokenId) != from) revert WrongOwner();
        if (to == address(0)) revert ToZeroAddress();
        if (
            msg.sender != from && msg.sender != tokenApprovals[tokenId]
                && !operatorApprovals[from][msg.sender]
        ) revert NotOwnerOrApproved();

        delete tokenApprovals[tokenId];
        balances[from] -= 1;
        balances[to] += 1;
        owners[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        safeTransferFrom(from, to, tokenId, "");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes memory data) public {
        transferFrom(from, to, tokenId);
        if (to.code.length > 0) {
            bytes4 answer = IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data);
            if (answer != IERC721Receiver.onERC721Received.selector) revert NotReceiver();
        }
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == 0x01ffc9a7 // ERC-165
            || interfaceId == 0x80ac58cd // ERC-721
            || interfaceId == 0x5b5e139f; // ERC-721 Metadata
    }
}

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4);
}

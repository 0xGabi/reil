// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

contract CaptureTheFlag2 {
    string public flagHolder;
    address public flagHolderAddress;

    bytes32 constant public PLEASE = keccak256(abi.encodePacked("please"));

    event FlagCaptured(string oldHolder, string newHolder, address oldHolderAddress, address newHolderAddress);

    error DidNotSayPlease(address sender);

    /**
     * @notice A demo function showing the use of arbitrary calls and the  FunctionCallAction operation.
     */
    function captureFlag(string memory newHolder) external {
        string memory oldHolder = flagHolder;
        address oldHolderAddress = flagHolderAddress;
        flagHolder = newHolder;
        flagHolderAddress = msg.sender;
        emit FlagCaptured(
            oldHolder,
            newHolder,
            oldHolderAddress,
            flagHolderAddress
        );
    }

    /**
     * @notice A demo function showing the use of Dynamic Variables and the SetVarAction operation.
     */
    function getTheModBlockNumber(string memory key) external view returns (uint256) {
        require(
            keccak256(abi.encodePacked(key)) == PLEASE,
            DidNotSayPlease(msg.sender)
        );
        return block.number % 1000;
    }
}

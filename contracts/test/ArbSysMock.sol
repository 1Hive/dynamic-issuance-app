pragma solidity ^0.4.24;

import "../ArbSys.sol";

contract ArbSysMock is ArbSys {

    address public destination;
    bytes public calldataForL1;

    function sendTxToL1(address _destination, bytes _calldataForL1) external payable returns(uint256) {
        destination = _destination;
        calldataForL1 = _calldataForL1;

        return 10;
    }

}

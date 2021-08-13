pragma solidity ^0.4.24;

interface ArbSys {
    function sendTxToL1(address destination, bytes calldataForL1) external payable returns(uint256);
}

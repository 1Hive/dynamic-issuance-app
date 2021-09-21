pragma solidity ^0.4.0;

import "@aragon/contract-helpers-test/contracts/0.4/aragonOS/TimeHelpersMock.sol";
import "../Issuance.sol";

contract MockIssuance is Issuance, TimeHelpersMock {

    function setArbSysAddress(address _arbSysAddress) external {
        arbSysAddress = _arbSysAddress;
    }

}

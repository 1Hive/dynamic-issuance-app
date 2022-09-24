pragma solidity ^0.4.0;

import "@1hive/contract-helpers-test/contracts/0.4/aragonOS/TimeHelpersMock.sol";
import "../DynamicIssuance.sol";

contract MockIssuance is DynamicIssuance, TimeHelpersMock {
}

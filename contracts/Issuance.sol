pragma solidity ^0.4.24;

import "@aragon/os/contracts/apps/AragonApp.sol";
import "@aragon/os/contracts/lib/math/SafeMath.sol";
import "@1hive/apps-token-manager/contracts/HookedTokenManager.sol";
import "@aragon/apps-vault/contracts/Vault.sol";
import "./ArbSys.sol";

contract Issuance is AragonApp {
    using SafeMath for uint256;

    bytes32 constant public UPDATE_SETTINGS_ROLE = keccak256("UPDATE_SETTINGS_ROLE");

    string constant public ERROR_TARGET_RATIO_TOO_HIGH = "ISSUANCE_TARGET_RATIO_TOO_HIGH";

    address constant public ARBSYS_ADDRESS = address(100);
    uint256 constant public EXTRA_PRECISION = 1e18;
    uint256 constant public RATIO_PRECISION = 1e10;

    HookedTokenManager public commonPoolTokenManager;
    Vault public commonPoolVault;
    MiniMeToken public commonPoolToken;
    address public l1Issuance;
    uint256 public targetRatio;
    uint256 public maxAdjustmentRatioPerSecond;
    uint256 public previousAdjustmentSecond;

    event AdjustmentMade(uint256 adjustmentAmount, bool positive);
    event TargetRatioUpdated(uint256 targetRatio);
    event MaxAdjustmentRatioPerSecondUpdated(uint256 maxAdjustmentRatioPerSecond);

    /**
    * @notice Initialise the Issuance app
    * @param _commonPoolTokenManager Token Manager managing the common pool token
    * @param _commonPoolVault Vault holding the common pools token balance
    * @param _targetRatio Fractional ratio value multiplied by RATIO_PRECISION, eg target ratio of 0.2 would be 2e9
    * @param _maxAdjustmentRatioPerSecond Eg A max adjustment ratio of 0.1 would be 0.1 / 31536000 (seconds in year) = 0.000000003170979198
        adjusted by multiplying by EXTRA_PRECISION = 3170979198
    */
    function initialize(
        HookedTokenManager _commonPoolTokenManager,
        Vault _commonPoolVault,
        address _l1Issuance,
        uint256 _targetRatio,
        uint256 _maxAdjustmentRatioPerSecond
    )
        external onlyInit
    {
        require(_targetRatio <= RATIO_PRECISION, ERROR_TARGET_RATIO_TOO_HIGH);

        commonPoolTokenManager = _commonPoolTokenManager;
        commonPoolVault = _commonPoolVault;
        commonPoolToken = _commonPoolTokenManager.token();
        l1Issuance = _l1Issuance;
        targetRatio = _targetRatio;
        maxAdjustmentRatioPerSecond = _maxAdjustmentRatioPerSecond;

        previousAdjustmentSecond = getTimestamp();

        initialized();
    }

    /**
    * @notice Update the target ratio to `_targetRatio`
    * @param _targetRatio The new target ratio
    */
    function updateTargetRatio(uint256 _targetRatio) external auth(UPDATE_SETTINGS_ROLE) {
        require(_targetRatio <= RATIO_PRECISION, ERROR_TARGET_RATIO_TOO_HIGH);
        targetRatio = _targetRatio;
        emit TargetRatioUpdated(_targetRatio);
    }

    /**
    * @notice Update the max adjustment ratio per second to `_maxAdjustmentRatioPerSecond`
    * @param _maxAdjustmentRatioPerSecond The new max adjustment ratio per second
    */
    function updateMaxAdjustmentRatioPerSecond(uint256 _maxAdjustmentRatioPerSecond) external auth(UPDATE_SETTINGS_ROLE) {
        maxAdjustmentRatioPerSecond = _maxAdjustmentRatioPerSecond;
        emit MaxAdjustmentRatioPerSecondUpdated(_maxAdjustmentRatioPerSecond);
    }

    /**
    * @notice Execute the adjustment to the total supply of the common pool token and burn or mint to the common pool vault
    */
    function executeAdjustment() external {
        uint256 commonPoolBalance = commonPoolVault.balance(commonPoolToken);
        uint256 tokenTotalSupply = commonPoolToken.totalSupply();
        uint256 targetBalance = tokenTotalSupply.mul(targetRatio).div(RATIO_PRECISION);

        // We must increase the balance amounts precision so we can divide by the
        // total supply without reaching 0 and to represent a fractional ratio
        uint256 commonPoolBalanceWithPrecision = commonPoolBalance.mul(EXTRA_PRECISION).mul(RATIO_PRECISION);
        uint256 balanceToSupplyRatio = commonPoolBalanceWithPrecision.div(tokenTotalSupply);

        // Note targetRatio is the fractional targetRatio * RATIO_PRECISION, this operation cancels out the previously applied RATIO_PRECISION
        uint256 balanceToSupplyToTargetRatio = balanceToSupplyRatio.div(targetRatio);

        if (balanceToSupplyToTargetRatio > EXTRA_PRECISION) { // balanceToTargetRatio > ratio 1 * EXTRA_PRECISION
            uint256 totalToBurn = _totalAdjustment(balanceToSupplyToTargetRatio - EXTRA_PRECISION, tokenTotalSupply);

            // If the totalToBurn makes the balance less than the targetBalance, only reduce to the targetBalance
            if (totalToBurn > commonPoolBalance || (commonPoolBalance - totalToBurn) < targetBalance) {
                totalToBurn = commonPoolBalance.sub(targetBalance);
            }

            commonPoolTokenManager.burn(commonPoolVault, totalToBurn);

            _burnTokensOnL1(totalToBurn);

            emit AdjustmentMade(totalToBurn, false);

        } else if (balanceToSupplyToTargetRatio < EXTRA_PRECISION) { // balanceToTargetRatio < ratio 1 * EXTRA_PRECISION
            uint256 totalToMint = _totalAdjustment(EXTRA_PRECISION - balanceToSupplyToTargetRatio, tokenTotalSupply);

            // If the totalToMint makes the balance more than the targetBalance, only increase to the targetBalance
            if (commonPoolBalance.add(totalToMint) > targetBalance) {
                totalToMint = targetBalance.sub(commonPoolBalance);
            }

            commonPoolTokenManager.mint(commonPoolVault, totalToMint);

            _mintTokensOnL1(totalToMint);

            emit AdjustmentMade(totalToMint, true);
        }

        previousAdjustmentSecond = getTimestamp();
    }

    function _totalAdjustment(uint256 _ratioDifference, uint256 _tokenTotalSupply) internal view returns (uint256) {
        uint256 secondsSinceLastAdjustment = getTimestamp().sub(previousAdjustmentSecond);

        uint256 adjustmentRatioPerSecond = _ratioDifference / 365 days;
        uint256 maxAdjustmentRatioPerSecondAdjusted = maxAdjustmentRatioPerSecond.mul(RATIO_PRECISION) / targetRatio;

        // Divide by EXTRA_PRECISION to cancel out initial precision increase
        return _min(adjustmentRatioPerSecond, maxAdjustmentRatioPerSecondAdjusted).mul(secondsSinceLastAdjustment).mul(_tokenTotalSupply) / EXTRA_PRECISION;
    }

    function _min(uint256 a, uint256 b) internal pure returns(uint256) {
        return a < b ? a : b;
    }

    function _burnTokensOnL1(uint256 _amount) internal {
        bytes memory data = abi.encodeWithSignature('burnHoney(uint256)', _amount);
//        ArbSys(ARBSYS_ADDRESS).sendTxToL1(l1Issuance, data);
    }

    function _mintTokensOnL1(uint256 _amount) internal {
        bytes memory data = abi.encodeWithSignature('mintHoney(uint256)', _amount);
//        ArbSys(ARBSYS_ADDRESS).sendTxToL1(l1Issuance, data);
    }
}

pragma solidity ^0.4.24;

import "@aragon/os/contracts/apps/AragonApp.sol";
import "@aragon/os/contracts/lib/math/SafeMath.sol";
import "@1hive/apps-token-manager/contracts/HookedTokenManager.sol";
import "@aragon/apps-vault/contracts/Vault.sol";


contract Issuance is AragonApp {
    using SafeMath for uint256;

    bytes32 constant public UPDATE_SETTINGS_ROLE = keccak256("UPDATE_SETTINGS_ROLE");

    string constant public ERROR_TARGET_RATIO_TOO_HIGH = "ISSUANCE_TARGET_RATIO_TOO_HIGH";
    string constant public ERROR_ALREADY_FINALISED = "ISSUANCE_ALREADY_FINALISED";

    uint256 constant public EXTRA_PRECISION = 1e18;
    uint256 constant public RATIO_PRECISION = 1e10;

    struct IssuanceRequest {
        uint256 timestamp;
        uint256 amount;
        bool isMint;
        bool finalised;
    }

    HookedTokenManager public commonPoolTokenManager;
    Vault public commonPoolVault;
    MiniMeToken public commonPoolToken;
    uint256 public targetRatio;
    uint256 public maxAdjustmentRatioPerSecond;
    IssuanceRequest[] public issuanceRequests;
    uint256 public pendingTotalSupply;
    uint256 public pendingMintAmount;
    uint256 public pendingBurnAmount;

    event IssuanceProposed(uint256 indexed requestId, uint256 adjustmentAmount, bool positive);
    event IssuanceFinalised(uint256 indexed requestId, uint256 adjustmentAmount, bool positive);
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
        uint256 _targetRatio,
        uint256 _maxAdjustmentRatioPerSecond
    )
        external onlyInit
    {
        require(_targetRatio <= RATIO_PRECISION, ERROR_TARGET_RATIO_TOO_HIGH);

        commonPoolTokenManager = _commonPoolTokenManager;
        commonPoolVault = _commonPoolVault;
        commonPoolToken = _commonPoolTokenManager.token();
        targetRatio = _targetRatio;
        maxAdjustmentRatioPerSecond = _maxAdjustmentRatioPerSecond;

        pendingTotalSupply = commonPoolToken.totalSupply();
        issuanceRequests.push(IssuanceRequest(getTimestamp(), 0, true, true));

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
    function requestIssuance() external {
        uint256 pendingCommonPoolBalance = commonPoolVault.balance(commonPoolToken).add(pendingMintAmount).sub(pendingBurnAmount);
        uint256 previousAdjustmentSecond = issuanceRequests[issuanceRequests.length - 1].timestamp;
        (uint256 issuanceAmount, bool isMint) =
            _getIssuanceAmount(pendingCommonPoolBalance, pendingTotalSupply, previousAdjustmentSecond);

        pendingTotalSupply = isMint ? pendingTotalSupply.add(issuanceAmount) : pendingTotalSupply.sub(issuanceAmount);
        if (isMint) {
            pendingMintAmount += issuanceAmount;
        } else {
            pendingBurnAmount += issuanceAmount;
        }

        uint256 issuanceRequestId = issuanceRequests.length;
        issuanceRequests.push(IssuanceRequest(getTimestamp(), issuanceAmount, isMint, false));

        _updateTokenOnL1(issuanceAmount, isMint);

        emit IssuanceProposed(issuanceRequestId, issuanceAmount, isMint);
    }

    function finaliseIssuance(uint256 _issuanceRequestId) external {
        // TODO: require(sender is arbitrum bridge and function caller is equivelant mainnet contract)
        IssuanceRequest storage issuanceRequest = issuanceRequests[_issuanceRequestId];
        require(!issuanceRequest.finalised, ERROR_ALREADY_FINALISED);

        issuanceRequest.finalised = true;

        if (issuanceRequest.isMint) {
            commonPoolTokenManager.mint(commonPoolVault, issuanceRequest.amount);
            pendingMintAmount -= issuanceRequest.amount;
        } else {
            commonPoolTokenManager.burn(commonPoolVault, issuanceRequest.amount);
            pendingBurnAmount -= issuanceRequest.amount;
        }

        emit IssuanceFinalised(_issuanceRequestId, issuanceRequest.amount, issuanceRequest.isMint);
    }

    function _getIssuanceAmount(uint256 _pendingCommonPoolBalance, uint256 _pendingTotalSupply, uint256 _previousAdjustmentSecond) internal view returns (uint256 amount, bool isMint) {
        uint256 targetBalance = _pendingTotalSupply.mul(targetRatio).div(RATIO_PRECISION);

        // We must increase the balance amounts precision so we can divide by the
        // total supply without reaching 0 and to represent a fractional ratio
        uint256 commonPoolBalanceWithPrecision = _pendingCommonPoolBalance.mul(EXTRA_PRECISION).mul(RATIO_PRECISION);
        uint256 balanceToSupplyRatio = commonPoolBalanceWithPrecision.div(_pendingTotalSupply);

        // Note targetRatio is the fractional targetRatio * RATIO_PRECISION, this operation cancels out the previously applied RATIO_PRECISION
        uint256 balanceToSupplyToTargetRatio = balanceToSupplyRatio.div(targetRatio);

        if (balanceToSupplyToTargetRatio > EXTRA_PRECISION) { // balanceToTargetRatio > ratio 1 * EXTRA_PRECISION
            uint256 totalToBurn =
                _totalAdjustment(balanceToSupplyToTargetRatio - EXTRA_PRECISION, _pendingTotalSupply, _previousAdjustmentSecond);

            // If the totalToBurn makes the balance less than the targetBalance, only reduce to the targetBalance
            if (totalToBurn > _pendingCommonPoolBalance || (_pendingCommonPoolBalance - totalToBurn) < targetBalance) {
                totalToBurn = _pendingCommonPoolBalance.sub(targetBalance);
            }

            return (totalToBurn, false);
        } else if (balanceToSupplyToTargetRatio < EXTRA_PRECISION) { // balanceToTargetRatio < ratio 1 * EXTRA_PRECISION
            uint256 totalToMint =
                _totalAdjustment(EXTRA_PRECISION - balanceToSupplyToTargetRatio, _pendingTotalSupply, _previousAdjustmentSecond);

            // If the totalToMint makes the balance more than the targetBalance, only increase to the targetBalance
            if (_pendingCommonPoolBalance.add(totalToMint) > targetBalance) {
                totalToMint = targetBalance.sub(_pendingCommonPoolBalance);
            }

            return (totalToBurn, true);
        } else {
            return (0, true);
        }
    }

    function _totalAdjustment(uint256 _ratioDifference, uint256 _tokenTotalSupply, uint256 _previousAdjustmentSecond) internal view returns (uint256) {
        uint256 secondsSinceLastAdjustment = getTimestamp().sub(_previousAdjustmentSecond);

        uint256 adjustmentRatioPerSecond = _ratioDifference / 365 days;
        uint256 maxAdjustmentRatioPerSecondAdjusted = maxAdjustmentRatioPerSecond.mul(RATIO_PRECISION) / targetRatio;

        // Divide by EXTRA_PRECISION to cancel out initial precision increase
        return _min(adjustmentRatioPerSecond, maxAdjustmentRatioPerSecondAdjusted).mul(secondsSinceLastAdjustment).mul(_tokenTotalSupply) / EXTRA_PRECISION;
    }

    function _min(uint256 a, uint256 b) internal pure returns(uint256) {
        return a < b ? a : b;
    }

    function _updateTokenOnL1(uint256 _amount, bool _isMint) internal {
        // TODO: Send tokens if burning
    }
}

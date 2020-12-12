pragma solidity ^0.4.24;

import "@aragon/os/contracts/apps/AragonApp.sol";
import "@aragon/os/contracts/lib/math/SafeMath.sol";
import "@aragon/os/contracts/lib/token/ERC20.sol";
import "@1hive/apps-token-manager/contracts/HookedTokenManager.sol";
import "@aragon/apps-vault/contracts/Vault.sol";


contract Issuance is AragonApp {
    using SafeMath for uint256;

    bytes32 constant public UPDATE_SETTINGS_ROLE = keccak256("UPDATE_SETTINGS_ROLE");

    uint256 constant public TOKEN_PRECISION = 1e18;
    uint256 constant public RATIO_PRECISION = 1e10;

    HookedTokenManager public commonPoolTokenManager;
    Vault public commonPoolVault;
    ERC20 public commonPoolToken;
    uint256 public targetRatio;
    uint256 public maxAdjustmentPerSecond;
    uint256 public previousAdjustmentSecond;

    event AdjustmentMade(uint256 adjustmentAmount, bool positive);
    event SettingsUpdated(uint256 targetRatio, uint256 maxAdjustmentPerSecond);

    /**
    * @param _targetRatio Fractional ratio value multiplied by no adjustment ratio, eg target ratio of 0.2 would be 2e17
    */
    function initialize(
        HookedTokenManager _commonPoolTokenManager,
        Vault _commonPoolVault,
        ERC20 _commonPoolToken,
        uint256 _targetRatio,
        uint256 _maxAdjustmentPerSecond
    )
        external onlyInit
    {
        commonPoolTokenManager = _commonPoolTokenManager;
        commonPoolVault = _commonPoolVault;
        commonPoolToken = _commonPoolToken;
        targetRatio = _targetRatio;
        maxAdjustmentPerSecond = _maxAdjustmentPerSecond;

        previousAdjustmentSecond = getTimestamp();

        initialized();
    }

    function updateSettings(uint256 _targetRatio, uint256 _maxAdjustmentPerSecond) external {
        targetRatio = _targetRatio;
        maxAdjustmentPerSecond = _maxAdjustmentPerSecond;
        SettingsUpdated(_targetRatio, _maxAdjustmentPerSecond);
    }

    event DEBUG(uint256 a, uint256 b, uint256 c);

    function executeAdjustment() external {
        uint256 commonPoolBalance = commonPoolVault.balance(commonPoolToken);
        uint256 tokenTotalSupply = commonPoolToken.totalSupply();
        uint256 targetBalance = tokenTotalSupply.mul(targetRatio).div(RATIO_PRECISION);

        uint256 commonPoolBalanceWithPrecision = commonPoolBalance.mul(TOKEN_PRECISION).mul(RATIO_PRECISION);
        uint256 balanceToSupplyRatio = commonPoolBalanceWithPrecision.div(tokenTotalSupply);

        // Note targetRatio is fractional targetRatio * RATIO_PRECISION, this operation cancels out the previously applied RATIO_PRECISION
        uint256 balanceToTargetRatio = balanceToSupplyRatio.div(targetRatio);

        if (balanceToTargetRatio > TOKEN_PRECISION) { // balanceToTargetRatio > ratio 1 * TOKEN_PRECISION
            uint256 totalToBurn = _totalAdjustment(balanceToTargetRatio - TOKEN_PRECISION, tokenTotalSupply);
            // If the totalToBurn makes the balance less than the target, only reduce to the target value
            if (totalToBurn > commonPoolBalance || commonPoolBalance.sub(totalToBurn) < targetBalance) {
                totalToBurn = commonPoolBalance.sub(targetBalance);
            }
            commonPoolTokenManager.burn(commonPoolVault, totalToBurn);

            emit DEBUG(totalToBurn, totalToBurn, totalToBurn);

            emit AdjustmentMade(totalToBurn, false);

        } else if (balanceToTargetRatio < TOKEN_PRECISION) { // balanceToTargetRatio < ratio 1 * TOKEN_PRECISION
            uint256 totalToMint = _totalAdjustment(TOKEN_PRECISION - balanceToTargetRatio, tokenTotalSupply);
            // If the totalToMint makes the balance more than the target, only increase to the target value
            if (commonPoolBalance.add(totalToMint) > targetBalance) {
                totalToMint = targetBalance.sub(commonPoolBalance);
            }
            commonPoolTokenManager.mint(commonPoolVault, totalToMint);

            emit DEBUG(totalToMint, totalToMint, totalToMint);

            emit AdjustmentMade(totalToMint, true);
        }

        previousAdjustmentSecond = getTimestamp();
    }

    function _totalAdjustment(uint256 _ratioDifference, uint256 _tokenTotalSupply) internal returns (uint256) {
        uint256 secondsSinceLastAdjustment = getTimestamp().sub(previousAdjustmentSecond);

        uint256 adjustmentPerSecond = _ratioDifference / 365 days;
        return _min(adjustmentPerSecond, maxAdjustmentPerSecond).mul(secondsSinceLastAdjustment).mul(_tokenTotalSupply) / TOKEN_PRECISION;
    }

    function _min(uint256 a, uint256 b) internal returns(uint256) {
        return a < b ? a : b;
    }
}

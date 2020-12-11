pragma solidity ^0.4.24;

import "@aragon/os/contracts/apps/AragonApp.sol";
import "@aragon/os/contracts/lib/math/SafeMath.sol";
import "@aragon/os/contracts/lib/token/ERC20.sol";
import "@1hive/apps-token-manager/contracts/HookedTokenManager.sol";
import "@aragon/apps-vault/contracts/Vault.sol";


contract Issuance is AragonApp {
    using SafeMath for uint256;

    bytes32 constant public UPDATE_SETTINGS_ROLE = keccak256("UPDATE_SETTINGS_ROLE");

    uint256 public constant PRECISION_MULTIPLIER = 1e18;
    uint256 public constant NO_ADJUSTMENT_RATIO = 1e18;

    HookedTokenManager public commonPoolTokenManager;
    Vault public commonPoolVault;
    ERC20 public commonPoolToken;
    uint256 public targetRatio;
    uint256 public maxAdjustmentPerSecond;
    uint256 public previousAdjustmentSecond;

    event AdjustmentMade(uint256 adjustmentAmount, bool positive);

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
        public onlyInit
    {
        commonPoolTokenManager = _commonPoolTokenManager;
        commonPoolVault = _commonPoolVault;
        commonPoolToken = _commonPoolToken;
        targetRatio = _targetRatio;
        maxAdjustmentPerSecond = _maxAdjustmentPerSecond;

        previousAdjustmentSecond = now;

        initialized();
    }

    function executeAdjustment() external {
        uint256 commonPoolBalance = commonPoolVault.balance(commonPoolToken);
        uint256 tokenTotalSupply = commonPoolToken.totalSupply();

        uint256 balanceToSupplyRatio = (commonPoolBalance.mul(PRECISION_MULTIPLIER).mul(NO_ADJUSTMENT_RATIO)).div(tokenTotalSupply);
        uint256 balanceToTargetRatio = (balanceToSupplyRatio.div(targetRatio));

        if (balanceToTargetRatio > NO_ADJUSTMENT_RATIO) {
            uint256 totalToBurn = _totalAdjustment(balanceToTargetRatio - NO_ADJUSTMENT_RATIO, tokenTotalSupply);
            commonPoolTokenManager.burn(commonPoolVault, totalToBurn);

            emit AdjustmentMade(totalToBurn, false);

        } else if (balanceToTargetRatio < NO_ADJUSTMENT_RATIO) {
            uint256 totalToMint = _totalAdjustment(NO_ADJUSTMENT_RATIO - balanceToTargetRatio, tokenTotalSupply);
            commonPoolTokenManager.mint(commonPoolVault, totalToMint);

            emit AdjustmentMade(totalToMint, true);
        }

        previousAdjustmentSecond = now;
    }

    function _totalAdjustment(uint256 _ratioDifference, uint256 _tokenTotalSupply) internal returns (uint256) {
        uint256 secondsSinceLastAdjustment = now.sub(previousAdjustmentSecond);

        uint256 adjustmentPerSecond = (_ratioDifference.mul(_tokenTotalSupply)) / 365 days / PRECISION_MULTIPLIER;
        return _min(adjustmentPerSecond, maxAdjustmentPerSecond).mul(secondsSinceLastAdjustment).mul(_tokenTotalSupply);
    }

    function _min(uint256 a, uint256 b) internal returns(uint256) {
        return a < b ? a : b;
    }
}

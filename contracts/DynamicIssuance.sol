pragma solidity ^0.4.24;

import "@aragon/os/contracts/apps/AragonApp.sol";
import "@aragon/os/contracts/lib/math/SafeMath.sol";
import "@1hive/apps-token-manager/contracts/HookedTokenManager.sol";
import "@1hive/funds-manager/contracts/FundsManager.sol";


contract DynamicIssuance is AragonApp {
    using SafeMath for uint256;

    bytes32 constant public UPDATE_SETTINGS_ROLE = keccak256("UPDATE_SETTINGS_ROLE");

    string constant public ERROR_TARGET_RATIO_TOO_HIGH = "ISSUANCE_TARGET_RATIO_TOO_HIGH";
    string constant public ERROR_CURRENT_RATIO_TOO_HIGH = "ISSUANCE_CURRENT_RATIO_TOO_HIGH";
    string constant public ERROR_RECOVERY_TIME_CAN_NOT_BE_ZERO = "ISSUANCE_RECOVERY_TIME_CAN_NOT_BE_ZERO";

    uint256 constant public RATIO_PRECISION = 1e18;

    HookedTokenManager public commonPoolTokenManager;
    FundsManager public commonPoolFundsManager;
    MiniMeToken public commonPoolToken;
    uint256 public targetRatio;
    uint256 public recoveryTime;
    uint256 public previousAdjustmentSecond;

    event AdjustmentMade(uint256 adjustmentAmount, bool positive);
    event TargetRatioUpdated(uint256 targetRatio);
    event FundsManagerUpdated(FundsManager fundsManager);
    event RecoveryTimeUpdated(uint256 recoveryTime);

    /**
    * @notice Initialise the Dynamic Issuance app
    * @param _commonPoolTokenManager Token Manager managing the common pool token
    * @param _commonPoolFundsManager Funds manager managing common pools token balance
    * @param _targetRatio Fractional ratio value multiplied by RATIO_PRECISION, eg target ratio of 0.2 would be 2e9
    * @param _recoveryTime Seconds it will cost to go from a ratio of 0% or 100% to the target ratio
    */
    function initialize(
        HookedTokenManager _commonPoolTokenManager,
        FundsManager _commonPoolFundsManager,
        uint256 _targetRatio,
        uint256 _recoveryTime
    )
        external onlyInit
    {
        require(_targetRatio < RATIO_PRECISION, ERROR_TARGET_RATIO_TOO_HIGH);
        require(_recoveryTime > 0, ERROR_RECOVERY_TIME_CAN_NOT_BE_ZERO);

        commonPoolTokenManager = _commonPoolTokenManager;
        commonPoolFundsManager = _commonPoolFundsManager;
        commonPoolToken = _commonPoolTokenManager.token();
        targetRatio = _targetRatio;
        recoveryTime = _recoveryTime;

        previousAdjustmentSecond = getTimestamp();

        initialized();
    }

    /**
    * @notice Update the funds manager
    * @param _commonPoolFundsManager The new funds manager
    */
    function updateFundsManager(FundsManager _commonPoolFundsManager) external auth(UPDATE_SETTINGS_ROLE) {
        commonPoolFundsManager = _commonPoolFundsManager;
        emit FundsManagerUpdated(_commonPoolFundsManager);
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
    * @notice Update the recovery time to `_recoveryTime`
    * @param _recoveryTime The new recovery time
    */
    function updateRecoveryTime(uint64 _recoveryTime) external auth(UPDATE_SETTINGS_ROLE) {
        require(_recoveryTime > 0, ERROR_RECOVERY_TIME_CAN_NOT_BE_ZERO);
        recoveryTime = _recoveryTime;
        emit RecoveryTimeUpdated(_recoveryTime);
    }

    /**
    * @notice Execute the adjustment to the total supply of the common pool token and burn or mint to the common pool vault
    */
    function executeAdjustment() external {
        uint256 commonPoolBalance = commonPoolFundsManager.balance(commonPoolToken);
        uint256 tokenTotalSupply = commonPoolToken.totalSupply();
        uint256 currentRatio = commonPoolBalance.mul(RATIO_PRECISION).div(tokenTotalSupply);
        uint ratio = calculateRatio(currentRatio, getTimestamp().sub(previousAdjustmentSecond));
        if (currentRatio > ratio) {
            // (commonPoolBalance - ratio * tokenTotalSupply) / (1 - ratio)
            uint256 totalToBurn = commonPoolBalance.mul(RATIO_PRECISION).sub(ratio.mul(tokenTotalSupply)).div(RATIO_PRECISION.sub(ratio));
            if (totalToBurn > 0) {
                commonPoolTokenManager.burn(commonPoolFundsManager.fundsOwner(), totalToBurn);
                emit AdjustmentMade(totalToBurn, false);
            }
        } else if (currentRatio < ratio) {
            // (ratio * tokenTotalSupply - commonPoolBalance) / (1 - ratio)
            uint256 totalToMint = ratio.mul(tokenTotalSupply).sub(commonPoolBalance.mul(RATIO_PRECISION)).div(RATIO_PRECISION.sub(ratio));
            if (totalToMint > 0) {
                commonPoolTokenManager.mint(commonPoolFundsManager.fundsOwner(), totalToMint);
                emit AdjustmentMade(totalToMint, true);
            }
        }
        previousAdjustmentSecond = getTimestamp();
    }

    function calculateRatio(uint256 _currentRatio, uint256 _time) public view returns (uint256) {
        require(_currentRatio < RATIO_PRECISION, ERROR_CURRENT_RATIO_TOO_HIGH);
        uint256 shared;
        if (_currentRatio < targetRatio) {
            // recoveryTime * sqrt(targetRatio * (targetRatio - _currentRatio))
            shared = recoveryTime.mul(_sqrt(targetRatio.mul(targetRatio.sub(_currentRatio))));
            if (_time < shared.div(targetRatio)) {
                // (_currentRatio * recoveryTime ** 2 + 2 * _time * shared - targetRatio * _time ** 2) / (recoveryTime ** 2)
                return _currentRatio.mul(recoveryTime.mul(recoveryTime)).add(_time.mul(shared).mul(2)).sub(targetRatio.mul(_time.mul(_time))).div(recoveryTime.mul(recoveryTime));
            }
        } else if (_currentRatio > targetRatio) {
            // recoveryTime * sqrt((1 - targetRatio) * (_currentRatio - targetRatio))
            shared = recoveryTime.mul(_sqrt(RATIO_PRECISION.sub(targetRatio).mul(_currentRatio.sub(targetRatio))));
            if (_time < shared.div(RATIO_PRECISION.sub(targetRatio))) {
                // (_currentRatio * recoveryTime ** 2 + (1 - targetRatio) * _time ** 2 - 2 * _time * shared) / (recoveryTime ** 2)
                return _currentRatio.mul(recoveryTime).mul(recoveryTime).add(RATIO_PRECISION.sub(targetRatio).mul(_time).mul(_time)).sub(_time.mul(shared).mul(2)).div(recoveryTime.mul(recoveryTime));
            }
        }
        return targetRatio;
    }

    function _sqrt(uint256 y) internal pure returns (uint256 z) {
        if (y > 3) {
            z = y;
            uint256 x = y / 2 + 1;
            while (x < z) {
                z = x;
                x = (y / x + x) / 2;
            }
        } else if (y != 0) {
            z = 1;
        }
    }
}

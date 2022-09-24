const {
  ZERO_ADDRESS,
  bn, bigExp,
  ONE_DAY, 
  injectWeb3,
  injectArtifacts
} = require('@1hive/contract-helpers-test')
const { assertBn, assertRevert } = require('@1hive/contract-helpers-test/src/asserts')
const { ANY_ENTITY, newDao, installNewApp } = require('@1hive/contract-helpers-test/src/aragon-os')
const { hash: namehash } = require('eth-ens-namehash')
const { fromDecimals, toDecimals } = require('./helpers/math-utils');

const Issuance = artifacts.require('MockIssuance.sol')
const TokenManager = artifacts.require('HookedTokenManager.sol')
const Vault = artifacts.require('Vault.sol')
const MiniMeToken = artifacts.require('MiniMeToken.sol')
const AragonVaultFundsManager = artifacts.require('AragonVaultFundsManager.sol')

injectWeb3(web3)
injectArtifacts(artifacts)

contract('Dynamic Issuance', ([appManager, newFundsManager]) => {

  let dao, acl
  let tokenManagerBase, tokenManager, vaultBase, vault, issuanceBase, issuance, commonPoolToken, aragonVaultFundsManager

  const ANY_ADDRESS = '0xffffffffffffffffffffffffffffffffffffffff'
  const RATIO_PRECISION = bigExp(1, 18);
  const TOTAL_SUPPLY = bigExp(100, 18)
  const SECONDS_IN_YEAR = bn('31536000')

  const TOKEN_MANAGER_APP_ID = namehash('token-manager')
  const ISSUANCE_APP_ID = namehash('issuance')
  const VAULT_APP_ID = namehash('vault')

  const INITIAL_TARGET_RATIO = bigExp(2, 17) // 0.2 (20% of total supply)
  const INITIAL_RECOVERY_TIME = SECONDS_IN_YEAR

  const calculateAdjustment = (commonPoolBalance, tokenTotalSupply, targetRatio, recoveryTime, time) => {
    const currentRatio = commonPoolBalance / tokenTotalSupply
    if (currentRatio > targetRatio) {
      // burn
      const shared = recoveryTime * Math.sqrt((1 - targetRatio) * (currentRatio - targetRatio))
      const ratio = (currentRatio * recoveryTime ** 2 + (1 - targetRatio) * time ** 2 - 2 * time * shared) / (recoveryTime ** 2)
      return (commonPoolBalance - ratio * tokenTotalSupply) / (1 - ratio)
    } else {
      // mint
      const shared = recoveryTime * Math.sqrt(targetRatio * (targetRatio - currentRatio))
      const ratio = (currentRatio * recoveryTime ** 2 + 2 * time * shared - targetRatio * time ** 2) / (recoveryTime ** 2)
      return (ratio * tokenTotalSupply - commonPoolBalance) / (1 - ratio)
    }
  }

  const calculateAdjustmentBN = (commonPoolBalanceBN, tokenTotalSupplyBN, targetRatioBN, recoveryTimeBN, time) => {
    const commonPoolBalance = parseFloat(fromDecimals(String(commonPoolBalanceBN), 18))
    const tokenTotalSupply = parseFloat(fromDecimals(String(tokenTotalSupplyBN), 18))
    const targetRatio = parseFloat(fromDecimals(String(targetRatioBN), 18))
    return bn(toDecimals(String(calculateAdjustment(commonPoolBalance, tokenTotalSupply, targetRatio, recoveryTimeBN.toNumber(), time)), 18))
  }

  before('deploy bases', async () => {
    tokenManagerBase = await TokenManager.new()
    vaultBase = await Vault.new()
    issuanceBase = await Issuance.new()
  })

  beforeEach(async () => {
    ({ dao, acl } = await newDao(appManager))

    const issuanceAddress = await installNewApp(dao, ISSUANCE_APP_ID, issuanceBase.address, appManager)
    issuance = await Issuance.at(issuanceAddress)
    await acl.createPermission(ANY_ENTITY, issuance.address, await issuance.UPDATE_SETTINGS_ROLE(), appManager)

    commonPoolToken = await MiniMeToken.new(ZERO_ADDRESS, ZERO_ADDRESS, 0, 'Honey', 18, 'HNY', true)

    const tokenManagerAddress = await installNewApp(dao, TOKEN_MANAGER_APP_ID, tokenManagerBase.address, appManager)
    tokenManager = await TokenManager.at(tokenManagerAddress)
    await commonPoolToken.changeController(tokenManagerAddress)
    await acl.createPermission(ANY_ENTITY, tokenManager.address, await tokenManager.INIT_ROLE(), appManager)
    await acl.createPermission(ANY_ENTITY, tokenManager.address, await tokenManager.MINT_ROLE(), appManager)
    await acl.createPermission(ANY_ENTITY, tokenManager.address, await tokenManager.BURN_ROLE(), appManager)
    await tokenManager.initialize(commonPoolToken.address, true, 0)

    const vaultAddress = await installNewApp(dao, VAULT_APP_ID, vaultBase.address, appManager)
    vault = await Vault.at(vaultAddress)
    await vault.initialize()
    aragonVaultFundsManager = await AragonVaultFundsManager.new(vault.address)
  })

  context('initialize()', () => {

    beforeEach(async () => {
      await issuance.initialize(tokenManager.address, aragonVaultFundsManager.address,
        INITIAL_TARGET_RATIO, INITIAL_RECOVERY_TIME)
      await aragonVaultFundsManager.addFundsUser(issuance.address)
    })

    it('should set init params correctly', async () => {
      assert.equal(await issuance.commonPoolTokenManager(), tokenManager.address, 'Incorrect token manager')
      assert.equal(await issuance.commonPoolFundsManager(), aragonVaultFundsManager.address, 'Incorrect funds manager')
      assert.equal(await issuance.commonPoolToken(), commonPoolToken.address, 'Incorrect token')
      assertBn(await issuance.targetRatio(), INITIAL_TARGET_RATIO, 'Incorrect target ratio')
      assertBn(await issuance.recoveryTime(), INITIAL_RECOVERY_TIME, 'Incorrect recovery time')
    })

    it('reverts when target ratio more than ratio precision', async () => {
      const issuanceAddress = await installNewApp(dao, ISSUANCE_APP_ID, issuanceBase.address, appManager)
      issuance = await Issuance.at(issuanceAddress)
      await assertRevert(issuance.initialize(tokenManager.address, vault.address,
        RATIO_PRECISION.add(bn(1)), INITIAL_RECOVERY_TIME), 'ISSUANCE_TARGET_RATIO_TOO_HIGH')
    })

    context('updateFundsManager(fundsManager)', () => {
      it('updates the funds manager', async () => {
        await issuance.updateFundsManager(newFundsManager)
        assert.equal(await issuance.commonPoolFundsManager(), newFundsManager, 'Incorrect funds manager')
      })

      it('reverts when no permission', async () => {
        await acl.revokePermission(ANY_ADDRESS, issuance.address, await issuance.UPDATE_SETTINGS_ROLE())
        await assertRevert(issuance.updateFundsManager(newFundsManager), 'APP_AUTH_FAILED')
      })
    })

    context('updateTargetRatio(uint256 _targetRatio)', async () => {
      it('updates target ratio', async() => {
        const expectedTargetRatio = bigExp(5, 9)
        await issuance.updateTargetRatio(expectedTargetRatio)
        assertBn(await issuance.targetRatio(), expectedTargetRatio, 'Incorrect target ratio')
      })

      it('reverts when target ratio more than ratio precision', async () => {
        const badTargetRatio = RATIO_PRECISION.add(bn(1))
        await assertRevert(issuance.updateTargetRatio(badTargetRatio), 'ISSUANCE_TARGET_RATIO_TOO_HIGH')
      })

      it('reverts when no permission', async () => {
        await acl.revokePermission(ANY_ADDRESS, issuance.address, await issuance.UPDATE_SETTINGS_ROLE())
        await assertRevert(issuance.updateTargetRatio(INITIAL_TARGET_RATIO), 'APP_AUTH_FAILED')
      })
    })

    context('updateRecoveryTime(uint256 _recoveryTime)', async () => {
      it('updates recovery time', async() => {
        const expectedRecoveryTime = bigExp(1, 9)
        await issuance.updateRecoveryTime(expectedRecoveryTime)
        assertBn(await issuance.recoveryTime(), expectedRecoveryTime, 'Incorrect recovery time')
      })

      it('reverts when no permission', async () => {
        await acl.revokePermission(ANY_ADDRESS, issuance.address, await issuance.UPDATE_SETTINGS_ROLE())
        await assertRevert(issuance.updateRecoveryTime(INITIAL_RECOVERY_TIME), 'APP_AUTH_FAILED')
      })
    })

    context('executeAdjustment()', () => {

      beforeEach(async () => {
        await tokenManager.mint(appManager, TOTAL_SUPPLY)
      })

      context('burn adjustment', () => {

        const initialCommonPoolBalance = bigExp(30, 18)

        beforeEach(async () => {
          await commonPoolToken.transfer(vault.address, initialCommonPoolBalance)
        })

        it('executes correctly after 10 days', async () => {
          const commonPoolBalanceBefore = await commonPoolToken.balanceOf(vault.address)

          const expectedBurnAmount = await calculateAdjustmentBN(commonPoolBalanceBefore, TOTAL_SUPPLY, INITIAL_TARGET_RATIO, INITIAL_RECOVERY_TIME, ONE_DAY * 10)
          await issuance.mockIncreaseTime(ONE_DAY * 10)
          await issuance.executeAdjustment()

          const commonPoolBalanceAfter = await commonPoolToken.balanceOf(vault.address)
          const precision = bigExp(1, 15);
          assertBn(commonPoolBalanceAfter.div(precision), commonPoolBalanceBefore.sub(expectedBurnAmount).div(precision), 'Incorrect common pool balance')
        })

        it('executes correctly after 2 periods of 5 days', async () => {
          const commonPoolBalanceBefore = await commonPoolToken.balanceOf(vault.address)
          await issuance.mockIncreaseTime(ONE_DAY * 5)
          const firstBurnAmount = await calculateAdjustmentBN(commonPoolBalanceBefore, TOTAL_SUPPLY, INITIAL_TARGET_RATIO, INITIAL_RECOVERY_TIME, ONE_DAY * 5)

          await issuance.executeAdjustment()
          const commonPoolBalanceAfterExecute = await commonPoolToken.balanceOf(vault.address)
          await issuance.mockIncreaseTime(ONE_DAY * 5)
          const secondBurnAmount = await calculateAdjustmentBN(commonPoolBalanceAfterExecute, await commonPoolToken.totalSupply(), INITIAL_TARGET_RATIO, INITIAL_RECOVERY_TIME, ONE_DAY * 5)

          await issuance.executeAdjustment()

          const totalBurnAmount = firstBurnAmount.add(secondBurnAmount)
          const commonPoolBalanceAfter = await commonPoolToken.balanceOf(vault.address)
          const precision = bigExp(1, 15);
          assertBn(commonPoolBalanceAfter.div(precision), commonPoolBalanceBefore.sub(totalBurnAmount).div(precision), 'Incorrect common pool balance')
        })

        it('common pool do not increase when recovery time passed', async () => {
          const newRecoveryTime = bn(ONE_DAY)
          await issuance.updateRecoveryTime(newRecoveryTime)
          await issuance.mockIncreaseTime(ONE_DAY)
          await issuance.executeAdjustment()

          const commonPoolBalanceBefore = await commonPoolToken.balanceOf(vault.address)
          await issuance.mockIncreaseTime(ONE_DAY * 10)

          await issuance.executeAdjustment()

          const commonPoolBalanceAfter = await commonPoolToken.balanceOf(vault.address)
          assertBn(commonPoolBalanceAfter, commonPoolBalanceBefore, 'Incorrect common pool balance')
        })

        it('does not burn more than target balance', async () => {
          const commonPoolBalanceBefore = await commonPoolToken.balanceOf(vault.address)
          const expectedToBurn = commonPoolBalanceBefore.mul(RATIO_PRECISION).sub(INITIAL_TARGET_RATIO.mul(TOTAL_SUPPLY)).div(RATIO_PRECISION.sub(INITIAL_TARGET_RATIO))
          const targetBalance = commonPoolBalanceBefore.sub(expectedToBurn)
          await issuance.mockIncreaseTime(ONE_DAY * 1000)
          await issuance.executeAdjustment()
          const commonPoolBalanceAfter = await commonPoolToken.balanceOf(vault.address)
          assertBn(commonPoolBalanceAfter, targetBalance, 'Incorrect common pool balance')
        })
      })

      context('mint adjustment', () => {

        const initialCommonPoolBalance = bigExp(10, 18)

        beforeEach(async () => {
          await commonPoolToken.transfer(vault.address, initialCommonPoolBalance)
        })

        it('executes correctly after 16 days', async () => {
          const commonPoolBalanceBefore = await commonPoolToken.balanceOf(vault.address)
          await issuance.mockIncreaseTime(ONE_DAY * 16)
          const expectedMintAmount = await calculateAdjustmentBN(commonPoolBalanceBefore, TOTAL_SUPPLY, INITIAL_TARGET_RATIO, INITIAL_RECOVERY_TIME, ONE_DAY * 16)

          await issuance.executeAdjustment()

          const commonPoolBalanceAfter = await commonPoolToken.balanceOf(vault.address)
          const precision = bigExp(1, 13);
          assertBn(commonPoolBalanceAfter.div(precision), commonPoolBalanceBefore.add(expectedMintAmount).div(precision), 'Incorrect common pool balance')
        })

        it('executes correctly after 2 periods of 8 days', async () => {
          const commonPoolBalanceBefore = await commonPoolToken.balanceOf(vault.address)
          await issuance.mockIncreaseTime(ONE_DAY * 8)
          const firstMintAmount = await calculateAdjustmentBN(commonPoolBalanceBefore, TOTAL_SUPPLY, INITIAL_TARGET_RATIO, INITIAL_RECOVERY_TIME, ONE_DAY * 8)

          await issuance.executeAdjustment()
          const commonPoolBalanceAfterExecute = await commonPoolToken.balanceOf(vault.address)
          await issuance.mockIncreaseTime(ONE_DAY * 8)
          const secondMintAmount = await calculateAdjustmentBN(commonPoolBalanceAfterExecute, await commonPoolToken.totalSupply(), INITIAL_TARGET_RATIO, INITIAL_RECOVERY_TIME, ONE_DAY * 8)

          await issuance.executeAdjustment()

          const totalMintAmount = firstMintAmount.add(secondMintAmount)
          const commonPoolBalanceAfter = await commonPoolToken.balanceOf(vault.address)
          const precision = bigExp(1, 13);
          assertBn(commonPoolBalanceAfter.div(precision), commonPoolBalanceBefore.add(totalMintAmount).div(precision), 'Incorrect common pool balance')
        })

        it('does not mint more than target balance', async () => {
          const commonPoolBalanceBefore = await commonPoolToken.balanceOf(vault.address)
          const expectedToMint = INITIAL_TARGET_RATIO.mul(TOTAL_SUPPLY).sub(commonPoolBalanceBefore.mul(RATIO_PRECISION)).div(RATIO_PRECISION.sub(INITIAL_TARGET_RATIO))
          const targetBalance = commonPoolBalanceBefore.add(expectedToMint)
          await issuance.mockIncreaseTime(ONE_DAY * 1000)
          await issuance.executeAdjustment()
          const commonPoolBalanceAfter = await commonPoolToken.balanceOf(vault.address)
          assertBn(commonPoolBalanceAfter, targetBalance, 'Incorrect common pool balance')
        })
      })

      it('reverts when token supply is 0', async () => {
        await tokenManager.burn(appManager, bigExp(100, 18))
        assertBn(await commonPoolToken.totalSupply(), bn(0), 'Incorrect total supply')

        await assertRevert(issuance.executeAdjustment(), "MATH_DIV_ZERO")
      })
    })
  })
})

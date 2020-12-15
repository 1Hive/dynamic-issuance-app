const { newDao, newApp } = require('./helpers/dao')
const { setOpenPermission } = require('./helpers/permissions')
const { ZERO_ADDRESS, bn, bigExp, ONE_DAY } = require('@aragon/contract-helpers-test')
const { assertBn, assertRevert } = require('@aragon/contract-helpers-test/src/asserts')

const Issuance = artifacts.require('MockIssuance.sol')
const TokenManager = artifacts.require('HookedTokenManager.sol')
const Vault = artifacts.require('Vault.sol')
const MiniMeToken = artifacts.require('MiniMeToken.sol')

contract('Issuance', ([appManager]) => {

  let dao, acl
  let tokenManagerBase, tokenManager, vaultBase, vault, issuanceBase, issuance, commonPoolToken

  const ANY_ADDRESS = '0xffffffffffffffffffffffffffffffffffffffff'
  const EXTRA_PRECISION = bigExp(1,18);
  const RATIO_PRECISION = bigExp(1, 10);
  const TOTAL_SUPPLY = bigExp(100, 18)
  const SECONDS_IN_YEAR = bn('31536000')

  const INITIAL_TARGET_RATIO = bigExp(2, 9) // 0.2 (20% of total supply)
  // The initial adjustment per second with a total supply of 100 tokens, target 20 (20% of total supply) and balance
  // 10 or 30, is 15854895991 ~ 1.5e10. Therefore 1e11 is slightly bigger and will initially be ignored.
  const INITIAL_MAX_ADJUSTMENT_PER_SECOND = bigExp(1, 11)

  const calculateAdjustment = async (commonPoolBalance, tokenTotalSupply, targetRatio) => {
    const ratio = ((commonPoolBalance.mul(EXTRA_PRECISION).mul(RATIO_PRECISION)).div(tokenTotalSupply)).div(targetRatio)

    let adjustmentRatioPerSecond
    if (ratio.gt(EXTRA_PRECISION)) {
      adjustmentRatioPerSecond = (ratio.sub(EXTRA_PRECISION)).div(SECONDS_IN_YEAR)
    } else {
      adjustmentRatioPerSecond = (EXTRA_PRECISION.sub(ratio)).div(SECONDS_IN_YEAR)
    }

    return await adjustmentFromRatioPerSecond(tokenTotalSupply, adjustmentRatioPerSecond)
  }

  const adjustmentFromRatioPerSecond = async (tokenTotalSupply, maxAdjustmentPerSecond) => {
    const secondsPast = await secondsSincePreviousAdjustment()
    return ((maxAdjustmentPerSecond.mul(secondsPast)).mul(tokenTotalSupply)).div(EXTRA_PRECISION)
  }

  const secondsSincePreviousAdjustment = async () => {
    return (await issuance.getTimestampPublic()).sub(await issuance.previousAdjustmentSecond())
  }

  before(async () => {
    tokenManagerBase = await TokenManager.new()
    vaultBase = await Vault.new()
    issuanceBase = await Issuance.new()
  })

  beforeEach(async () => {
    ({ dao, acl } = await newDao(appManager))

    const issuanceAddress = await newApp(dao, 'issuance', issuanceBase.address, appManager)
    issuance = await Issuance.at(issuanceAddress)
    await setOpenPermission(acl, issuance.address, await issuance.UPDATE_SETTINGS_ROLE(), appManager)

    commonPoolToken = await MiniMeToken.new(ZERO_ADDRESS, ZERO_ADDRESS, 0, 'Honey', 18, 'HNY', true)

    const tokenManagerAddress = await newApp(dao, 'tokenManager', tokenManagerBase.address, appManager)
    tokenManager = await TokenManager.at(tokenManagerAddress)
    await commonPoolToken.changeController(tokenManagerAddress)
    await setOpenPermission(acl, tokenManager.address, await tokenManager.INIT_ROLE(), appManager)
    await setOpenPermission(acl, tokenManager.address, await tokenManager.MINT_ROLE(), appManager)
    await setOpenPermission(acl, tokenManager.address, await tokenManager.BURN_ROLE(), appManager)
    await tokenManager.initialize(commonPoolToken.address, true, 0)

    const vaultAddress = await newApp(dao, 'vault', vaultBase.address, appManager)
    vault = await Vault.at(vaultAddress)
    await vault.initialize()
  })

  context('initialize()', () => {

    let secondDeployed

    beforeEach(async () => {
      secondDeployed = await issuance.getTimestampPublic()
      await issuance.initialize(tokenManager.address, vault.address, commonPoolToken.address,
        INITIAL_TARGET_RATIO, INITIAL_MAX_ADJUSTMENT_PER_SECOND)
    })

    it('should set init params correctly', async () => {
      assert.equal(await issuance.commonPoolTokenManager(), tokenManager.address, 'Incorrect token manager')
      assert.equal(await issuance.commonPoolVault(), vault.address, 'Incorrect vault')
      assert.equal(await issuance.commonPoolToken(), commonPoolToken.address, 'Incorrect token')
      assertBn(await issuance.targetRatio(), INITIAL_TARGET_RATIO, 'Incorrect target ratio')
      assertBn(await issuance.maxAdjustmentPerSecond(), INITIAL_MAX_ADJUSTMENT_PER_SECOND, 'Incorrect max adjustment per second')
      assert.closeTo((await issuance.previousAdjustmentSecond()).toNumber(), secondDeployed.toNumber(), 3, 'Incorrect previous adjustment second')
    })

    it('reverts when target ratio more than ratio precision', async () => {
      const issuanceAddress = await newApp(dao, 'issuance', issuanceBase.address, appManager)
      issuance = await Issuance.at(issuanceAddress)
      await assertRevert(issuance.initialize(tokenManager.address, vault.address, commonPoolToken.address,
        RATIO_PRECISION.add(bn(1)), INITIAL_MAX_ADJUSTMENT_PER_SECOND), 'ISSUANCE_TARGET_RATIO_TOO_HIGH')
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

    context('updateMaxAdjustmentPerSecond(uint256 _maxAdjustmentPerSecond)', async () => {
      it('updates max adjustment per second', async() => {
        const expectedMaxAdjustmentPerSecond = bigExp(1, 9)
        await issuance.updateMaxAdjustmentPerSecond(expectedMaxAdjustmentPerSecond)
        assertBn(await issuance.maxAdjustmentPerSecond(), expectedMaxAdjustmentPerSecond, 'Incorrect max adjustment per second')
      })

      it('reverts when no permission', async () => {
        await acl.revokePermission(ANY_ADDRESS, issuance.address, await issuance.UPDATE_SETTINGS_ROLE())
        await assertRevert(issuance.updateMaxAdjustmentPerSecond(INITIAL_MAX_ADJUSTMENT_PER_SECOND), 'APP_AUTH_FAILED')
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
          await issuance.mockIncreaseTime(ONE_DAY * 10)
          const expectedBurnAmount = await calculateAdjustment(commonPoolBalanceBefore, TOTAL_SUPPLY, INITIAL_TARGET_RATIO)

          await issuance.executeAdjustment()

          const commonPoolBalanceAfter = await commonPoolToken.balanceOf(vault.address)
          assertBn(commonPoolBalanceAfter, commonPoolBalanceBefore.sub(expectedBurnAmount), 'Incorrect common pool balance')
        })

        it('executes correctly after 2 periods of 5 days', async () => {
          const commonPoolBalanceBefore = await commonPoolToken.balanceOf(vault.address)
          await issuance.mockIncreaseTime(ONE_DAY * 5)
          const firstBurnAmount = await calculateAdjustment(commonPoolBalanceBefore, TOTAL_SUPPLY, INITIAL_TARGET_RATIO)

          await issuance.executeAdjustment()
          const commonPoolBalanceAfterExecute = await commonPoolToken.balanceOf(vault.address)
          await issuance.mockIncreaseTime(ONE_DAY * 5)
          const secondBurnAmount = await calculateAdjustment(commonPoolBalanceAfterExecute, await commonPoolToken.totalSupply(), INITIAL_TARGET_RATIO)

          await issuance.executeAdjustment()

          const totalBurnAmount = firstBurnAmount.add(secondBurnAmount)
          const commonPoolBalanceAfter = await commonPoolToken.balanceOf(vault.address)
          assertBn(commonPoolBalanceAfter, commonPoolBalanceBefore.sub(totalBurnAmount), 'Incorrect common pool balance')
        })

        it('falls back to max adjustment per second when calculated adjustment per second is bigger', async () => {
          const newMaxAdjustmentPerSecond = bigExp(1, 9)
          const commonPoolBalanceBefore = await commonPoolToken.balanceOf(vault.address)
          await issuance.mockIncreaseTime(ONE_DAY * 10)
          await issuance.updateMaxAdjustmentPerSecond(newMaxAdjustmentPerSecond)
          const expectedBurnAmount = await adjustmentFromRatioPerSecond(TOTAL_SUPPLY, newMaxAdjustmentPerSecond)

          await issuance.executeAdjustment()

          const commonPoolBalanceAfter = await commonPoolToken.balanceOf(vault.address)
          assertBn(commonPoolBalanceAfter, commonPoolBalanceBefore.sub(expectedBurnAmount), 'Incorrect common pool balance')
        })

        context('when falling back to target balance', () => {
          it('does not burn more than target balance when total to burn burns below target', async () => {
            const targetAmount = TOTAL_SUPPLY.mul(INITIAL_TARGET_RATIO).div(RATIO_PRECISION)
            await issuance.mockIncreaseTime(ONE_DAY * 200)
            const commonPoolBalanceBefore = await commonPoolToken.balanceOf(vault.address)
            const expectedBurnAmount = await calculateAdjustment(commonPoolBalanceBefore, TOTAL_SUPPLY, INITIAL_TARGET_RATIO)
            assert.isTrue(expectedBurnAmount.lt(commonPoolBalanceBefore), 'Incorrect expected burn amount, not less than balance')
            assert.isTrue((commonPoolBalanceBefore.sub(expectedBurnAmount)).lt(targetAmount), 'Incorrect expected burn amount, too small')

            await issuance.executeAdjustment()

            const commonPoolBalanceAfter = await commonPoolToken.balanceOf(vault.address)
            assertBn(commonPoolBalanceAfter, targetAmount, 'Incorrect common pool balance')
          })

          it('does not burn more than target balance when total to burn is more than the common pool balance', async () => {
            const targetAmount = TOTAL_SUPPLY.mul(INITIAL_TARGET_RATIO).div(RATIO_PRECISION)
            await issuance.mockIncreaseTime(ONE_DAY * 365)
            const commonPoolBalanceBefore = await commonPoolToken.balanceOf(vault.address)
            const expectedBurnAmount = await calculateAdjustment(commonPoolBalanceBefore, TOTAL_SUPPLY, INITIAL_TARGET_RATIO)
            assert.isTrue(expectedBurnAmount.gt(commonPoolBalanceBefore), 'Incorrect expected burn amount')

            await issuance.executeAdjustment()

            const commonPoolBalanceAfter = await commonPoolToken.balanceOf(vault.address)
            assertBn(commonPoolBalanceAfter, targetAmount, 'Incorrect common pool balance')
          })
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
          const expectedMintAmount = await calculateAdjustment(commonPoolBalanceBefore, TOTAL_SUPPLY, INITIAL_TARGET_RATIO)

          await issuance.executeAdjustment()

          const commonPoolBalanceAfter = await commonPoolToken.balanceOf(vault.address)
          assertBn(commonPoolBalanceAfter, commonPoolBalanceBefore.add(expectedMintAmount), 'Incorrect common pool balance')
        })

        it('executes correctly after 2 periods of 8 days', async () => {
          const commonPoolBalanceBefore = await commonPoolToken.balanceOf(vault.address)
          await issuance.mockIncreaseTime(ONE_DAY * 8)
          const firstMintAmount = await calculateAdjustment(commonPoolBalanceBefore, TOTAL_SUPPLY, INITIAL_TARGET_RATIO)

          await issuance.executeAdjustment()
          const commonPoolBalanceAfterExecute = await commonPoolToken.balanceOf(vault.address)
          await issuance.mockIncreaseTime(ONE_DAY * 8)
          const secondMintAmount = await calculateAdjustment(commonPoolBalanceAfterExecute, await commonPoolToken.totalSupply(), INITIAL_TARGET_RATIO)

          await issuance.executeAdjustment()

          const totalMintAmount = firstMintAmount.add(secondMintAmount)
          const commonPoolBalanceAfter = await commonPoolToken.balanceOf(vault.address)
          assertBn(commonPoolBalanceAfter, commonPoolBalanceBefore.add(totalMintAmount), 'Incorrect common pool balance')
        })

        it('falls back to max adjustment per second when calculated adjustment per second is bigger', async () => {
          const newMaxAdjustmentPerSecond = bigExp(1, 9)
          const commonPoolBalanceBefore = await commonPoolToken.balanceOf(vault.address)
          await issuance.mockIncreaseTime(ONE_DAY * 16)
          await issuance.updateMaxAdjustmentPerSecond(newMaxAdjustmentPerSecond)
          const expectedMintAmount = await adjustmentFromRatioPerSecond(TOTAL_SUPPLY, newMaxAdjustmentPerSecond)

          await issuance.executeAdjustment()

          const commonPoolBalanceAfter = await commonPoolToken.balanceOf(vault.address)
          assertBn(commonPoolBalanceAfter, commonPoolBalanceBefore.add(expectedMintAmount), 'Incorrect common pool balance')
        })

        it('does not mint more than target balance', async () => {
            const targetAmount = TOTAL_SUPPLY.mul(INITIAL_TARGET_RATIO).div(RATIO_PRECISION)
            await issuance.mockIncreaseTime(ONE_DAY * 200)
            const commonPoolBalanceBefore = await commonPoolToken.balanceOf(vault.address)
            const expectedMintAmount = await calculateAdjustment(commonPoolBalanceBefore, TOTAL_SUPPLY, INITIAL_TARGET_RATIO)
            assert.isTrue((commonPoolBalanceBefore.add(expectedMintAmount)).gt(targetAmount), 'Incorrect expected mint amount, too large')

            await issuance.executeAdjustment()

            const commonPoolBalanceAfter = await commonPoolToken.balanceOf(vault.address)
            assertBn(commonPoolBalanceAfter, targetAmount, 'Incorrect common pool balance')
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

const { assert } = require('chai')
const { assertRevert } = require('@aragon/contract-test-helpers/assertThrow')
const { newDao, newApp } = require('./helpers/dao')
const { setOpenPermission } = require('./helpers/permissions')
const { ZERO_ADDRESS, bn, bigExp, ONE_DAY, getEventArgument } = require('@aragon/contract-helpers-test')

const Issuance = artifacts.require('MockIssuance.sol')
const TokenManager = artifacts.require('HookedTokenManager.sol')
const Vault = artifacts.require('Vault.sol')
const MiniMeToken = artifacts.require('MiniMeToken.sol')

contract('Issuance', ([appManager, user]) => {

  let tokenManagerBase, tokenManager, vaultBase, vault, issuanceBase, issuance, commonPoolToken

  const INITIAL_TARGET_RATIO = bigExp(2, 9) // 0.2 (20% of total supply)
  const INITIAL_MAX_ADJUSTMENT_PER_SECOND = bigExp(1, 15) // maybe 1e12/13 ?

  before('deploy base issuance', async () => {
    tokenManagerBase = await TokenManager.new()
    vaultBase = await Vault.new()
    issuanceBase = await Issuance.new()
  })

  beforeEach('deploy dao and issuance', async () => {
    const { dao, acl } = await newDao(appManager)

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

    await issuance.initialize(tokenManager.address, vault.address, commonPoolToken.address,
      INITIAL_TARGET_RATIO, INITIAL_MAX_ADJUSTMENT_PER_SECOND)
  })

  context('initialize()', () => {
    it('should set init params correctly', async () => {

    })

    context('executeAdjustment()', () => {
      it('executes burn adjustment correctly after 1 year', async () => {
        await tokenManager.mint(appManager, bigExp(100, 18))
        await commonPoolToken.transfer(vault.address, bigExp(30, 18))
        await issuance.mockIncreaseTime(ONE_DAY * 365)
        console.log((await commonPoolToken.balanceOf(vault.address)).toString())

        const receipt = await issuance.executeAdjustment()
        console.log((getEventArgument(receipt, "DEBUG", "a")).toString())
        console.log((getEventArgument(receipt, "DEBUG", "b")).toString())
        console.log((getEventArgument(receipt, "DEBUG", "c")).toString())

        console.log((await commonPoolToken.balanceOf(vault.address)).toString())

        assert.isTrue(false)
      })
    })
  })
})

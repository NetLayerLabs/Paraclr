# Vendored: Pyth Solidity SDK 4.3.1 (interfaces only)

Plain-file copy of selected files from the npm package `@pythnetwork/pyth-sdk-solidity@4.3.1`:
`IPyth.sol`, `IPythEvents.sol`, `PythStructs.sol`, `PythErrors.sol`,
`LICENSE`, `README.md`. Not a git submodule. Do not edit.

`MockPyth.sol` from the package is deliberately NOT vendored: the only Pyth mock in this repo
lives under `contracts/test/prod/` (production plan: "A MockPyth exists only under
contracts/test/"). `AbstractPyth.sol`, `PythAggregatorV3.sol`, `PythUtils.sol`, `Math.sol` and the ABI/build
folders are not used and not vendored.

- Source: https://registry.npmjs.org/@pythnetwork/pyth-sdk-solidity/-/pyth-sdk-solidity-4.3.1.tgz
- Tarball sha256: 3460ac6b3c5a933b9e5fe70ba5b35abd2089789a8703f2fca1c1d0e4b838ff38
- License: Apache-2.0 (LICENSE)
- Remapping: `@pythnetwork/pyth-sdk-solidity/=lib/pyth-sdk-solidity/`
- On-chain counterpart verified on Monad mainnet: Pyth proxy
  0x2880aB155794e7179c9eE2e38200202908C17B43, implementation reports `version()` = "1.4.6" and
  contains the `parsePriceFeedUpdatesUnique(bytes[],bytes32[],uint64,uint64)` selector 0xaccca7f9.

// The production clearinghouse interface: the generated ABI of
// contracts/src/prod/ParaclrClearinghouseProd.sol (`npm run abi`, contracts
// agent). Every production read/write goes through src/lib/chain/prod/*, so a
// contract change surfaces here as a type error instead of a runtime surprise.
//
// Reads are always made with allowFailure: a view this deployment doesn't have
// shows "—" instead of breaking the page.

import { parseAbi } from "viem";

export { paraclrClearinghouseProdAbi as prodAbi } from "../abi";

/** The subset of IPyth the app uses (Pyth EVM SDK). */
export const pythAbi = parseAbi([
  "function getUpdateFee(bytes[] updateData) view returns (uint256 feeAmount)",
  "function getPriceUnsafe(bytes32 id) view returns ((int64 price, uint64 conf, int32 expo, uint256 publishTime))",
  "error InsufficientFee()",
  "error StalePrice()",
  "error PriceFeedNotFound()",
  "error PriceFeedNotFoundWithinRange()",
  "error InvalidUpdateData()",
  "error InvalidUpdateDataSource()",
  "error InvalidWormholeVaa()",
  "error NoFreshUpdate()",
]);

/**
 * Agora's AUSD faucet (Monad testnet, behind a transparent proxy). Read from
 * the implementation's bytecode on chain 2026-10-07 — Agora documents only the
 * address and `requestFunds(recipient)`. One drip per `maxDripFrequency`
 * seconds across ALL callers (`lastDripTimestamp` is global), refused once the
 * recipient holds `maxAmountToOwn`.
 */
export const agoraFaucetAbi = parseAbi([
  "function requestFunds(address recipient)",
  "function faucetDripAmount() view returns (uint256)",
  "function maxAmountToOwn() view returns (uint256)",
  "function maxDripFrequency() view returns (uint256)",
  "function lastDripTimestamp() view returns (uint256)",
  "function token() view returns (address)",
  "error MaxAllowedExceeded()",
  "error MaxFrequencyExceeded()",
  "error InsufficientFunds()",
]);

/** `getOrder(...).status` (ParaclrClearinghouseProd.OrderStatus). */
export const ORDER_STATUS = { none: 0, pending: 1, executed: 2, failed: 3, cancelled: 4 } as const;

/** orderId = (uint160(account) << 96) | nonce — the nonce is what people see. */
export function orderNonce(orderId: bigint): bigint {
  return orderId & ((BigInt(1) << BigInt(96)) - BigInt(1));
}

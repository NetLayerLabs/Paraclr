// Production contract ABIs the keeper uses.
//
// The clearinghouse ABI is generated from contracts/src/prod/ParaclrClearinghouseProd.sol by
// `npm run abi` (scripts/export-abi.mjs → src/lib/chain/abi/). Every call the keeper makes goes
// through this module.

import { parseAbi } from "viem";
import { paraclrClearinghouseProdAbi } from "../../../src/lib/chain/abi/ParaclrClearinghouseProd";

export const clearinghouseAbi = paraclrClearinghouseProdAbi;

export const pythAbi = parseAbi([
  "function getUpdateFee(bytes[] updateData) view returns (uint256 feeAmount)",
  "function getPriceUnsafe(bytes32 id) view returns ((int64 price, uint64 conf, int32 expo, uint256 publishTime))",
  "function updatePriceFeeds(bytes[] updateData) payable",
  "function getValidTimePeriod() view returns (uint256)",
  "function version() view returns (string)",
]);

export const erc20Abi = parseAbi([
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function allowance(address owner, address spender) view returns (uint256)",
  "function transfer(address to, uint256 amount) returns (bool)",
]);

/** OpenZeppelin TimelockController (the owner of the production set). */
export const timelockAbi = parseAbi([
  "function getMinDelay() view returns (uint256)",
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function PROPOSER_ROLE() view returns (bytes32)",
  "function EXECUTOR_ROLE() view returns (bytes32)",
  "function CANCELLER_ROLE() view returns (bytes32)",
  "function DEFAULT_ADMIN_ROLE() view returns (bytes32)",
  "function schedule(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay)",
  "function execute(address target, uint256 value, bytes payload, bytes32 predecessor, bytes32 salt) payable",
  "function hashOperation(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt) view returns (bytes32)",
  "function isOperationReady(bytes32 id) view returns (bool)",
  "function isOperationDone(bytes32 id) view returns (bool)",
  "event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)",
]);

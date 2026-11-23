// Code of the reference TEP-74 jetton (Jetton 2.0 in Tolk by The Tolk Team, MIT License, compiled with
// @ton/tolk-js 1.5.0): the tests deploy a real jetton to check transfer notifications as a jetton wallet sends them.
import { beginCell, Cell, contractAddress } from "@ton/core";
import type { Address } from "@ton/core";

export const JETTON_MINTER_CODE = Cell.fromBase64(
  "te6ccgECDAEAAigAART/APSkE/S88sgLAQIBYgIDAvjQ+JHyQCDXLCPe7L70jmMx7UTQAdM/+gD6SPpQMAT6ACDUMddM+JL4KMjPhCAW+lIV+lLJAcjPhNDMzPkWyM+KAEDL/89QE8cF8uBKWKHIAfoCzsntVCFukVvgyM+FCBL6UoIQ1TJ2288Ljss/yYBC+wDg1ywhY7XLnOMCBAUCA3pgCgsA4jH4l/iTcPg6ggiYloCgvPLgS9M/+kjXCgCVIMj6UsmRbeJtIvpEMJEyjigw7UTQ1DHXTPgoyM+EIBT6UhP6UslYyM+E0MzM+RbIz4oAQMv/z1AB4viSyM+FiPpSghDRc1QAzwuOE8s/+lT0AMmAQPsABPqJ1yeOazHtRND6ACD6SNQx10z4kljHBfLgSQPTPzH6SPoA10wg0NcsILxqKMzyv9M/MfoAMBWgyAH6AhPOye1U+CjIz4QgEvpS+lLJyM+JiAFTFMjPhNDMzPkWzwv/WPoCgQCNzwtwE8wSzMzJcfsA4NcsIAAAABzjAonXJwYHCAkACAAAABUAQjHtRND6APpI+JJYxwXy4EkC0z8x+kgwyFj6AvpSzsntVAAIAAAABABYjiEx7UTQ+gD6SNQx+JIixwXy4EkD10zIUAP6AvpSzM7J7VTgMIQPAccA8vQAUa289qJoahjrpnwUZGfCEAn9KQl9KWSA5GfCaGZmfItkZ8UAIGX/56hAAB+vFvaiaH0AfSRqa6Y/qpBA",
);

export const JETTON_WALLET_CODE = Cell.fromBase64(
  "te6ccgECCgEAAk4AART/APSkE/S88sgLAQIBYgIDA7zQ+JGONNMfMdcsILxqKMyW0z8x+gAwjhHXLCPe7L70kvI/4dM/MfoAMOLtRND6AAKgyAH6As7J7VTgINcsILxqKMzjAtcsIHxT9SzjAtcsIsr4PeTjAjCEDwHHAPL0BAUGAB2g9gXaiaH0AfSR9JBh8FUC/DHtRNAB0z/6APpQ+lD6AAb6ACD6SPpIMPiSIccFkTCOJviS+CooyM+EIPpSE/pSyVjIz4TQzMz5FsjPigBAy//PUMcF8uLD4lEmoMgB+gLOye1U+Jf4J28QIaGCCJiWgGa2CKGCCOThwKChIpQ3W2wh4w0gbrMjwgCw4wJfAwcIAf4x0z/6APpI+lD0AfoAINdJ8uLEI/pEMPLRTe1E0PoAIPpI+kgw+JIixwXy4sFTOL7y4sJROKHIAfoCEs7J7VQjcnHjBPiX+JNw+DoSqCWgggpiWgCgvPLixfgqyM+EIBf6UhL6UsnIz5BeNRRmGMs/UAb6AhX6VBL6VAH6AhLOCQCgMe1E0PoAIPpI+kgw+JIixwXy4sEE0z/6APpQMFNRvvLiwlFRocgB+gIUzsntVMjPke92X3rLP1j6AvpS+lTJyM+FiBL6UnHPC27MyYBQ+wAAZPiTcPg6I6ChyM+RzYtCcifPCz9QBvoCFPpUFs7JyM+FCBP6UlAF+gJxzwtqzMlx+wACADDIz4UI+lJY+gKCENUydtvPC4rLP8ly+wAARMnIz4mIAV3Iz4TQzMz5Fs8L/4EAjc8LdBLMEszMyYBA+wA=",
);

const OP_MINT = 0x15;
const OP_INTERNAL_TRANSFER = 0x178d4519;
const OP_TRANSFER = 0x0f8a7ea5;

// A new minter with `admin` as admin: its state init (code + data: supply 0, admin, empty content, wallet code)
export function jettonMinter(admin: Address): { address: Address; init: { code: Cell; data: Cell } } {
  const data = beginCell()
    .storeCoins(0)
    .storeAddress(admin)
    .storeRef(beginCell().endCell())
    .storeRef(JETTON_WALLET_CODE)
    .endCell();
  const init = { code: JETTON_MINTER_CODE, data };
  return { address: contractAddress(0, init), init };
}

// The jetton wallet of `owner` (in the basechain, as the minter deploys it)
export function jettonWalletAddress(owner: Address, minter: Address): Address {
  const data = beginCell().storeCoins(0).storeAddress(owner).storeAddress(minter).endCell();
  return contractAddress(0, { code: JETTON_WALLET_CODE, data });
}

// The admin's mint of `amount` jettons to `to` (the minter deploys `to`'s jetton wallet with `tonAmount`)
export function mintBody(to: Address, amount: bigint, responseAddress: Address): Cell {
  const internalTransfer = beginCell()
    .storeUint(OP_INTERNAL_TRANSFER, 32)
    .storeUint(0, 64)
    .storeCoins(amount)
    .storeAddress(null)
    .storeAddress(responseAddress)
    .storeCoins(0)
    .storeBit(false)
    .endCell();
  return beginCell()
    .storeUint(OP_MINT, 32)
    .storeUint(0, 64)
    .storeAddress(to)
    .storeCoins(50_000_000n)
    .storeRef(internalTransfer)
    .endCell();
}

// The owner's transfer of `amount` jettons to `to`, with forward TON and a forward payload (TEP-74)
export function transferBody(
  amount: bigint,
  to: Address,
  responseAddress: Address,
  forwardTonAmount: bigint,
  forwardPayload: Cell,
): Cell {
  return beginCell()
    .storeUint(OP_TRANSFER, 32)
    .storeUint(0, 64)
    .storeCoins(amount)
    .storeAddress(to)
    .storeAddress(responseAddress)
    .storeBit(false)
    .storeCoins(forwardTonAmount)
    .storeBit(true)
    .storeRef(forwardPayload)
    .endCell();
}

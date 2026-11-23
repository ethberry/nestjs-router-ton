// Against the local TON network of docker-compose.yml (TON_API_URL, default http://localhost:8182)
import { Controller, Injectable } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import type { TestingModule } from "@nestjs/testing";
import { EventPattern, Payload } from "@nestjs/microservices";
import { CronExpression } from "@nestjs/schedule";
import { beginCell, toNano } from "@ton/core";

import { BLOCK_EVENT, TonEventType } from "./ton.constants.js";
import type { IBlockEvent, ILogEvent, ITonMessage } from "./interfaces/index.js";
import { TonModule } from "./ton.module.js";
import { TonService } from "./ton.service.js";
import { jettonMinter, jettonWalletAddress, mintBody, transferBody } from "./fixtures/jetton.js";
import {
  API_URL,
  freshAddress,
  masterchainSeqno,
  sendFromWallet,
  transfer,
  transferNotification,
  waitFor,
  waitForActive,
  wallet,
} from "./test-utils.js";

enum ContractType {
  MERCHANT = "MERCHANT",
  WALLET = "WALLET",
  NOBODY = "NOBODY",
}

const ALL_EVENTS = Object.values(TonEventType);
const OTHER_OP = 0x12345678;

interface IReceived {
  contractType: ContractType;
  event: ILogEvent<ITonMessage>;
}

@Injectable()
class Received {
  public events: IReceived[] = [];
  public lastSeqno = -1;

  public of(contractType: ContractType): Array<ILogEvent<ITonMessage>> {
    return this.events.filter(e => e.contractType === contractType).map(e => e.event);
  }
}

@Controller()
class TestController {
  constructor(private readonly received: Received) {}

  @EventPattern(ALL_EVENTS.map(eventName => ({ contractType: ContractType.MERCHANT, eventName })))
  public merchant(@Payload() event: ILogEvent<ITonMessage>): void {
    this.received.events.push({ contractType: ContractType.MERCHANT, event });
  }

  @EventPattern(ALL_EVENTS.map(eventName => ({ contractType: ContractType.WALLET, eventName })))
  public wallet(@Payload() event: ILogEvent<ITonMessage>): void {
    this.received.events.push({ contractType: ContractType.WALLET, event });
  }

  @EventPattern(ALL_EVENTS.map(eventName => ({ contractType: ContractType.NOBODY, eventName })))
  public nobody(@Payload() event: ILogEvent<ITonMessage>): void {
    this.received.events.push({ contractType: ContractType.NOBODY, event });
  }

  @EventPattern({ eventName: BLOCK_EVENT })
  public block(@Payload() event: ILogEvent<IBlockEvent>): void {
    this.received.lastSeqno = event.args.seqno;
  }
}

// A started reader from `fromSeqno`, watching the given addresses
async function startReader(fromSeqno: number, watch: Partial<Record<ContractType, string[]>>) {
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ ignoreEnvFile: true, load: [() => ({ TON_API_URL: API_URL })] }),
      TonModule.register({ fromSeqno, debug: true, cron: CronExpression.EVERY_SECOND }),
    ],
    providers: [Received],
    controllers: [TestController],
  }).compile();
  const service = module.get(TonService);
  for (const [contractType, contractAddress] of Object.entries(watch)) {
    service.updateRegistry({ contractType, contractAddress });
  }
  await module.init();
  return { module, received: module.get(Received) };
}

describe("TonService on the local network", function () {
  let module: TestingModule | undefined;

  afterEach(async function () {
    await module?.close();
    module = undefined;
  });

  it("routes the incoming messages of watched accounts by their opcode", async function () {
    const [merchant, nobody] = await Promise.all([freshAddress(), freshAddress()]);
    const reader = await startReader(await masterchainSeqno(), {
      // user-friendly and raw forms both match
      MERCHANT: [merchant.toString()],
      WALLET: [wallet.toString()],
      NOBODY: [nobody.toRawString()],
    });
    module = reader.module;
    const { received } = reader;

    await sendFromWallet([
      // 1 TON with a comment, non-bounceable: stays on the uninitialized merchant address
      transfer(merchant, toNano("1"), false, "order:1"),
      // a transfer notification built by hand: anyone can send one, only `from` tells a real one
      transfer(merchant, toNano("0.1"), false, transferNotification(5_000_000n, wallet, "order:2")),
      // an unknown opcode
      transfer(merchant, toNano("0.1"), false, beginCell().storeUint(OTHER_OP, 32).endCell()),
      // 0.5 TON bounceable to an uninitialized address: the coins come back as a bounce
      transfer(nobody, toNano("0.5"), true, "order:3"),
    ]);

    await waitFor(
      () => received.of(ContractType.MERCHANT).length === 3 && received.of(ContractType.WALLET).length === 1,
    );

    const merchantEvents = new Map(received.of(ContractType.MERCHANT).map(e => [e.name, e]));
    const comment = merchantEvents.get(TonEventType.TRANSFER)!;
    const notification = merchantEvents.get(TonEventType.TRANSFER_NOTIFICATION)!;
    const other = merchantEvents.get(TonEventType.MESSAGE)!;
    expect(comment.args.from).toEqual(wallet.toRawString());
    expect(comment.args.to).toEqual(merchant.toRawString());
    expect(comment.args.value).toEqual(toNano("1"));
    expect(comment.args.comment).toEqual("order:1");
    expect(notification.args.from).toEqual(wallet.toRawString());
    expect(notification.args.jettonAmount).toEqual(5_000_000n);
    expect(notification.args.comment).toEqual("order:2");
    expect(other.args.op).toEqual(OTHER_OP);

    const [bounce] = received.of(ContractType.WALLET);
    expect(bounce.name).toEqual(TonEventType.BOUNCE);
    expect(bounce.args.from).toEqual(nobody.toRawString());
    // the failed transaction of the uninitialized address is not a transfer
    expect(received.of(ContractType.NOBODY)).toEqual([]);
  });

  it("reports a real jetton transfer as a notification from the receiver's jetton wallet", async function () {
    const merchant = await freshAddress();
    const minter = jettonMinter(wallet);
    const reader = await startReader(await masterchainSeqno(), { MERCHANT: [merchant.toRawString()] });
    module = reader.module;
    const { received } = reader;

    // deploy the minter and mint 100 jettons to the main wallet in one message; then the wallet sends 5 of them
    await sendFromWallet([
      transfer(minter.address, toNano("0.2"), false, mintBody(wallet, 100_000_000n, wallet), minter.init),
    ]);
    await waitForActive(jettonWalletAddress(wallet, minter.address));
    await sendFromWallet([
      transfer(
        jettonWalletAddress(wallet, minter.address),
        toNano("0.2"),
        true,
        transferBody(
          5_000_000n,
          merchant,
          wallet,
          toNano("0.01"),
          beginCell().storeUint(0, 32).storeStringTail("order:4").endCell(),
        ),
      ),
    ]);

    // a spoofed notification: the same fields, sent by the main wallet instead of a jetton wallet
    await sendFromWallet([
      transfer(merchant, toNano("0.01"), false, transferNotification(5_000_000n, wallet, "order:4")),
    ]);

    await waitFor(() => received.of(ContractType.MERCHANT).length === 2);

    // the merchant's jetton wallet of this master, as the app checks it
    const merchantJettonWallet = await reader.module
      .get(TonService)
      .getJettonWalletAddress(minter.address.toString(), merchant.toString());
    // the spoofed one takes fewer hops and may come first
    const notifications = received.of(ContractType.MERCHANT);
    const real = notifications.find(n => n.args.from === merchantJettonWallet)!;
    const spoofed = notifications.find(n => n.args.from !== merchantJettonWallet)!;
    expect(merchantJettonWallet).toEqual(jettonWalletAddress(merchant, minter.address).toRawString());
    expect(real.name).toEqual(TonEventType.TRANSFER_NOTIFICATION);
    expect(real.args.from).toEqual(merchantJettonWallet);
    expect(real.args.jettonAmount).toEqual(5_000_000n);
    expect(real.args.sender).toEqual(wallet.toRawString());
    expect(real.args.value).toEqual(toNano("0.01"));
    expect(real.args.comment).toEqual("order:4");
    // the spoofed one looks the same but for `from`: the check rejects it
    expect(spoofed.name).toEqual(TonEventType.TRANSFER_NOTIFICATION);
    expect(spoofed.args.comment).toEqual("order:4");
    expect(spoofed.args.from).not.toEqual(merchantJettonWallet);
  });

  it("resumes after a restart from the saved cursor: nothing lost, nothing read twice", async function () {
    const merchant = await freshAddress();
    const first = await startReader(await masterchainSeqno(), { MERCHANT: [merchant.toRawString()] });
    module = first.module;

    await sendFromWallet([transfer(merchant, toNano("0.1"), false, "before")]);
    await waitFor(() => first.received.of(ContractType.MERCHANT).length === 1);
    // the cursor the app would save: the block event that follows the range with the transfer
    const beforeRange = first.received.lastSeqno;
    await waitFor(() => first.received.lastSeqno > beforeRange);
    const saved = first.received.lastSeqno;
    await first.module.close();
    module = undefined;

    // sent while the reader is down
    await sendFromWallet([transfer(merchant, toNano("0.1"), false, "while down")]);

    const second = await startReader(saved + 1, { MERCHANT: [merchant.toRawString()] });
    module = second.module;
    await waitFor(
      () => second.received.of(ContractType.MERCHANT).length === 1 && second.received.lastSeqno >= saved + 1,
    );

    expect(second.received.of(ContractType.MERCHANT).map(e => e.args.comment)).toEqual(["while down"]);
  });
});

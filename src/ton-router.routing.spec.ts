// The read cycle and routing of TonRouterService on a fake chain: the API is stubbed with blocks built here, so each case
// controls exactly which transactions are in which block.
import { jest } from "@jest/globals";
import { Controller, Injectable, Logger } from "@nestjs/common";
import type { Type } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { EventPattern, Payload } from "@nestjs/microservices";
import { CronExpression, SchedulerRegistry } from "@nestjs/schedule";
import { Address, beginCell, toNano } from "@ton/core";

import { BLOCK_EVENT, TON_API, TonEventType } from "./ton-router.constants.js";
import type { IBlockEvent, ILogEvent, ITonMessage } from "./interfaces/index.js";
import type { ITonTransaction } from "./ton-router.service.js";
import { TonRouterModule } from "./ton-router.module.js";
import { TonRouterService } from "./ton-router.service.js";
import { blockTransaction, internalMessage } from "./fixtures/transactions.js";

const SHARD = "-9223372036854775808";
const SENDER = new Address(0, Buffer.alloc(32, 1));
const MERCHANT = new Address(0, Buffer.alloc(32, 2));
const SHOP = new Address(0, Buffer.alloc(32, 3));
const DEPLOYED = new Address(0, Buffer.alloc(32, 4));
const JETTON_MASTER = new Address(0, Buffer.alloc(32, 5));
const JETTON_WALLET = new Address(0, Buffer.alloc(32, 6));

enum ContractType {
  MERCHANT = "MERCHANT",
  SHOP = "SHOP",
  DEPLOYED = "DEPLOYED",
}

// `value` nanotons from SENDER to `to`, as a transaction of `to` with logical time `lt`
const payment = (to: Address, lt: bigint, value = toNano("1")) =>
  blockTransaction({ account: to, lt, message: internalMessage({ from: SENDER, to, value }) });

type Params = Record<string, string | number>;

// TON Center v2 of a chain whose last masterchain block is `head`; `blocks` holds the transactions per block
// ("<workchain>:<seqno>"), `shardTop` the newest basechain block each masterchain block names
function fakeChain(head: number, blocks: Record<string, ITonTransaction[]>, shardTop: Record<number, number> = {}) {
  const transactions = jest.fn((params: Params) =>
    Promise.resolve({ incomplete: false, transactions: blocks[`${params.workchain}:${params.seqno}`] ?? [] }),
  );
  const masterchainInfo = jest.fn(() => Promise.resolve({ last: { workchain: -1, shard: SHARD, seqno: head } }));
  // every jetton master answers get_wallet_address with JETTON_WALLET
  const getMethod = jest.fn(() =>
    Promise.resolve({
      exit_code: 0,
      stack: [["cell", { bytes: beginCell().storeAddress(JETTON_WALLET).endCell().toBoc().toString("base64") }]],
    }),
  );
  const api = (method: string, params: Params = {}) => {
    switch (method) {
      case "getMasterchainInfo":
        return masterchainInfo();
      case "runGetMethod":
        return getMethod();
      case "shards": {
        const top = shardTop[Number(params.seqno)];
        return Promise.resolve({ shards: top === undefined ? [] : [{ workchain: 0, shard: SHARD, seqno: top }] });
      }
      // one shard, never split: the block before a shard block is the previous seqno
      case "getBlockHeader":
        return Promise.resolve({ prev_blocks: [{ workchain: 0, shard: SHARD, seqno: Number(params.seqno) - 1 }] });
      case "getBlockTransactionsExt":
        return transactions(params);
      default:
        return Promise.reject(new Error(method));
    }
  };
  return { api, transactions, masterchainInfo, getMethod };
}

@Injectable()
class Received {
  // in the order the handlers ran: "<contractType> <name> <to> <lt>" or "block <seqno>"
  public log: string[] = [];
}

const short = (address: string) => address.slice(-4);

@Controller()
class RecordingController {
  constructor(private readonly received: Received) {}

  @EventPattern(Object.values(TonEventType).map(eventName => ({ contractType: ContractType.MERCHANT, eventName })))
  public merchant(@Payload() event: ILogEvent<ITonMessage>): void {
    this.received.log.push(`MERCHANT ${event.name} ${short(event.args.to)} ${event.args.lt}`);
  }

  @EventPattern(Object.values(TonEventType).map(eventName => ({ contractType: ContractType.SHOP, eventName })))
  public shop(@Payload() event: ILogEvent<ITonMessage>): void {
    this.received.log.push(`SHOP ${event.name} ${short(event.args.to)} ${event.args.lt}`);
  }

  @EventPattern(Object.values(TonEventType).map(eventName => ({ contractType: ContractType.DEPLOYED, eventName })))
  public deployed(@Payload() event: ILogEvent<ITonMessage>): void {
    this.received.log.push(`DEPLOYED ${event.name} ${short(event.args.to)} ${event.args.lt}`);
  }

  @EventPattern({ eventName: BLOCK_EVENT })
  public block(@Payload() event: ILogEvent<IBlockEvent>): void {
    this.received.log.push(`block ${event.args.seqno}`);
  }
}

@Controller()
class NoBlockController {
  constructor(private readonly received: Received) {}

  @EventPattern({ contractType: ContractType.MERCHANT, eventName: TonEventType.TRANSFER })
  public merchant(@Payload() event: ILogEvent<ITonMessage>): void {
    this.received.log.push(`MERCHANT ${event.name} ${short(event.args.to)} ${event.args.lt}`);
  }
}

// A merchant payment "deploys" a new address: the handler registers it, as a factory event handler does on EVM
@Controller()
class RegisteringController {
  constructor(private readonly tonService: TonRouterService) {}

  @EventPattern({ contractType: ContractType.MERCHANT, eventName: TonEventType.TRANSFER })
  public merchant(): void {
    this.tonService.updateRegistry({ contractType: ContractType.DEPLOYED, contractAddress: [DEPLOYED.toString()] });
  }
}

// A handler of the merchant's transfers that fails while `failing` is set: by a rejection, or by a synchronous throw
@Injectable()
class Failure {
  public failing: "reject" | "throw" | null = "reject";
}

@Controller()
class FailingController {
  constructor(private readonly failure: Failure) {}

  @EventPattern({ contractType: ContractType.MERCHANT, eventName: TonEventType.TRANSFER })
  public merchant(): Promise<void> {
    if (this.failure.failing === "throw") {
      throw new Error("handler threw");
    }
    return this.failure.failing === "reject" ? Promise.reject(new Error("handler failed")) : Promise.resolve();
  }
}

// A block handler that fails, as a cursor save with the database down
@Controller()
class FailingBlockController {
  @EventPattern({ eventName: BLOCK_EVENT })
  public block(): Promise<void> {
    return Promise.reject(new Error("cursor not saved"));
  }
}

// The app shuts down while the first transfer is handled
@Controller()
class DestroyingController {
  constructor(
    private readonly tonService: TonRouterService,
    private readonly received: Received,
  ) {}

  @EventPattern({ contractType: ContractType.MERCHANT, eventName: TonEventType.TRANSFER })
  public merchant(@Payload() event: ILogEvent<ITonMessage>): void {
    this.received.log.push(`destroy at ${event.args.lt}`);
    this.tonService.destroy();
  }
}

async function reader(
  chain: ReturnType<typeof fakeChain>,
  controllers: Array<Type<unknown>>,
  fromSeqno = 1,
  chunkSize = 100,
) {
  const module = await Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ ignoreEnvFile: true }),
      TonRouterModule.register({ fromSeqno, chunkSize, debug: false, cron: CronExpression.EVERY_HOUR }),
    ],
    providers: [Received, Failure],
    controllers,
  })
    .overrideProvider(TON_API)
    .useValue(chain.api)
    .compile();
  const logger = module.get(Logger);
  jest.spyOn(logger, "log").mockImplementation(() => undefined);
  const error = jest.spyOn(logger, "error").mockImplementation(() => undefined);
  return { service: module.get(TonRouterService), received: module.get(Received), error, module };
}

const m = short(MERCHANT.toRawString());
const d = short(DEPLOYED.toRawString());

describe("TonRouterService routing", function () {
  // amounts, logical times and seqnos are bigints: the reader must deliver them in an app that has not patched BigInt
  // for JSON
  it("runs without a BigInt JSON patch", function () {
    expect("toJSON" in BigInt.prototype).toBe(false);
  });

  it("delivers the incoming message of a watched account, then the block event with the range's last block", async function () {
    const chain = fakeChain(3, { "-1:2": [payment(MERCHANT, 10n)] });
    const { service, received } = await reader(chain, [RecordingController]);
    service.updateRegistry({ contractType: ContractType.MERCHANT, contractAddress: [MERCHANT.toString()] });

    await service.listen();

    expect(received.log).toEqual([`MERCHANT Transfer ${m} 10`, "block 3"]);
    expect(service.getLastProcessedSeqno()).toEqual(3);
  });

  it("delivers nothing for a transaction of an account nobody watches", async function () {
    const chain = fakeChain(3, { "-1:2": [payment(SHOP, 10n)] });
    const { service, received } = await reader(chain, [RecordingController]);
    service.updateRegistry({ contractType: ContractType.MERCHANT, contractAddress: [MERCHANT.toString()] });

    await service.listen();

    expect(received.log).toEqual(["block 3"]);
  });

  it.each([
    ["raw", MERCHANT.toRawString()],
    ["bounceable", MERCHANT.toString({ bounceable: true })],
    ["non-bounceable", MERCHANT.toString({ bounceable: false })],
    ["testnet", MERCHANT.toString({ testOnly: true })],
  ])("matches an account registered in %s form", async function (_form, address) {
    const chain = fakeChain(3, { "-1:2": [payment(MERCHANT, 10n)] });
    const { service, received } = await reader(chain, [RecordingController]);
    service.updateRegistry({ contractType: ContractType.MERCHANT, contractAddress: [address] });

    await service.listen();

    expect(received.log).toEqual([`MERCHANT Transfer ${m} 10`, "block 3"]);
  });

  it("delivers a transaction to every contract type that watches its account", async function () {
    const chain = fakeChain(3, { "-1:2": [payment(MERCHANT, 10n)] });
    const { service, received } = await reader(chain, [RecordingController]);
    service.updateRegistry({ contractType: ContractType.MERCHANT, contractAddress: [MERCHANT.toString()] });
    service.updateRegistry({ contractType: ContractType.SHOP, contractAddress: [MERCHANT.toRawString()] });

    await service.listen();

    expect(received.log).toEqual([`MERCHANT Transfer ${m} 10`, `SHOP Transfer ${m} 10`, "block 3"]);
  });

  it("merges the addresses of one contract type in raw form, without duplicates", async function () {
    const { service } = await reader(fakeChain(3, {}), []);

    service.updateRegistry({ contractType: ContractType.MERCHANT, contractAddress: [MERCHANT.toString()] });
    service.updateRegistry({
      contractType: ContractType.MERCHANT,
      contractAddress: [SHOP.toString(), MERCHANT.toRawString()],
    });

    expect(service.getRegistry()).toEqual([
      { contractType: ContractType.MERCHANT, contractAddress: [MERCHANT.toRawString(), SHOP.toRawString()] },
    ]);
  });

  it("delivers the messages of an account a handler registers during the range, from the whole range, once", async function () {
    const chain = fakeChain(3, {
      // before the merchant payment that "deploys" it, and after it
      "-1:1": [payment(DEPLOYED, 5n)],
      "-1:2": [payment(MERCHANT, 10n)],
      "-1:3": [payment(DEPLOYED, 15n)],
    });
    const { service, received } = await reader(chain, [RegisteringController, RecordingController]);
    service.updateRegistry({ contractType: ContractType.MERCHANT, contractAddress: [MERCHANT.toString()] });

    await service.listen();

    expect(received.log).toEqual([
      `MERCHANT Transfer ${m} 10`,
      `DEPLOYED Transfer ${d} 5`,
      `DEPLOYED Transfer ${d} 15`,
      "block 3",
    ]);
    // the second pass routes the transactions fetched by the first: each block is fetched once
    expect(chain.transactions).toHaveBeenCalledTimes(3);
  });

  it("moves the cursor without a block handler", async function () {
    const { service } = await reader(fakeChain(3, {}), [NoBlockController]);
    service.updateRegistry({ contractType: ContractType.MERCHANT, contractAddress: [MERCHANT.toString()] });

    await service.listen();

    expect(service.getLastProcessedSeqno()).toEqual(3);
  });

  it("reads nothing while the registry is empty", async function () {
    const chain = fakeChain(3, {});
    const { service } = await reader(chain, [RecordingController]);

    await service.listen();

    expect(chain.transactions).not.toHaveBeenCalled();
    expect(service.getLastProcessedSeqno()).toEqual(-1);
  });

  it("reads nothing and keeps the cursor when the last block is behind it", async function () {
    const chain = fakeChain(3, {});
    const { service } = await reader(chain, [RecordingController], 4);
    service.updateRegistry({ contractType: ContractType.MERCHANT, contractAddress: [MERCHANT.toString()] });

    await service.listen();

    expect(chain.transactions).not.toHaveBeenCalled();
    expect(service.getLastProcessedSeqno()).toEqual(-1);
  });

  it("reads at most chunkSize masterchain blocks per run and continues after them", async function () {
    const chain = fakeChain(4, { "-1:1": [payment(MERCHANT, 10n)], "-1:4": [payment(MERCHANT, 40n)] });
    const { service, received } = await reader(chain, [RecordingController], 1, 2);
    service.updateRegistry({ contractType: ContractType.MERCHANT, contractAddress: [MERCHANT.toString()] });

    await service.listen();
    await service.listen();

    expect(received.log).toEqual([`MERCHANT Transfer ${m} 10`, "block 2", `MERCHANT Transfer ${m} 40`, "block 4"]);
  });

  it.each([
    ["rejects", "reject"],
    ["throws synchronously", "throw"],
  ] as const)(
    "a handler that %s is logged; the others still run, the cursor moves, nothing comes again",
    async function (_how, failing) {
      const chain = fakeChain(3, { "-1:2": [payment(MERCHANT, 10n)] });
      const { service, received, error, module } = await reader(chain, [FailingController, NoBlockController]);
      module.get(Failure).failing = failing;
      service.updateRegistry({ contractType: ContractType.MERCHANT, contractAddress: [MERCHANT.toString()] });

      await service.listen();
      const cursorAfterRun = service.getLastProcessedSeqno();
      // the handler recovers: the range is not read again, its events are not delivered again
      module.get(Failure).failing = null;
      await service.listen();

      expect(error).toHaveBeenCalledWith(
        new Error(failing === "throw" ? "handler threw" : "handler failed"),
        expect.any(String),
      );
      expect(cursorAfterRun).toEqual(3);
      expect(received.log).toEqual([`MERCHANT Transfer ${m} 10`]);
    },
  );

  it("moves the cursor when the block handler fails, and logs it", async function () {
    const chain = fakeChain(3, { "-1:2": [payment(MERCHANT, 10n)] });
    const { service, error } = await reader(chain, [NoBlockController, FailingBlockController]);
    service.updateRegistry({ contractType: ContractType.MERCHANT, contractAddress: [MERCHANT.toString()] });

    await service.listen();

    expect(error).toHaveBeenCalledWith(new Error("cursor not saved"), expect.any(String));
    expect(service.getLastProcessedSeqno()).toEqual(3);
  });

  it("delivers nothing when the API fails in the middle of a range, and the whole range on the next run", async function () {
    const chain = fakeChain(3, { "-1:1": [payment(MERCHANT, 10n)], "-1:3": [payment(MERCHANT, 30n)] });
    // block 1 is read, block 2 fails (a 429 of a public API)
    chain.transactions
      .mockImplementationOnce(() => Promise.resolve({ incomplete: false, transactions: [payment(MERCHANT, 10n)] }))
      .mockImplementationOnce(() => Promise.reject(new Error("429 Too Many Requests")));
    const { service, received } = await reader(chain, [RecordingController]);
    service.updateRegistry({ contractType: ContractType.MERCHANT, contractAddress: [MERCHANT.toString()] });

    const failed = await service.listen().catch((e: Error) => e.message);
    const deliveredAfterFailure = [...received.log];
    await service.listen();

    expect(failed).toEqual("429 Too Many Requests");
    expect(deliveredAfterFailure).toEqual([]);
    expect(received.log).toEqual([`MERCHANT Transfer ${m} 10`, `MERCHANT Transfer ${m} 30`, "block 3"]);
  });

  it("runs one range at a time: a second call while a run is going returns at once", async function () {
    const chain = fakeChain(3, { "-1:2": [payment(MERCHANT, 10n)] });
    const { service, received } = await reader(chain, [RecordingController]);
    service.updateRegistry({ contractType: ContractType.MERCHANT, contractAddress: [MERCHANT.toString()] });

    await Promise.all([service.listen(), service.listen()]);

    expect(chain.masterchainInfo).toHaveBeenCalledTimes(1);
    expect(received.log).toEqual([`MERCHANT Transfer ${m} 10`, "block 3"]);
  });

  it("after failed runs skips the next ticks, doubling the pause, and logs every failure", async function () {
    const chain = fakeChain(3, { "-1:2": [payment(MERCHANT, 10n)] });
    // the API is down: every run fails on the last masterchain block
    chain.masterchainInfo.mockImplementation(() => Promise.reject(new Error("API down")));
    const { service, error, module } = await reader(chain, [RecordingController]);
    service.updateRegistry({ contractType: ContractType.MERCHANT, contractAddress: [MERCHANT.toString()] });
    service.init();
    const job = [...module.get(SchedulerRegistry).getCronJobs().values()][0];
    const runFailures = () => error.mock.calls.filter(([message]) => String(message).startsWith("Run failed"));
    // a tick, and the number of failed runs to wait for after it
    const tick = async (failuresAfter: number) => {
      void job.fireOnTick();
      while (runFailures().length < failuresAfter) {
        await new Promise(resolve => setImmediate(resolve));
      }
    };

    await tick(1); // run 1 fails: skip 1 tick
    await tick(1); // skipped
    await tick(2); // run 2 fails: skip 3 ticks
    await tick(2);
    await tick(2);
    await tick(2); // skipped three times
    await tick(3); // run 3

    expect(chain.masterchainInfo).toHaveBeenCalledTimes(3);
    expect(runFailures().map(([message]) => String(message).split(":")[0])).toEqual([
      "Run failed 1 time(s) in a row, next try in 2 tick(s)",
      "Run failed 2 time(s) in a row, next try in 4 tick(s)",
      "Run failed 3 time(s) in a row, next try in 8 tick(s)",
    ]);
    service.destroy();
  });

  it("asks a jetton master for the wallet of an owner once, then keeps it", async function () {
    const chain = fakeChain(3, {});
    const { service } = await reader(chain, []);

    const first = await service.getJettonWalletAddress(JETTON_MASTER.toString(), MERCHANT.toString());
    // the same pair in other address forms
    const second = await service.getJettonWalletAddress(JETTON_MASTER.toRawString(), MERCHANT.toRawString());

    expect(first).toEqual(JETTON_WALLET.toRawString());
    expect(second).toEqual(JETTON_WALLET.toRawString());
    expect(chain.getMethod).toHaveBeenCalledTimes(1);
  });

  it("after destroy: the cron job is gone, a run stops before its next handler and keeps the cursor", async function () {
    const chain = fakeChain(3, { "-1:1": [payment(MERCHANT, 10n)], "-1:3": [payment(MERCHANT, 30n)] });
    const { service, received, module } = await reader(chain, [DestroyingController]);
    service.init();
    service.updateRegistry({ contractType: ContractType.MERCHANT, contractAddress: [MERCHANT.toString()] });

    await service.listen();

    expect(received.log).toEqual(["destroy at 10"]);
    expect(module.get(SchedulerRegistry).getCronJobs().size).toEqual(0);
    expect(service.getLastProcessedSeqno()).toEqual(-1);
  });

  it("after a failed run reads the same range again, shard blocks included", async function () {
    // masterchain block 1 names shard block 10, block 2 names shard block 12: 11 and 12 are read in the range 2..2
    const chain = fakeChain(
      2,
      { "0:11": [payment(MERCHANT, 11n)], "0:12": [payment(MERCHANT, 12n)] },
      { 1: 10, 2: 12 },
    );
    const { service, received } = await reader(chain, [RecordingController], 1, 1);
    service.updateRegistry({ contractType: ContractType.MERCHANT, contractAddress: [MERCHANT.toString()] });
    await service.listen();
    // the node fails while the range 2..2 is read
    chain.transactions.mockImplementationOnce(() => Promise.reject(new Error("node down")));

    const failed = await service.listen().catch((e: Error) => e.message);
    await service.listen();

    expect(failed).toEqual("node down");
    expect(received.log).toEqual(["block 1", `MERCHANT Transfer ${m} 11`, `MERCHANT Transfer ${m} 12`, "block 2"]);
  });
});

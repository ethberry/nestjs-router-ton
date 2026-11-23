// The read cycle and routing of TonService on a fake chain: the API is stubbed with blocks built here, so each case
// controls exactly which transactions are in which block.
import { jest } from "@jest/globals";
import { Controller, Injectable, Logger } from "@nestjs/common";
import type { Type } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { Test } from "@nestjs/testing";
import { EventPattern, Payload } from "@nestjs/microservices";
import { CronExpression } from "@nestjs/schedule";
import { Address, toNano } from "@ton/core";

import { BLOCK_EVENT, TON_API, TonEventType } from "./ton.constants.js";
import type { IBlockEvent, ILogEvent, ITonMessage } from "./interfaces/index.js";
import type { ITonTransaction } from "./ton.service.js";
import { TonModule } from "./ton.module.js";
import { TonService } from "./ton.service.js";
import { blockTransaction, internalMessage } from "./fixtures/transactions.js";

const SHARD = "-9223372036854775808";
const SENDER = new Address(0, Buffer.alloc(32, 1));
const MERCHANT = new Address(0, Buffer.alloc(32, 2));
const SHOP = new Address(0, Buffer.alloc(32, 3));
const DEPLOYED = new Address(0, Buffer.alloc(32, 4));

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
  const api = (method: string, params: Params = {}) => {
    switch (method) {
      case "getMasterchainInfo":
        return Promise.resolve({ last: { workchain: -1, shard: SHARD, seqno: head } });
      case "shards": {
        const top = shardTop[Number(params.seqno)];
        return Promise.resolve({ shards: top === undefined ? [] : [{ workchain: 0, shard: SHARD, seqno: top }] });
      }
      case "getBlockTransactionsExt":
        return transactions(params);
      default:
        return Promise.reject(new Error(method));
    }
  };
  return { api, transactions };
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
  constructor(private readonly tonService: TonService) {}

  @EventPattern({ contractType: ContractType.MERCHANT, eventName: TonEventType.TRANSFER })
  public merchant(): void {
    this.tonService.updateRegistry({ contractType: ContractType.DEPLOYED, contractAddress: [DEPLOYED.toString()] });
  }
}

// A handler of the merchant's transfers that always fails
@Controller()
class FailingController {
  @EventPattern({ contractType: ContractType.MERCHANT, eventName: TonEventType.TRANSFER })
  public merchant(): Promise<void> {
    return Promise.reject(new Error("handler failed"));
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
      TonModule.register({ fromSeqno, chunkSize, debug: false, cron: CronExpression.EVERY_HOUR }),
    ],
    providers: [Received],
    controllers,
  })
    .overrideProvider(TON_API)
    .useValue(chain.api)
    .compile();
  const logger = module.get(Logger);
  jest.spyOn(logger, "log").mockImplementation(() => undefined);
  const error = jest.spyOn(logger, "error").mockImplementation(() => undefined);
  return { service: module.get(TonService), received: module.get(Received), error };
}

const m = short(MERCHANT.toRawString());
const d = short(DEPLOYED.toRawString());

describe("TonService routing", function () {
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

  it("logs a failing handler and still runs the other handlers and moves the cursor", async function () {
    const chain = fakeChain(3, { "-1:2": [payment(MERCHANT, 10n)] });
    const { service, received, error } = await reader(chain, [FailingController, NoBlockController]);
    service.updateRegistry({ contractType: ContractType.MERCHANT, contractAddress: [MERCHANT.toString()] });

    await service.listen();

    expect(received.log).toEqual([`MERCHANT Transfer ${m} 10`]);
    expect(error).toHaveBeenCalledWith(new Error("handler failed"), expect.any(String));
    expect(service.getLastProcessedSeqno()).toEqual(3);
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

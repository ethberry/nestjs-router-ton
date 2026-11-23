import { Inject, Injectable, Logger } from "@nestjs/common";
import type { LoggerService } from "@nestjs/common";
import { DiscoveryService, MetadataScanner, Reflector } from "@nestjs/core";
import { MessageHandler } from "@nestjs/microservices";
import { transformPatternToRoute } from "@nestjs/microservices/utils/index.js";
import { PATTERN_METADATA } from "@nestjs/microservices/constants";
import { SchedulerRegistry } from "@nestjs/schedule";
import { Address, beginCell, Cell } from "@ton/core";
import { CronJob } from "cron";

import type { TonApi } from "./providers/api.js";
import { parseMessage } from "./utils/parse-message.js";
import { BLOCK_EVENT, TON_API } from "./ton.constants.js";
import { MODULE_OPTIONS_TOKEN } from "./ton.module-definition.js";
import type {
  IBlockEvent,
  IContractOptions,
  IDiscoveredHandler,
  ILogEvent,
  ITonModuleOptions,
} from "./interfaces/index.js";

const blockPattern = { eventName: BLOCK_EVENT };
// the masterchain has one shard: all bits
const MASTERCHAIN_SHARD = "-9223372036854775808";
// transactions per getBlockTransactionsExt page
const PAGE_SIZE = 256;

interface IBlockId {
  workchain: number;
  shard: string;
  seqno: number;
}

// A transaction of getBlockTransactionsExt: its account (user-friendly), id and BOC
export interface ITonTransaction {
  address: { account_address: string };
  transaction_id: { lt: string; hash: string };
  data: string;
}

// an event on its way to the handlers
interface IRoutedEvent {
  pattern: Record<string, string>;
  description: ILogEvent;
  context: unknown;
}

const blockKey = (id: IBlockId) => `${id.workchain}:${id.shard}:${id.seqno}`;

@Injectable()
export class TonService {
  private instanceId = (Math.random() + 1).toString(36).substring(7);
  private job?: CronJob;
  private running = false;
  private destroyed = false;
  private lastProcessedSeqno = -1;
  private registry: IContractOptions[] = [];

  constructor(
    @Inject(Logger)
    protected readonly loggerService: LoggerService,
    @Inject(TON_API)
    protected readonly api: TonApi,
    protected readonly discoveryService: DiscoveryService,
    protected readonly metadataScanner: MetadataScanner,
    protected readonly reflector: Reflector,
    @Inject(MODULE_OPTIONS_TOKEN)
    protected options: ITonModuleOptions,
    protected schedulerRegistry: SchedulerRegistry,
  ) {}

  public init(): void {
    this.job = new CronJob(this.options.cron, async () => {
      // if the previous run is still going - skip
      if (this.running) {
        return;
      }
      this.running = true;
      await this.listen().catch(e => this.loggerService.error(e, `${TonService.name}-${this.instanceId}`));
      this.running = false;
    });
    this.schedulerRegistry.addCronJob(`tonListener_${this.instanceId}`, this.job);
    this.job.start();
  }

  // Reads the next masterchain blocks up to the last one, with every shard block they commit, and hands the incoming
  // message of every transaction of a watched account to the handlers, one at a time in chain order. A shard block
  // committed to a masterchain block is final. The whole range is read before any handler runs, so an API error
  // delivers nothing. The cursor moves only when every handler of the range succeeded; then the block event reports
  // it. Otherwise the run throws and the next run reads the same range again: handlers must be idempotent (by lt and
  // hash).
  public async listen(): Promise<void> {
    if (!this.registry.length) {
      return;
    }

    const { last } = await this.api<{ last: IBlockId }>("getMasterchainInfo");
    const fromSeqno = this.options.fromSeqno;
    if (fromSeqno > last.seqno) {
      return;
    }
    const toSeqno = Math.min(last.seqno, fromSeqno + (this.options.chunkSize ?? 100) - 1);
    const blocks = await this.blocksOf(fromSeqno, toSeqno);

    // A handler can add to the registry while the range is processed (a deploy adds a new address): after a pass and all
    // its handlers, the range is read again for the addresses that appeared during it, until none appears. A
    // transaction has one account, so a later pass (only new addresses) never delivers it again.
    const read = new Set<string>();
    let failed = false;
    let pass = this.notRead(read);
    while (pass.length) {
      const events: IRoutedEvent[] = [];
      for (const block of blocks) {
        for (const tx of await this.transactionsOf(block)) {
          events.push(...this.route(tx, pass));
        }
      }
      for (const event of events) {
        if (this.destroyed) {
          return;
        }
        failed = !(await this.call(event)) || failed;
      }
      pass = this.notRead(read);
    }

    if (failed) {
      throw new Error(`A handler failed in blocks ${fromSeqno}..${toSeqno}: the range is read again on the next run`);
    }
    if (this.destroyed) {
      return;
    }
    const args: IBlockEvent = { seqno: toSeqno };
    const blockEvent = { pattern: blockPattern, description: { name: BLOCK_EVENT, args }, context: args };
    if (this.hasHandler(blockPattern) && !(await this.call(blockEvent))) {
      throw new Error(`The block handler failed for block ${toSeqno}: the range is read again on the next run`);
    }
    this.lastProcessedSeqno = toSeqno;
    this.options.fromSeqno = toSeqno + 1;
  }

  // Addresses are stored and matched in raw form ("0:…")
  public updateRegistry(contract: IContractOptions): void {
    const contractAddress = contract.contractAddress.map(address => Address.parse(address).toRawString());
    const entry = this.registry.find(e => e.contractType === contract.contractType);

    if (entry) {
      entry.contractAddress = [...new Set([...entry.contractAddress, ...contractAddress])];
    } else {
      this.registry.push({ ...contract, contractAddress });
    }

    this.loggerService.log(
      `TON listener updated: ${contractAddress.join(", ")}`,
      `${TonService.name}-${this.instanceId}`,
    );
  }

  public getRegistry(): IContractOptions[] {
    return this.registry;
  }

  // the last masterchain block whose transactions have all been handled, -1 before the first run
  public getLastProcessedSeqno(): number {
    return this.lastProcessedSeqno;
  }

  // The jetton wallet of `owner` for the jetton `master` (raw form), from the master's get_wallet_address. A
  // TransferNotification is real only when its `from` is this address for a master the app trusts.
  public async getJettonWalletAddress(master: string, owner: string): Promise<string> {
    const ownerSlice = beginCell().storeAddress(Address.parse(owner)).endCell().toBoc().toString("base64");
    const { exit_code, stack } = await this.api<{ exit_code: number; stack: Array<[string, { bytes: string }]> }>(
      "runGetMethod",
      {},
      { address: Address.parse(master).toString(), method: "get_wallet_address", stack: [["tvm.Slice", ownerSlice]] },
    );
    if (exit_code !== 0) {
      throw new Error(`get_wallet_address of ${master} failed with exit code ${exit_code}`);
    }
    return Cell.fromBase64(stack[0][1].bytes).beginParse().loadAddress().toRawString();
  }

  // Stops the cron job; a run in progress stops before its next handler and does not move the cursor
  public destroy(): void {
    this.destroyed = true;
    if (this.job) {
      void this.job.stop();
      this.schedulerRegistry.deleteCronJob(`tonListener_${this.instanceId}`);
    }
  }

  protected getHandlerByPattern<T extends Array<Record<string, string>>>(route: string): Array<IDiscoveredHandler<T>> {
    const methods: Array<IDiscoveredHandler<T>> = [];
    for (const wrapper of this.discoveryService.getControllers()) {
      const instance: unknown = wrapper.instance;
      if (!instance || typeof instance !== "object") {
        continue;
      }
      const prototype = Object.getPrototypeOf(instance) as Record<string, unknown>;
      for (const methodName of this.metadataScanner.getAllMethodNames(prototype)) {
        const handler = prototype[methodName];
        if (typeof handler !== "function") {
          continue;
        }
        const meta = this.reflector.get<T | undefined>(PATTERN_METADATA, handler);
        if (meta) {
          methods.push({ meta, methodName, handler: handler as IDiscoveredHandler<T>["handler"], instance });
        }
      }
    }
    return methods.filter(method => method.meta.some(meta => transformPatternToRoute(meta) === route));
  }

  // Runs every handler of the event; true when all succeeded. A handler that throws (also synchronously) or rejects is
  // logged and does not stop the others.
  protected async call({ pattern, description, context }: IRoutedEvent): Promise<boolean> {
    const route = transformPatternToRoute(pattern);
    const handlers = this.getHandlerByPattern(route);

    if (!handlers.length) {
      this.loggerService.log(`Handler not found for: ${route}`, `${TonService.name}-${this.instanceId}`);
      return true;
    }

    const results = await Promise.allSettled(
      handlers.map(({ handler, instance }) =>
        Promise.resolve().then(() => (handler.bind(instance) as MessageHandler)(description, context)),
      ),
    );
    let ok = true;
    for (const result of results) {
      if (result.status === "rejected") {
        ok = false;
        this.loggerService.error(result.reason, `${TonService.name}-${this.instanceId}`);
      }
    }
    return ok;
  }

  private hasHandler(pattern: Record<string, string>): boolean {
    return this.getHandlerByPattern(transformPatternToRoute(pattern)).length > 0;
  }

  // The masterchain blocks fromSeqno..toSeqno and every shard block they commit, oldest first. A masterchain block names
  // only the newest block of each shard; the shard blocks before it are found through their prev_blocks, back to the
  // blocks the previous masterchain block named. This holds after a restart and across shard splits and merges.
  private async blocksOf(fromSeqno: number, toSeqno: number): Promise<IBlockId[]> {
    let committed = fromSeqno > 1 ? await this.shardTops(fromSeqno - 1) : new Set<string>();
    const blocks: IBlockId[] = [];
    for (let seqno = fromSeqno; seqno <= toSeqno; seqno++) {
      blocks.push({ workchain: -1, shard: MASTERCHAIN_SHARD, seqno });
      const { shards } = await this.api<{ shards: IBlockId[] }>("shards", { seqno });
      for (const top of shards) {
        blocks.push(...(await this.shardBlocksSince(top, committed)));
      }
      committed = new Set(shards.map(blockKey));
    }
    return blocks;
  }

  private async shardTops(seqno: number): Promise<Set<string>> {
    const { shards } = await this.api<{ shards: IBlockId[] }>("shards", { seqno });
    return new Set(shards.map(blockKey));
  }

  // `top` and the shard blocks before it that are not in `committed` (named by the previous masterchain block), oldest
  // first. After a merge a block has two prev blocks; after a split two blocks share one.
  private async shardBlocksSince(top: IBlockId, committed: Set<string>): Promise<IBlockId[]> {
    const found = new Map<string, IBlockId>();
    const queue = [top];
    while (queue.length) {
      const id = queue.pop()!;
      const key = blockKey(id);
      if (committed.has(key) || found.has(key) || id.seqno <= 0) {
        continue;
      }
      found.set(key, id);
      const { prev_blocks } = await this.api<{ prev_blocks: IBlockId[] }>("getBlockHeader", {
        workchain: id.workchain,
        shard: id.shard,
        seqno: id.seqno,
      });
      queue.push(...prev_blocks);
    }
    return [...found.values()].sort((a, b) => a.seqno - b.seqno);
  }

  // All transactions of a block, page by page; a page continues after the (lt, account) of the previous page's last
  private async transactionsOf(block: IBlockId): Promise<ITonTransaction[]> {
    const transactions: ITonTransaction[] = [];
    let after: Record<string, string> = {};
    while (true) {
      const page = await this.api<{ incomplete: boolean; transactions: ITonTransaction[] }>("getBlockTransactionsExt", {
        ...block,
        count: PAGE_SIZE,
        ...after,
      });
      transactions.push(...page.transactions);
      if (!page.incomplete) {
        return transactions;
      }
      const lastTx = page.transactions[page.transactions.length - 1];
      after = {
        after_lt: lastTx.transaction_id.lt,
        after_hash: Address.parse(lastTx.address.account_address).hash.toString("hex"),
      };
    }
  }

  // the part of the registry this range has not read yet: per entry, its addresses not read; marks them read
  private notRead(read: Set<string>): IContractOptions[] {
    const pass: IContractOptions[] = [];
    for (const entry of this.registry) {
      const contractAddress = entry.contractAddress.filter(address => !read.has(`${entry.contractType} ${address}`));
      contractAddress.forEach(address => read.add(`${entry.contractType} ${address}`));
      if (contractAddress.length) {
        pass.push({ ...entry, contractAddress });
      }
    }
    return pass;
  }

  // A transaction of a watched account goes, as the event of its incoming message, to the handlers of the account's
  // contractType
  private route(tx: ITonTransaction, registry: IContractOptions[]): IRoutedEvent[] {
    const account = Address.parse(tx.address.account_address).toRawString();
    const entries = registry.filter(entry => entry.contractAddress.includes(account));
    if (!entries.length) {
      return [];
    }
    const event = parseMessage(tx.data);
    if (!event) {
      return [];
    }
    return entries.map(entry => ({
      pattern: { contractType: entry.contractType, eventName: event.name },
      description: event,
      context: tx,
    }));
  }
}

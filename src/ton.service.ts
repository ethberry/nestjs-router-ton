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

// masterchain blocks per run: about 1–2 minutes of chain, also the most a failed run reads again
const DEFAULT_CHUNK_SIZE = 20;
// the longest pause after failed runs, in cron ticks
// (an API outage is retried at least every 16 ticks once it is over)
const MAX_SKIPPED_TICKS = 15;

// The key of a block. The API may give the shard and the numbers as strings or numbers (JSON of different
// endpoints): they are normalised, or the same block would get two keys and a walk would never stop at it.
const blockKey = (id: IBlockId) => `${Number(id.workchain)}:${BigInt(id.shard)}:${Number(id.seqno)}`;

@Injectable()
export class TonService {
  private instanceId = (Math.random() + 1).toString(36).substring(7);
  private job?: CronJob;
  private running = false;
  private destroyed = false;
  // failed runs in a row, and the cron ticks still to skip after them
  private failures = 0;
  private skippedTicks = 0;
  // jetton wallet per "master owner" (raw)
  private jettonWallets = new Map<string, string>();
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

  // A run per cron tick. After a failed run the next ones are skipped, doubling (1, 3, 7… up to MAX_SKIPPED_TICKS
  // ticks), so a handler that keeps failing on one event does not hammer the API; every failure is logged with its
  // count. A successful run resets it.
  public init(): void {
    this.job = new CronJob(this.options.cron, async () => {
      // a run the app started itself is still going: not a run of this tick, it changes nothing
      if (this.running) {
        return;
      }
      if (this.skippedTicks > 0) {
        this.skippedTicks--;
        return;
      }
      await this.listen().then(
        () => {
          this.failures = 0;
        },
        (e: unknown) => {
          this.failures++;
          this.skippedTicks = Math.min(2 ** this.failures - 1, MAX_SKIPPED_TICKS);
          this.loggerService.error(
            `Run failed ${this.failures} time(s) in a row, next try in ${this.skippedTicks + 1} tick(s): ${String(e)}`,
            `${TonService.name}-${this.instanceId}`,
          );
        },
      );
    });
    this.schedulerRegistry.addCronJob(`tonListener_${this.instanceId}`, this.job);
    this.job.start();
  }

  // Reads the next masterchain blocks up to the last one, with every shard block they commit, and hands the incoming
  // message of every transaction of a watched account to the handlers, one at a time in chain order. A shard block
  // committed to a masterchain block is final. The whole range is read before any handler runs, so an API error
  // delivers nothing. The first failing handler stops the run: it throws, the cursor stays, and the next run reads the
  // same range again from its start, so the order holds and handlers must be idempotent (by lt and hash). Only one run
  // at a time: a call while a run is going returns at once.
  public async listen(): Promise<void> {
    if (this.running) {
      return;
    }
    this.running = true;
    try {
      if (!this.registry.length) {
        return;
      }

      const { last } = await this.api<{ last: IBlockId }>("getMasterchainInfo");
      const fromSeqno = this.options.fromSeqno;
      if (fromSeqno > last.seqno) {
        return;
      }
      const toSeqno = Math.min(last.seqno, fromSeqno + (this.options.chunkSize ?? DEFAULT_CHUNK_SIZE) - 1);
      const blocks = await this.blocksOf(fromSeqno, toSeqno);

      // A handler can add to the registry while the range is processed (a deploy adds a new address): after a pass and all
      // its handlers, the range is read again for the addresses that appeared during it, until none appears. The blocks'
      // transactions are fetched once per run. A transaction has one account, so a later pass (only new addresses) never
      // delivers it again.
      const transactions = new Map<string, ITonTransaction[]>();
      const read = new Set<string>();
      let pass = this.notRead(read);
      while (pass.length) {
        const events: IRoutedEvent[] = [];
        for (const block of blocks) {
          const key = blockKey(block);
          const txs = transactions.get(key) ?? (await this.transactionsOf(block));
          transactions.set(key, txs);
          for (const tx of txs) {
            events.push(...this.route(tx, pass));
          }
        }
        for (const event of events) {
          if (this.destroyed) {
            return;
          }
          if (!(await this.call(event))) {
            throw new Error(
              `A handler failed in blocks ${fromSeqno}..${toSeqno}: the range is read again on the next run`,
            );
          }
        }
        pass = this.notRead(read);
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
    } finally {
      this.running = false;
    }
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
  // TransferNotification is real only when its `from` is this address for a master the app trusts. The address never
  // changes for a (master, owner) pair, so it is asked once and kept.
  public async getJettonWalletAddress(master: string, owner: string): Promise<string> {
    const key = `${Address.parse(master).toRawString()} ${Address.parse(owner).toRawString()}`;
    const known = this.jettonWallets.get(key);
    if (known) {
      return known;
    }
    const ownerSlice = beginCell().storeAddress(Address.parse(owner)).endCell().toBoc().toString("base64");
    const { exit_code, stack } = await this.api<{ exit_code: number; stack: Array<[string, { bytes: string }]> }>(
      "runGetMethod",
      {},
      { address: Address.parse(master).toString(), method: "get_wallet_address", stack: [["tvm.Slice", ownerSlice]] },
    );
    if (exit_code !== 0) {
      throw new Error(`get_wallet_address of ${master} failed with exit code ${exit_code}`);
    }
    const wallet = Cell.fromBase64(stack[0][1].bytes).beginParse().loadAddress().toRawString();
    this.jettonWallets.set(key, wallet);
    return wallet;
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
    let committed = fromSeqno > 1 ? await this.shardTops(fromSeqno - 1) : [];
    const blocks: IBlockId[] = [];
    for (let seqno = fromSeqno; seqno <= toSeqno; seqno++) {
      blocks.push({ workchain: -1, shard: MASTERCHAIN_SHARD, seqno });
      const shards = await this.shardTops(seqno);
      blocks.push(...(await this.shardBlocksSince(shards, committed)));
      committed = shards;
    }
    return blocks;
  }

  private async shardTops(seqno: number): Promise<IBlockId[]> {
    const { shards } = await this.api<{ shards: IBlockId[] }>("shards", { seqno });
    return shards;
  }

  // The shard blocks a masterchain block commits: its `tops` and the blocks before them that the previous masterchain
  // block did not commit, oldest first. One walk for all tops: after a split both new shards lead back to their parent
  // block, which is taken once; after a merge a block has two prev blocks. The walk stops at a committed block, and
  // below the lowest committed seqno of the workchain (seqnos only grow along a shard's chain).
  private async shardBlocksSince(tops: IBlockId[], committed: IBlockId[]): Promise<IBlockId[]> {
    const committedKeys = new Set(committed.map(blockKey));
    const floor = new Map<number, number>();
    for (const id of committed) {
      floor.set(Number(id.workchain), Math.min(floor.get(Number(id.workchain)) ?? Infinity, Number(id.seqno)));
    }
    const found = new Map<string, IBlockId>();
    const queue = [...tops];
    while (queue.length) {
      const id = queue.pop()!;
      const key = blockKey(id);
      const seqno = Number(id.seqno);
      if (committedKeys.has(key) || found.has(key) || seqno <= 0 || seqno < (floor.get(Number(id.workchain)) ?? 0)) {
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
    // oldest first; blocks of one seqno (sibling shards) by shard, so the order is the same on every run
    return [...found.values()].sort(
      (a, b) => Number(a.seqno) - Number(b.seqno) || (BigInt(a.shard) < BigInt(b.shard) ? -1 : 1),
    );
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

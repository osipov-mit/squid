import {createLogger, Logger} from "@subsquid/logger"
import {getOldTypesBundle, OldTypesBundle, QualifiedName, readOldTypesBundle} from "@subsquid/substrate-metadata"
import {assertNotNull, def, runProgram, unexpectedCase} from "@subsquid/util-internal"
import assert from "assert"
import {applyRangeBound, Batch, mergeBatches} from "../batch/generic"
import {CallHandlerEntry, DataHandlers} from "../batch/handlers"
import type {Chain} from "../chain"
import type {BlockData} from "../ingest"
import type {
    BlockHandler,
    BlockHandlerContext,
    BlockHandlerDataRequest,
    BlockRangeOption,
    CallHandler,
    CallHandlerOptions,
    CommonHandlerContext,
    ContractsContractEmittedHandler,
    EventHandler,
    EvmLogHandler,
    EvmLogOptions,
    EvmTopicSet,
    GearMessageEnqueuedHandler,
    GearUserMessageSentHandler,
} from "../interfaces/dataHandlers"
import type {
    CallDataRequest,
    DataSelection,
    EventDataRequest,
    MayBeDataSelection,
    NoDataSelection
} from "../interfaces/dataSelection"
import type {Database} from "../interfaces/db"
import type {Hooks} from "../interfaces/hooks"
import type {
    ContractsContractEmittedEvent,
    GearMessageEnqueuedEvent,
    GearUserMessageSentEvent,
    EvmLogEvent,
    SubstrateCall,
    SubstrateEvent
} from "../interfaces/substrate"
import {withErrorContext} from "../util/misc"
import type {Range} from "../util/range"
import {Options, Runner} from "./runner"


export interface DataSource {
    /**
     * Subsquid substrate archive endpoint URL
     */
    archive: string
    /**
     * Chain node RPC websocket URL
     */
    chain?: string
}


/**
 * Provides methods to configure and launch data processing.
 */
export class SubstrateProcessor<Store> {
    protected hooks: Hooks = {
        pre: [],
        post: [],
        event: [],
        call: [],
        evmLog: [],
        contractsContractEmitted: [],
        gearMessageEnqueued: [],
        gearUserMessageSent: [],
    }
    private blockRange: Range = {from: 0}
    private batchSize = 100
    private prometheusPort?: number | string
    private src?: DataSource
    private typesBundle?: OldTypesBundle
    private running = false

    /**
     * @param db - database is responsible for providing storage to data handlers
     * and persisting mapping progress and status.
     */
    constructor(private db: Database<Store>) {}

    /**
     * Sets blockchain data source.
     *
     * @example
     * processor.setDataSource({
     *     chain: 'wss://rpc.polkadot.io',
     *     archive: 'https://polkadot.indexer.gc.subsquid.io/v4/graphql'
     * })
     */
    setDataSource(src: DataSource): this {
        this.assertNotRunning()
        this.src = src
        return this
    }

    /**
     * Sets types bundle.
     *
     * Types bundle is only required for blocks which have
     * metadata version below 14 and only if we don't have built-in
     * support for the chain in question.
     *
     * Don't confuse this setting with types bundle from polkadot.js.
     * Although those two are similar in purpose and structure,
     * they are not compatible.
     *
     * Types bundle can be specified in 3 different ways:
     *
     * 1. as a name of a known chain
     * 2. as a name of a JSON file structured as {@link OldTypesBundle}
     * 3. as an {@link OldTypesBundle} object
     *
     * @example
     * // known chain
     * processor.setTypesBundle('kusama')
     *
     * // A path to a JSON file resolved relative to `cwd`.
     * processor.setTypesBundle('typesBundle.json')
     *
     * // OldTypesBundle object
     * processor.setTypesBundle({
     *     types: {
     *         Foo: 'u8'
     *     }
     * })
     */
    setTypesBundle(bundle: string | OldTypesBundle): this {
        this.assertNotRunning()
        if (typeof bundle == 'string') {
            this.typesBundle = getOldTypesBundle(bundle) || readOldTypesBundle(bundle)
        } else {
            this.typesBundle = bundle
        }
        return this
    }

    /**
     * Limits the range of blocks to be processed.
     *
     * When the upper bound is specified,
     * the processor will terminate with exit code 0 once it reaches it.
     *
     * @example
     * // process only block 100
     * processor.setBlockRange({
     *     from: 100,
     *     to: 100
     * })
     */
    setBlockRange(range: Range): this {
        this.assertNotRunning()
        this.blockRange = range
        return this
    }

    /**
     * Sets the maximum number of blocks which can be fetched
     * from the data source in a single request.
     *
     * The default is 100.
     *
     * Usually this setting doesn't have any significant impact on the performance.
     */
    setBatchSize(size: number): this {
        this.assertNotRunning()
        assert(size > 0)
        this.batchSize = size
        return this
    }

    /**
     * Sets the port for a built-in prometheus metrics server.
     *
     * By default, the value of `PROMETHEUS_PORT` environment
     * variable is used. When it is not set,
     * the processor will pick up an ephemeral port.
     */
    setPrometheusPort(port: number | string): this {
        this.assertNotRunning()
        this.prometheusPort = port
        return this
    }

    /**
     * Registers a block level data handler which will be executed before
     * any further processing.
     *
     * See {@link BlockHandlerContext} for an API available to the handler.
     *
     * Like event and call handlers block level handler can request a specific
     * set of data to be fetched by the processor, but unlike them,
     * it is triggered for all fetched blocks.
     *
     * When data selection option is not specified,
     * block handler will be triggered for all chain blocks, those
     * causing the processor to fetch all of them.
     * This behaviour can be modified via {@link BlockHandlerDataRequest.includeAllBlocks | .data.includeAllBlocks} option.
     *
     * Relative execution order for multiple pre-block hooks is currently not defined.
     *
     * @example
     * // print heights of all chain blocks
     * processor.addPreHook(async ctx => {
     *     console.log(ctx.block.height)
     * })
     *
     * // print heights of all blocks starting from block 100000
     * processor.addPreHook({range: {from: 100000}}, async ctx => {
     *     console.log(ctx.block.height)
     * })
     *
     * // print all `Balances.Transfer` events
     * processor.addPreHook({
     *     data: {
     *         items: {
     *             events: {
     *                 'Balances.Transfer': {args: true}
     *             }
     *         }
     *     }
     * } as const, async ctx => {
     *     ctx.items.forEach(item => {
     *         if (item.name === 'Balances.Transfer') {
     *             console.log(item.event.args)
     *         }
     *     })
     * })
     *
     * // print names of all events
     * processor.addPreHook({
     *     data: {
     *        items: {
     *             events: {
     *                 '*': {}
     *             }
     *         }
     *     }
     * } as const, async ctx => {
     *     ctx.items.forEach(item => {
     *         if (item.kind == 'event) {
     *             console.log(item.event.name)
     *         }
     *     })
     * })
     */
    addPreHook(fn: BlockHandler<Store>): this
    addPreHook(options: BlockRangeOption & NoDataSelection, fn: BlockHandler<Store>): this
    addPreHook<R extends BlockHandlerDataRequest>(options: BlockRangeOption & DataSelection<R>, fn: BlockHandler<Store, R>): this
    addPreHook(fnOrOptions: BlockHandler<Store> | BlockRangeOption & MayBeDataSelection<BlockHandlerDataRequest> , fn?: BlockHandler<Store>): this {
        this.assertNotRunning()
        let handler: BlockHandler<Store>
        let options: BlockRangeOption & MayBeDataSelection<BlockHandlerDataRequest> = {}
        if (typeof fnOrOptions == 'function') {
            handler = fnOrOptions
        } else {
            handler = assertNotNull(fn)
            options = fnOrOptions
        }
        this.hooks.pre.push({handler, ...options})
        return this
    }

    /**
     * Registers a block level data handler which will be executed
     * at the end of processing.
     *
     * See {@link BlockHandlerContext} for an API available to the handler.
     *
     * Like event and call handlers, block level handler can request a specific
     * set of data to be fetched by the processor, but unlike them,
     * it is triggered for all fetched blocks.
     *
     * When data selection option is not specified,
     * block handler will be triggered for all chain blocks, those
     * causing the processor to fetch all of them.
     * This behaviour can be modified via {@link BlockHandlerDataRequest.includeAllBlocks | .data.includeAllBlocks} option.
     *
     * @example
     * // print heights of all chain blocks
     * processor.addPostHook(async ctx => {
     *     console.log(ctx.block.height)
     * })
     *
     * // print heights of all blocks starting from block 100000
     * processor.addPostHook({range: {from: 100000}}, async ctx => {
     *     console.log(ctx.block.height)
     * })
     *
     * // print all `Balances.Transfer` events
     * processor.addPostHook({
     *     data: {
     *         items: {
     *             events: {
     *                 'Balances.Transfer': {args: true}
     *             }
     *         }
     *     }
     * } as const, async ctx => {
     *     ctx.items.forEach(item => {
     *         if (item.name === 'Balances.Transfer') {
     *             console.log(item.event.args)
     *         }
     *     })
     * })
     *
     * // print names of all events
     * processor.addPostHook({
     *     data: {
     *        items: {
     *             events: {
     *                 '*': {}
     *             }
     *         }
     *     }
     * } as const, async ctx => {
     *     ctx.items.forEach(item => {
     *         if (item.kind == 'event) {
     *             console.log(item.event.name)
     *         }
     *     })
     * })
     */
    addPostHook(fn: BlockHandler<Store>): this
    addPostHook(options: BlockRangeOption, fn: BlockHandler<Store>): this
    addPostHook<R extends BlockHandlerDataRequest>(options: BlockRangeOption & DataSelection<R>, fn: BlockHandler<Store, R>): this
    addPostHook(fnOrOptions: BlockHandler<Store> | BlockRangeOption & MayBeDataSelection<BlockHandlerDataRequest>, fn?: BlockHandler<Store>): this {
        this.assertNotRunning()
        let handler: BlockHandler<Store>
        let options: BlockRangeOption & MayBeDataSelection<BlockHandlerDataRequest> = {}
        if (typeof fnOrOptions == 'function') {
            handler = fnOrOptions
        } else {
            handler = assertNotNull(fn)
            options = fnOrOptions
        }
        this.hooks.post.push({handler, ...options})
        return this
    }

    /**
     * Registers an event data handler.
     *
     * See {@link EventHandlerContext} for an API available to the handler.
     *
     * All calls are processed sequentially according to their position in unified
     * log of events and calls. All events deposited within a call are placed
     * before the call. All child calls are placed before the parent call.
     * List of block events is a subsequence of unified log.
     *
     * Relative execution order is currently not defined for multiple event handlers
     * registered for the same event.
     *
     * @example
     * processor.addEventHandler('Balances.Transfer', async ctx => {
     *     assert(ctx.event.name == 'Balances.Transfer')
     * })
     *
     * // limit the range of blocks for which event handler will be effective
     * processor.addEventHandler('Balances.Transfer', {
     *     range: {from: 100000}
     * }, async ctx => {
     *     assert(ctx.event.name == 'Balances.Transfer')
     * })
     *
     * // request only subset of event data for faster ingestion times
     * processor.addEventHandler('Balances.Transfer', {
     *     data: {
     *         event: {args: true}
     *     }
     * } as const, async ctx => {})
     */
    addEventHandler(eventName: QualifiedName, fn: EventHandler<Store>): this
    addEventHandler(eventName: QualifiedName, options: BlockRangeOption & NoDataSelection, fn: EventHandler<Store>): this
    addEventHandler<R extends EventDataRequest>(eventName: QualifiedName, options: BlockRangeOption & DataSelection<R>, fn: EventHandler<Store, R> ): this
    addEventHandler(eventName: QualifiedName, fnOrOptions: BlockRangeOption & MayBeDataSelection<EventDataRequest> | EventHandler<Store>, fn?: EventHandler<Store>): this {
        this.assertNotRunning()
        let handler: EventHandler<Store>
        let options: BlockRangeOption & MayBeDataSelection<EventDataRequest> = {}
        if (typeof fnOrOptions === 'function') {
            handler = fnOrOptions
        } else {
            handler = assertNotNull(fn)
            options = fnOrOptions
        }
        this.hooks.event.push({
            event: eventName,
            handler,
            ...options
        })
        return this
    }

    /**
     * Registers a call data handler.
     *
     * See {@link CallHandlerContext} for an API available to the handler.
     *
     * Note, that by default, only successful calls will be handled.
     * This can be overwritten via `.triggerForFailedCalls` option.
     *
     * All calls are processed sequentially according to their position in unified
     * log of events and calls. All events deposited within a call are placed
     * before the call. All child calls are placed before the parent call.
     * List of block events is a subsequence of unified log.
     *
     * Relative execution order is currently not defined for multiple call handlers
     * registered for the same call.
     *
     * @example
     * processor.addCallHandler('Balances.transfer', async ctx => {
     *     assert(ctx.event.name == 'Balances.transfer')
     * })
     *
     * // limit the range of blocks for which event handler will be effective
     * processor.addCallHandler('Balances.transfer', {
     *     range: {from: 100000}
     * }, async ctx => {
     *     assert(ctx.event.name == 'Balances.transfer')
     * })
     *
     * // request only subset of call data for faster ingestion times
     * processor.addCallHandler('Balances.transfer', {
     *     data: {
     *         call: {args: true},
     *         extrinsic: {signature: true}
     *     }
     * } as const, async ctx => {})
     */
    addCallHandler(callName: QualifiedName, fn: CallHandler<Store>): this
    addCallHandler(callName: QualifiedName, options: CallHandlerOptions & NoDataSelection, fn: CallHandler<Store>): this
    addCallHandler<R extends CallDataRequest>(callName: QualifiedName, options: CallHandlerOptions & DataSelection<R>, fn: CallHandler<Store, R>): this
    addCallHandler(callName: QualifiedName, fnOrOptions: CallHandler<Store> | CallHandlerOptions & MayBeDataSelection<CallDataRequest>, fn?: CallHandler<Store>): this {
        this.assertNotRunning()
        let handler: CallHandler<Store>
        let options:  CallHandlerOptions & MayBeDataSelection<CallDataRequest> = {}
        if (typeof fnOrOptions == 'function') {
            handler = fnOrOptions
        } else {
            handler = assertNotNull(fn)
            options = {...fnOrOptions}
        }
        this.hooks.call.push({
            call: callName,
            handler,
            ...options
        })
        return this
    }

    /**
     * Registers `EVM.Log` event handler.
     *
     * This method is similar to {@link .addEventHandler},
     * but provides specialised {@link EvmLogEvent | event type} and selects
     * events by evm log contract address and topics.
     *
     * @example
     * // process ERC721 transfers from Moonsama contract
     * processor.addEvmLogHandler('0xb654611f84a8dc429ba3cb4fda9fad236c505a1a', {
     *     topics: ['0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef']
     * }, async ctx => {})
     */
    addEvmLogHandler(
        contractAddress: string,
        fn: EvmLogHandler<Store>
    ): this
    addEvmLogHandler(
        contractAddress: string,
        options: EvmLogOptions & NoDataSelection,
        fn: EvmLogHandler<Store>
    ): this
    addEvmLogHandler<R extends EventDataRequest>(
        contractAddress: string,
        options: EvmLogOptions & DataSelection<R>,
        fn: EvmLogHandler<Store, R>
    ): this
    addEvmLogHandler(
        contractAddress: string,
        fnOrOptions: EvmLogOptions & MayBeDataSelection<EventDataRequest> | EvmLogHandler<Store>,
        fn?: EvmLogHandler<Store>
    ): this {
        this.assertNotRunning()
        let handler: EvmLogHandler<Store>
        let options:  EvmLogOptions= {}
        if (typeof fnOrOptions == 'function') {
            handler = fnOrOptions
        } else {
            handler = assertNotNull(fn)
            options = {...fnOrOptions}
        }
        this.hooks.evmLog.push({
            handler,
            contractAddress: contractAddress.toLowerCase(),
            ...options
        })
        return this
    }

    /**
     * Registers `Contracts.ContractEmitted` event handler.
     *
     * This method is similar to {@link .addEventHandler},
     * but provides specialised {@link ContractsContractEmittedEvent | event type} and selects
     * events by contract address.
     */
    addContractsContractEmittedHandler(
        contractAddress: string,
        fn: ContractsContractEmittedHandler<Store>
    ): this
    addContractsContractEmittedHandler(
        contractAddress: string,
        options: BlockRangeOption & NoDataSelection,
        fn: ContractsContractEmittedHandler<Store>
    ): this
    addContractsContractEmittedHandler<R extends EventDataRequest>(
        contractAddress: string,
        options: BlockRangeOption & DataSelection<R>,
        fn: ContractsContractEmittedHandler<Store, R>
    ): this
    addContractsContractEmittedHandler(
        contractAddress: string,
        fnOrOptions: ContractsContractEmittedHandler<Store> | BlockRangeOption & MayBeDataSelection<EventDataRequest>,
        fn?: ContractsContractEmittedHandler<Store>
    ): this {
        this.assertNotRunning()
        let handler: ContractsContractEmittedHandler<Store>
        let options: BlockRangeOption & MayBeDataSelection<EventDataRequest> = {}
        if (typeof fnOrOptions == 'function') {
            handler = fnOrOptions
        } else {
            handler = assertNotNull(fn)
            options = {...fnOrOptions}
        }
        this.hooks.contractsContractEmitted.push({
            handler,
            contractAddress: contractAddress.toLowerCase(),
            ...options
        })
        return this
    }

    /**
     * Registers `Gear.MessageEnqueued` event handler.
     *
     * This method is similar to {@link .addEventHandler},
     * but provides specialised {@link GearMessageEnqueuedEvent | event type} and selects
     * events by program id.
     */
    addGearMessageEnqueuedHandler(
        programId: string,
        fn: GearMessageEnqueuedHandler<Store>
    ): this
    addGearMessageEnqueuedHandler(
        programId: string,
        options: BlockRangeOption & NoDataSelection,
        fn: GearMessageEnqueuedHandler<Store>
    ): this
    addGearMessageEnqueuedHandler<R extends EventDataRequest>(
        programId: string,
        options: BlockRangeOption & DataSelection<R>,
        fn: GearMessageEnqueuedHandler<Store, R>
    ): this
    addGearMessageEnqueuedHandler(
        programId: string,
        fnOrOptions: GearMessageEnqueuedHandler<Store> | BlockRangeOption & MayBeDataSelection<EventDataRequest>,
        fn?: GearMessageEnqueuedHandler<Store>
    ): this {
        this.assertNotRunning()
        let handler: GearMessageEnqueuedHandler<Store>
        let options: BlockRangeOption & MayBeDataSelection<EventDataRequest> = {}
        if (typeof fnOrOptions == 'function') {
            handler = fnOrOptions
        } else {
            handler = assertNotNull(fn)
            options = {...fnOrOptions}
        }
        this.hooks.gearMessageEnqueued.push({
            handler,
            programId,
            ...options
        })
        return this
    }

    /**
     * Registers `Gear.UserMessageSent` event handler.
     *
     * This method is similar to {@link .addEventHandler},
     * but provides specialised {@link GearUserMessageSentEvent | event type} and selects
     * events by program id.
     */
    addGearUserMessageSentHandler(
        programId: string,
        fn: GearUserMessageSentHandler<Store>
    ): this
    addGearUserMessageSentHandler(
        programId: string,
        options: BlockRangeOption & NoDataSelection,
        fn: GearUserMessageSentHandler<Store>
    ): this
    addGearUserMessageSentHandler<R extends EventDataRequest>(
        programId: string,
        options: BlockRangeOption & DataSelection<R>,
        fn: GearUserMessageSentHandler<Store, R>
    ): this
    addGearUserMessageSentHandler(
        programId: string,
        fnOrOptions: GearUserMessageSentHandler<Store> | BlockRangeOption & MayBeDataSelection<EventDataRequest>,
        fn?: GearUserMessageSentHandler<Store>
    ): this{
        this.assertNotRunning()
        let handler: GearUserMessageSentHandler<Store>
        let options: BlockRangeOption & MayBeDataSelection<EventDataRequest> = {}
        if (typeof fnOrOptions == 'function') {
            handler = fnOrOptions
        } else {
            handler = assertNotNull(fn)
            options = {...fnOrOptions}
        }
        this.hooks.gearUserMessageSent.push({
            handler,
            programId,
            ...options
        })
        return this
    }

    protected assertNotRunning(): void {
        if (this.running) {
            throw new Error('Settings modifications are not allowed after start of processing')
        }
    }

    private createBatches(blockRange: Range) {
        let batches: Batch<DataHandlers>[] = []

        function getRange(hook: { range?: Range }): Range{
            return hook.range || {from: 0}
        }

        this.hooks.pre.forEach(hook => {
            let range = getRange(hook)
            let request = new DataHandlers()
            request.pre = {handlers: [hook.handler], data: hook.data}
            batches.push({range, request})
        })

        this.hooks.post.forEach(hook => {
            let range = getRange(hook)
            let request = new DataHandlers()
            request.post = {handlers: [hook.handler], data: hook.data}
            batches.push({range, request})
        })

        this.hooks.event.forEach(hook => {
            let range = getRange(hook)
            let request = new DataHandlers()
            request.events = {
                [hook.event]: {data: hook.data, handlers: [hook.handler]}
            }
            batches.push({range, request})
        })

        this.hooks.call.forEach(hook => {
            let range = getRange(hook)
            let request = new DataHandlers()
            request.calls = {
                [hook.call]: {
                    data: hook.data,
                    handlers: [{
                        handler: hook.handler,
                        triggerForFailedCalls: hook.triggerForFailedCalls
                    }]
                }
            }
            batches.push({range, request})
        })

        this.hooks.evmLog.forEach(hook => {
            let range = getRange(hook)
            let request = new DataHandlers()
            request.evmLogs = {
                [hook.contractAddress]: [{
                    filter: hook.filter,
                    handler: hook.handler
                }]
            }
            batches.push({range, request})
        })

        this.hooks.contractsContractEmitted.forEach(hook => {
            let range = getRange(hook)
            let request = new DataHandlers()
            request.contractsContractEmitted = {
                [hook.contractAddress]: {data: hook.data, handlers: [hook.handler]}
            }
            batches.push({range, request})
        })

        this.hooks.gearMessageEnqueued.forEach(hook => {
            let range = getRange(hook)
            let request = new DataHandlers()
            request.gearMessageEnqueued = {
                [hook.programId]: {data: hook.data, handlers: [hook.handler]}
            }
            batches.push({range, request})
        })

        this.hooks.gearUserMessageSent.forEach(hook => {
            let range = getRange(hook)
            let request = new DataHandlers()
            request.gearUserMessageSent = {
                [hook.programId]: {data: hook.data, handlers: [hook.handler]}
            }
            batches.push({range, request})
        })

        batches = applyRangeBound(batches, blockRange)

        return mergeBatches(batches, (a, b) => a.merge(b))
    }

    @def
    private getLogger(): Logger {
        return createLogger('sqd:processor')
    }

    @def
    private getOptions(): Options {
        return {
            blockRange: this.blockRange,
            prometheusPort: this.prometheusPort,
            batchSize: this.batchSize
        }
    }

    private getDatabase() {
        return this.db
    }

    private getTypesBundle(specName: string, specVersion: number): OldTypesBundle {
        let bundle = this.typesBundle || getOldTypesBundle(specName)
        if (bundle) return bundle
        throw new Error(`Types bundle is required for ${specName}@${specVersion}. Provide it via .setTypesBundle()`)
    }

    private getArchiveEndpoint(): string {
        let url = this.src?.archive
        if (url == null) {
            throw new Error('use .setDataSource() to specify archive url')
        }
        return url
    }

    private getChainEndpoint(): string {
        let url = this.src?.chain
        if (url == null) {
            throw new Error(`use .setDataSource() to specify chain RPC endpoint`)
        }
        return url
    }

    /**
     * Starts data processing.
     *
     * This method assumes full control over the current OS process as
     * it terminates the entire program in case of error or
     * at the end of data processing.
     */
    run(): void {
        if (this.running) return
        this.running = true
        runProgram(async () => {
            return new HandlerRunner(this as any).run()
        }, err => {
            this.getLogger().fatal(err)
        })
    }
}


class HandlerRunner<S> extends Runner<S, DataHandlers>{
    async processBatch(handlers: DataHandlers, chain: Chain, blocks: BlockData[]): Promise<void> {
        for (let block of blocks) {
            assert(this.lastBlock < block.header.height)
            let height = block.header.height
            await this.config.getDatabase().transact(height, height, store => {
                return this.processBlock(handlers, chain, store, block)
            }).catch(
                withErrorContext({
                    blockHeight: block.header.height,
                    blockHash: block.header.hash
                })
            )
            this.lastBlock = block.header.height
        }
    }

    private async processBlock(
        handlers: DataHandlers,
        chain: Chain,
        store: S,
        block: BlockData
    ): Promise<void> {
        let blockLog = this.config.getLogger().child('mapping', {
            blockHeight: block.header.height,
            blockHash: block.header.hash
        })

        let ctx: CommonHandlerContext<S> = {
            _chain: chain,
            log: blockLog.child({hook: 'pre'}),
            store,
            block: block.header
        }

        for (let pre of handlers.pre.handlers) {
            ctx.log.debug('begin')
            await pre({...ctx, items: block.items})
            ctx.log.debug('end')
        }

        for (let item of block.items) {
            switch(item.kind) {
                case 'event':
                    for (let handler of this.getEventHandlers(handlers, item.event)) {
                        let log = blockLog.child({
                            hook: 'event',
                            eventName: item.event.name,
                            eventId: item.event.id
                        })
                        log.debug('begin')
                        await handler({...ctx, log, event: item.event})
                        log.debug('end')
                    }
                    for (let handler of this.getEvmLogHandlers(handlers.evmLogs, item.event)) {
                        let event = item.event as EvmLogEvent
                        let log = blockLog.child({
                            hook: 'evm-log',
                            contractAddress: event.args.address || event.args.log.address,
                            eventId: event.id
                        })
                        log.debug('begin')
                        await handler({
                            ...ctx,
                            log,
                            event
                        })
                        log.debug('end')
                    }
                    for (let handler of this.getContractEmittedHandlers(handlers, item.event)) {
                        let event = item.event as ContractsContractEmittedEvent
                        let log = blockLog.child({
                            hook: 'contract-emitted',
                            contractAddress: event.args.contract,
                            eventId: event.id
                        })
                        log.debug('begin')
                        await handler({
                            ...ctx,
                            log,
                            event
                        })
                        log.debug('end')
                    }
                    for (let handler of this.getGearMessageEnqueuedHandlers(handlers, item.event)) {
                        let event = item.event as GearMessageEnqueuedEvent
                        let log = blockLog.child({
                            hook: 'gear-message-enqueued',
                            programId: event.args.destination,
                            eventId: event.id
                        })
                        log.debug('begin')
                        await handler({
                            ...ctx,
                            log,
                            event
                        })
                        log.debug('end')
                    }
                    for (let handler of this.getGearUserMessageSentHandlers(handlers, item.event)) {
                        let event = item.event as GearUserMessageSentEvent
                        let log = blockLog.child({
                            hook: 'gear-message-sent',
                            programId: event.args.message.source,
                            eventId: event.id
                        })
                        log.debug('begin')
                        await handler({
                            ...ctx,
                            log,
                            event
                        })
                        log.debug('end')
                    }
                    break
                case 'call':
                    for (let handler of this.getCallHandlers(handlers, item.call)) {
                        if (item.call.success || handler.triggerForFailedCalls) {
                            let log = blockLog.child({
                                hook: 'call',
                                callName: item.call.name,
                                callId: item.call.id
                            })
                            let {kind, ...data} = item
                            log.debug('begin')
                            await handler.handler({...ctx, log, ...data})
                            log.debug('end')
                        }
                    }
                    break
                default:
                    throw unexpectedCase()
            }
        }

        ctx.log = blockLog.child({hook: 'post'})

        for (let post of handlers.post.handlers) {
            ctx.log.debug('begin')
            await post({...ctx, items: block.items})
            ctx.log.debug('end')
        }
    }

    private *getEventHandlers(handlers: DataHandlers, event: SubstrateEvent): Generator<EventHandler<any>, any, any> {
        let hs = handlers.events['*']
        if (hs) {
            yield* hs.handlers
        }
        hs = handlers.events[event.name]
        if (hs) {
            yield* hs.handlers
        }
    }

    private *getCallHandlers(handlers: DataHandlers, call: SubstrateCall): Generator<CallHandlerEntry, any, any> {
        let hs = handlers.calls['*']
        if (hs) {
            yield* hs.handlers
        }
        hs = handlers.calls[call.name]
        if (hs) {
            yield* hs.handlers
        }
    }

    private *getEvmLogHandlers(evmLogs: DataHandlers["evmLogs"], event: SubstrateEvent): Generator<EvmLogHandler<any>> {
        if (event.name != 'EVM.Log') return
        let log = event as EvmLogEvent

        let contractAddress = assertNotNull(log.args.address || log.args.log.address)
        let contractHandlers = evmLogs[contractAddress]
        if (contractHandlers == null) return

        for (let h of contractHandlers) {
            if (this.evmHandlerMatches(h, log)) {
                yield h.handler
            }
        }
    }

    private evmHandlerMatches(handler: {filter?: EvmTopicSet[]}, log: EvmLogEvent): boolean {
        if (handler.filter == null) return true
        for (let i = 0; i < handler.filter.length; i++) {
            let set = handler.filter[i]
            if (set == null) continue
            if (Array.isArray(set)) {
                if (!set.includes(log.args.topics[i])) {
                    return false
                }
            } else if (set !== log.args.topics[i]) {
                return false
            }
        }
        return true
    }

    private *getContractEmittedHandlers(handlers: DataHandlers, event: SubstrateEvent): Generator<ContractsContractEmittedHandler<any>> {
        if (event.name != 'Contracts.ContractEmitted') return
        let e = event as ContractsContractEmittedEvent

        let hs = handlers.contractsContractEmitted[e.args.contract]
        if (hs == null) return

        for (let h of hs.handlers) {
            yield h
        }
    }

    private *getGearMessageEnqueuedHandlers(handlers: DataHandlers, event: SubstrateEvent): Generator<GearMessageEnqueuedHandler<any>> {
        if (event.name != 'Gear.MessageEnqueued') return
        let e = event as GearMessageEnqueuedEvent

        let hs = handlers.gearMessageEnqueued[e.args.destination]
        if (hs == null) return

        for (let h of hs.handlers) {
            yield h
        }
    }

    private *getGearUserMessageSentHandlers(handlers: DataHandlers, event: SubstrateEvent): Generator<GearUserMessageSentHandler<any>> {
        if (event.name != 'Gear.UserMessageSent') return
        let e = event as GearUserMessageSentEvent

        let hs = handlers.gearUserMessageSent[e.args.message.source]
        if (hs == null) return

        for (let h of hs.handlers) {
            yield h
        }
    }
}

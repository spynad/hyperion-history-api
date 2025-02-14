import {HyperionWorker} from "./hyperionWorker";
import {cargo, QueueObject} from "async";
import {Serialize} from "../addons/eosjs-native";
import {Type} from "eosjs/dist/eosjs-serialize";
import {debugLog, deserialize, hLog, serialize} from "../helpers/common_functions";
import * as AbiEOS from "@eosrio/node-abieos";

export default class StateReader extends HyperionWorker {

    private readonly isLiveReader = process.env['worker_role'] === 'continuous_reader';
    private readonly baseRequest: any;
    private abi: any;
    private qStatusMap = {};
    private recovery = false;
    private tables = new Map();
    private allowRequests = true;
    private pendingRequest = null;
    private completionSignaled = false;
    private stageOneDistQueue: QueueObject<any>;
    private blockReadingQueue: QueueObject<any>;
    private range_size = parseInt(process.env.last_block) - parseInt(process.env.first_block);
    private completionMonitoring: NodeJS.Timeout;
    private types: Map<string, Type>;
    private local_block_num = parseInt(process.env.first_block, 10) - 1;
    private queueSizeCheckInterval = 5000;
    private local_distributed_count = 0;
    private lastPendingCount = 0;
    private local_last_block = 0;
    private reconnectCount = 0;
    private future_block = 0;
    private drainCount = 0;
    private currentIdx = 1;
    private receivedFirstBlock = false;
    private local_lib = 0;
    private delay_active = false;
    private block_processing_delay = 100;
    private shipRev = 'v0';

    // private tempBlockSizeSum = 0;
    private shipInitStatus: any;

    private forkedBlocks = new Map<string, number>();

    constructor() {
        super();

        if (this.isLiveReader) {
            this.local_block_num = parseInt(process.env.worker_last_processed_block, 10) - 1;
        }

        this.stageOneDistQueue = cargo((tasks, callback) => {
            this.distribute(tasks, callback);
        }, this.conf.prefetch.read);

        this.blockReadingQueue = cargo((tasks, next) => {
            this.processIncomingBlocks(tasks).then(() => {
                next();
            }).catch((err) => {
                console.log('FATAL ERROR READING BLOCKS', err);
                process.exit(1);
            })
        }, this.conf.prefetch.read);

        if (this.conf.indexer.abi_scan_mode) {
            this.conf.indexer.fetch_deltas = true;
        }

        if (typeof this.conf.indexer.fetch_deltas === 'undefined') {
            this.conf.indexer.fetch_deltas = true;
        }

        if (this.conf.settings.ship_request_rev) {
            this.shipRev = this.conf.settings.ship_request_rev;
        }

        this.baseRequest = {
            max_messages_in_flight: this.conf.prefetch.read,
            have_positions: [],
            irreversible_only: false,
            fetch_block: this.conf.indexer.fetch_block,
            fetch_traces: this.conf.indexer.fetch_traces,
            fetch_deltas: this.conf.indexer.fetch_deltas
        };

        if (this.shipRev === 'v1') {
            this.baseRequest.fetch_block_header = true;
        }

        setInterval(async () => {
            for (const blockId of this.forkedBlocks.keys()) {
                const ts = this.forkedBlocks.get(blockId);
                if (ts) {
                    // if older than 30 sec remove from the map
                    if ((ts + (30 * 1000)) > Date.now()) {
                        await this.deleteForkedBlock(blockId);
                    } else {
                        this.forkedBlocks.delete(blockId);
                    }
                }
            }
        }, 5000);
    }

    distribute(data, cb) {
        this.recursiveDistribute(data, this.cch, cb);
    }

    recursiveDistribute(data, channel, cb) {
        if (data.length > 0) {
            const q = this.isLiveReader ? this.chain + ':live_blocks' : this.chain + ":blocks:" + this.currentIdx;
            if (!this.qStatusMap[q]) {
                this.qStatusMap[q] = true;
            }
            if (this.qStatusMap[q] === true) {
                if (this.cch_ready) {
                    const d = data.pop();
                    const result = channel.sendToQueue(q, d.content, {
                        persistent: true,
                        mandatory: true,
                    }, (err) => {
                        if (err !== null) {
                            console.log('Message nacked!');
                            console.log(err.message);
                        } else {
                            process.send({event: 'read_block', live: this.isLiveReader});
                        }
                    });

                    if (!this.isLiveReader) {
                        this.local_distributed_count++;
                        debugLog(`Block Number: ${d.num} - Range progress: ${this.local_distributed_count}/${this.range_size}`);
                        if (this.local_distributed_count === this.range_size) {
                            this.signalReaderCompletion();
                        }
                        this.currentIdx++;
                        if (this.currentIdx > this.conf.scaling.ds_queues) {
                            this.currentIdx = 1;
                        }
                    }
                    if (result) {
                        if (data.length > 0) {
                            this.recursiveDistribute(data, channel, cb);
                        } else {
                            cb();
                        }
                    } else {
                        // Send failed
                        this.qStatusMap[q] = false;
                        this.drainCount++;
                        setTimeout(() => {
                            this.recursiveDistribute(data, channel, cb);
                        }, 500);
                    }
                } else {
                    console.log('channel is not ready!');
                }
            } else {
                console.log(`waiting for [${q}] to drain!`);
            }
        } else {
            cb();
        }
    }

    assertQueues(): void {
        if (this.isLiveReader) {
            const live_queue = this.chain + ':live_blocks';
            this.ch.assertQueue(live_queue, {durable: true});
            this.ch.on('drain', () => {
                this.qStatusMap[live_queue] = true;
            });
        } else {
            for (let i = 0; i < this.conf.scaling.ds_queues; i++) {
                this.ch.assertQueue(this.chain + ":blocks:" + (i + 1), {durable: true});
                this.ch.on('drain', () => {
                    this.qStatusMap[this.chain + ":blocks:" + (i + 1)] = true;
                });
            }
        }
        if (this.cch) {
            this.cch_ready = true;
            this.stageOneDistQueue.resume();
            this.cch.on('close', () => {
                this.cch_ready = false;
                this.stageOneDistQueue.pause();
            });
        }
    }

    newRange(data: any) {
        debugLog(`new_range [${data.first_block},${data.last_block}]`);
        this.local_distributed_count = 0;
        clearInterval(this.completionMonitoring);
        this.completionMonitoring = null;
        this.completionSignaled = false;
        this.local_last_block = data.last_block;
        this.range_size = parseInt(data.last_block) - parseInt(data.first_block);
        if (this.allowRequests) {
            this.requestBlockRange(data.first_block, data.last_block);
            this.pendingRequest = null;
        } else {
            this.pendingRequest = [data.first_block, data.last_block];
        }
    }

    onIpcMessage(msg: any): void {
        switch (msg.event) {
            case 'new_range': {
                if (msg.target === process.env.worker_id) {
                    this.newRange(msg.data);
                }
                break;
            }
            case 'pause': {
                this.allowRequests = false;
                break;
            }
            case 'resume': {
                this.allowRequests = true;
                if (this.pendingRequest) {
                    this.processPending();
                }
                break;
            }
            case 'set_delay': {
                console.log('received new delay action from master')
                this.delay_active = msg.data.state;
                this.block_processing_delay = msg.data.delay;
                break;
            }
            case 'stop': {
                if (this.isLiveReader) {
                    console.log('[LIVE READER] Closing Websocket');
                    this.ship.close();
                    setTimeout(() => {
                        console.log('[LIVE READER] Process killed');
                        process.exit(1);
                    }, 2000);
                }
            }
        }
    }

    async run(): Promise<void> {
        // this.startQueueWatcher();
        this.events.once('ready', () => {
            this.startWS();
        });
    }

    private signalReaderCompletion() {
        if (!this.completionSignaled) {
            this.completionSignaled = true;
            debugLog(`Reader completion signal - ${this.range_size} - ${this.local_distributed_count}`);
            this.local_distributed_count = 0;
            this.completionMonitoring = setInterval(() => {
                let pending = 0;
                const unconfirmed = this.cch['unconfirmed'];
                if (unconfirmed.length > 0) {
                    unconfirmed.forEach((elem) => {
                        if (elem) {
                            pending++;
                        }
                    });
                    if (pending === this.lastPendingCount && pending > 0) {
                        // console.log(`[${process.env['worker_id']}] Pending blocks: ${pending}`);
                    } else {
                        this.lastPendingCount = pending;
                    }
                }
                if (pending === 0) {
                    debugLog(`Reader completed - ${this.range_size} - ${this.local_distributed_count}`);
                    clearInterval(this.completionMonitoring);
                    process.send({
                        event: 'completed',
                        id: process.env['worker_id']
                    });
                }
            }, 200);
        }
    }

    private async processIncomingBlocks(block_array: any[]) {
        if (this.abi) {
            for (const block of block_array) {
                try {
                    await this.onMessage(block);
                } catch (e) {
                    console.log(e);
                }
            }
            this.ackBlockRange(block_array.length);
        } else {
            await this.onMessage(block_array[0]);
            this.ackBlockRange(block_array.length);
        }
        if (this.delay_active) {
            await new Promise(resolve => setTimeout(resolve, this.block_processing_delay));
        }
        return true;
    }

    private async onMessage(data: Buffer) {
        // this.tempBlockSizeSum += data.length;

        if (!this.abi) {
            this.processFirstABI(data);
            return 1;
        }

        if (!process.env.worker_role) {
            console.log("[FATAL ERROR] undefined role! Exiting now!");
            this.ship.close();
            process.exit(1);
            return;
        }

        // NORMAL OPERATION MODE
        if (!this.recovery) {

            const result = deserialize('result', data, this.txEnc, this.txDec, this.types);

            // ship status message
            if (result[0] === 'get_status_result_v0') {
                this.shipInitStatus = result[1];
                hLog(`\n| SHIP Status Report\n| Init block: ${this.shipInitStatus['chain_state_begin_block']}\n| Head block: ${this.shipInitStatus['chain_state_end_block']}`);
                const chain_state_begin_block = this.shipInitStatus['chain_state_begin_block'];
                if (!this.conf.indexer.disable_reading) {

                    switch (process.env['worker_role']) {

                        // range reader setup
                        case 'reader': {
                            if (chain_state_begin_block > process.env.first_block) {

                                // skip snapshot block until a solution to parse it is found
                                const nextBlock = chain_state_begin_block + 2;
                                hLog(`First saved block is ahead of requested range! - Req: ${process.env.first_block} | First: ${chain_state_begin_block}`);
                                this.local_block_num = nextBlock - 1;
                                process.send({
                                    event: 'update_init_block',
                                    block_num: nextBlock
                                });
                                this.newRange({
                                    first_block: nextBlock,
                                    last_block: nextBlock + this.conf.scaling.batch_size
                                });
                            } else {
                                this.requestBlocks(0);
                            }
                            break;
                        }

                        // live reader setup
                        case 'continuous_reader': {
                            this.requestBlocks(parseInt(process.env['worker_last_processed_block'], 10));
                            break;
                        }

                    }
                } else {
                    this.ship.close();
                    process.exit(1);
                }

            } else {

                // ship block message
                const res = result[1];

                if (res['this_block']) {
                    const blk_num = res['this_block']['block_num'];
                    const lib = res['last_irreversible'];
                    const task_payload = {num: blk_num, content: data};

                    if (res.block && res.traces && res.deltas) {
                        debugLog(`block_num: ${blk_num}, block_size: ${res.block.length}, traces_size: ${res.traces.length}, deltas_size: ${res.deltas.length}`);
                    } else {
                        if (!res.traces) {
                            debugLog('missing traces field');
                        }
                        if (!res.deltas) {
                            debugLog('missing deltas field');
                        }
                        if (!res.block) {
                            debugLog('missing block field');
                        }
                    }

                    if (this.isLiveReader) {

                        // LIVE READER MODE
                        if (blk_num !== this.local_block_num + 1) {
                            hLog(`Expected: ${this.local_block_num + 1}, received: ${blk_num}`);
                            try {
                                // delete all previously stored data for the forked blocks
                                await this.handleFork(res);
                            } catch (e) {
                                hLog(`Failed to handle fork during live reading! - Error: ${e.message}`);
                            }
                        } else {
                            this.local_block_num = blk_num;
                        }

                        if (lib.block_num > this.local_lib) {
                            this.local_lib = lib.block_num;
                            // emit lib update event
                            process.send({event: 'lib_update', data: lib});
                        }

                        await this.stageOneDistQueue.push(task_payload);
                        return 1;
                    } else {

                        // Detect skipped first block
                        if (!this.receivedFirstBlock) {
                            if (blk_num !== this.local_block_num + 1) {
                                hLog(`WARNING: First block received was #${blk_num}, but #${this.local_block_num + 1} was expected!`);
                                hLog(`Make sure the block.log file contains the requested range, check with "eosio-blocklog --smoke-test"`);
                                this.local_block_num = blk_num - 1;
                            }
                            this.receivedFirstBlock = true;
                        }

                        // BACKLOG MODE
                        if (this.future_block !== 0 && this.future_block === blk_num) {
                            console.log('Missing block ' + blk_num + ' received!');
                        } else {
                            this.future_block = 0;
                        }

                        if (blk_num === this.local_block_num + 1) {
                            this.local_block_num = blk_num;
                            if (res['block'] || res['traces'] || res['deltas']) {
                                await this.stageOneDistQueue.push(task_payload);
                                return 1;
                            } else {
                                if (blk_num === 1) {
                                    await this.stageOneDistQueue.push(task_payload);
                                    return 1;
                                } else {
                                    return 0;
                                }
                            }
                        } else {
                            hLog(`Missing block: ${(this.local_block_num + 1)} current block: ${blk_num}`)
                            this.future_block = blk_num + 1;
                            return 0;
                        }
                    }
                } else {
                    hLog(`Reader is idle! - Head at: ${result[1].head.block_num}`);
                    this.ship.close();
                    process.send({
                        event: 'kill_worker',
                        id: process.env['worker_id']
                    });
                }
            }

        } else {

            // RECOVERY MODE
            if (this.isLiveReader) {
                hLog(`Resuming live stream from block ${this.local_block_num}...`);
                this.requestBlocks(this.local_block_num + 1);
                this.recovery = false;
            } else {
                if (!this.completionSignaled) {
                    let first = this.local_block_num;
                    let last = this.local_last_block;
                    if (last === 0) {
                        last = parseInt(process.env.last_block, 10);
                    }
                    last = last - 1;
                    if (first === 0) {
                        first = parseInt(process.env.first_block, 10);
                    }
                    if (first > last) {
                        last = first + 1;
                    }
                    hLog(`Resuming stream from block ${first} to ${last}...`);
                    if (last - first > 0) {
                        this.requestBlockRange(first, last);
                        this.recovery = false;
                    } else {
                        hLog('Invalid range!');
                    }
                } else {
                    hLog('Reader already finished, no need to restart.');
                    this.recovery = false;
                }
            }

        }
    }

    private processFirstABI(data: Buffer) {
        const abiString = data.toString();
        AbiEOS.load_abi("0", abiString);
        this.abi = JSON.parse(abiString);
        this.types = Serialize.getTypesFromAbi(Serialize.createInitialTypes(), this.abi);
        this.abi.tables.map(table => this.tables.set(table.name, table.type));
        // notify master about first abi
        process.send({event: 'init_abi', data: abiString});
        // request status
        this.send(['get_status_request_v0', {}]);
    }

    private requestBlocks(start: number) {
        const first_block = start > 0 ? start : process.env.first_block;
        const last_block = start > 0 ? 0xffffffff : process.env.last_block;
        const request = this.baseRequest;
        request.start_block_num = parseInt(first_block > 0 ? first_block.toString() : '1', 10);
        request.end_block_num = parseInt(last_block.toString(), 10);
        const reqType = 'get_blocks_request_' + this.shipRev;
        debugLog(`Reader ${process.env.worker_id} sending ${reqType} from: ${request.start_block_num} to: ${request.end_block_num}`);
        this.send([reqType, request]);
    }

    private send(req_data: (string | any)[]) {
        this.ship.send(serialize('request', req_data, this.txEnc, this.txDec, this.types));
    }

    private requestBlockRange(first: any, last: any) {
        const request = this.baseRequest;
        request.start_block_num = parseInt(first, 10);
        this.local_block_num = request.start_block_num - 1;
        request.end_block_num = parseInt(last, 10);
        const reqType = 'get_blocks_request_' + this.shipRev;
        debugLog(`Reader ${process.env.worker_id} sending ${reqType} from: ${request.start_block_num} to: ${request.end_block_num}`);
        this.send([reqType, request]);
    }

    private async deleteForkedBlock(block_id: string) {
        const searchBody = {
            query: {bool: {must: [{term: {block_id: block_id}}]}}
        };

        // remove deltas
        const dbqResultDelta = await this.client.deleteByQuery({
            index: this.chain + '-delta-' + this.conf.settings.index_version + '-*',
            refresh: true,
            body: searchBody
        });

        if (dbqResultDelta.body && dbqResultDelta.statusCode === 200) {
            hLog(`${dbqResultDelta.body.deleted} deltas removed from ${block_id}`);
        } else {
            hLog('Operation failed');
        }

        // remove actions
        const dbqResultAction = await this.client.deleteByQuery({
            index: this.chain + '-action-' + this.conf.settings.index_version + '-*',
            refresh: true,
            body: searchBody
        });

        if (dbqResultAction.body && dbqResultAction.statusCode === 200) {
            hLog(`${dbqResultAction.body.deleted} traces removed from ${block_id}`);
        } else {
            hLog('Operation failed');
        }
    }

    private async handleFork(data: any) {
        const this_block = data['this_block'];
        await this.logForkEvent(this_block['block_num'], this.local_block_num, this_block['block_id']);
        hLog(`Handling fork event: new block ${this_block['block_num']} has id ${this_block['block_id']}`);

        let targetBlock = this_block['block_num'];
        while (targetBlock < this.local_block_num + 1) {
            // fetch by block number to find the forked block_id
            const blockData = await this.client.get({
                index: this.chain + '-block-' + this.conf.settings.index_version,
                id: targetBlock
            });
            targetBlock++;
            if (blockData.body) {
                const targetBlockId = blockData.body._source.block_id;
                this.forkedBlocks.set(targetBlockId, Date.now());
                this.deleteForkedBlock(targetBlockId).catch(console.log);
            }
        }
    }

    private async logForkEvent(starting_block, ending_block, new_id) {
        process.send({event: 'fork_event', data: {starting_block, ending_block, new_id}});
        await this.client.index({
            index: this.chain + '-logs-' + this.conf.settings.index_version,
            body: {
                type: 'fork',
                '@timestamp': new Date().toISOString(),
                'fork.from_block': starting_block,
                'fork.to_block': ending_block,
                'fork.size': ending_block - starting_block + 1,
                'fork.new_block_id': new_id
            }
        });
    }

    private ackBlockRange(size: number) {
        this.send(['get_blocks_ack_request_v0', {num_messages: size}]);
    }

    private startQueueWatcher() {
        setInterval(() => {
            if (this.isLiveReader) {
                this.manager.checkQueueSize(this.chain + ":live_blocks").then(value => {
                    if (value > this.conf.scaling.block_queue_limit) {
                        this.allowRequests = false;
                    } else {
                        this.allowRequests = true;
                        if (this.pendingRequest) {
                            this.processPending();
                        }
                    }
                });
            } else {
                let checkArr = [];
                for (let i = 0; i < this.conf.scaling.ds_queues; i++) {
                    const q = this.chain + ":blocks:" + (i + 1);
                    checkArr.push(this.manager.checkQueueSize(q));
                }
                Promise.all(checkArr).then(data => {
                    if (data.some(el => el > this.conf.scaling.block_queue_limit)) {
                        if (this.allowRequests) {
                            hLog('ship reader paused!', data);
                        }
                        this.allowRequests = false;
                    } else {
                        this.allowRequests = true;
                        if (this.pendingRequest) {
                            this.processPending();
                        }
                    }
                });
            }
        }, this.queueSizeCheckInterval);
    }

    private processPending() {
        this.requestBlockRange(this.pendingRequest[0], this.pendingRequest[1]);
        this.pendingRequest = null;
    }

    private startWS() {
        this.ship.connect(
            this.blockReadingQueue.push,
            this.handleLostConnection.bind(this),
            () => {
                hLog('connection failed');
            }, () => {
                this.reconnectCount = 0;
            }
        );
    }

    private handleLostConnection() {
        this.recovery = true;
        this.ship.close();
        hLog(`Retrying connection in 5 seconds... [attempt: ${this.reconnectCount + 1}]`);
        debugLog(`PENDING REQUESTS:', ${this.pendingRequest}`);
        debugLog(`LOCAL BLOCK:', ${this.local_block_num}`);
        setTimeout(() => {
            this.reconnectCount++;
            this.startWS();
        }, 5000);
    }
}

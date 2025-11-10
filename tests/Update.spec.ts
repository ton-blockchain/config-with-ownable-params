
import { Config } from '../wrappers/Config';
import {
  Blockchain,
  BlockchainSnapshot,
  createShardAccount,
  internal,
  SandboxContract,
  TreasuryContract
} from '@ton/sandbox';

import { compile, libraryCellFromCode, sleep } from '@ton/blueprint';
import { Address, beginCell, Cell, Dictionary, ExternalAddress, internal as internal_relaxed, SendMode, toNano, Transaction } from '@ton/core';
import '@ton/test-utils';
import { Op } from '../wrappers/Constants';
import { findTransactionRequired, randomAddress } from '@ton/test-utils';
import { getVset, packValidatorsSet } from '../wrappers/ValidatorUtils';

async function fetchConfigState(address: Address, retryCount:number = 5) {
    do {
        try {
            const headers = new Headers({
                accept: 'application/json'
            });

            const params = new URLSearchParams({
                address: address.toString(),
                include_boc: 'true'
            });

            const resp = await fetch('https://toncenter.com/api/v3/accountStates?' + params, {
                headers
            });

            if(!resp.ok) {
                throw new Error(`Response status ${resp.status}`);
            }

            const jsonResp = await resp.json();
            const configData = jsonResp.accounts[0].data_boc;
            if(!configData) {
                throw new Error(`Data boc ton found: ${JSON.stringify(jsonResp)}`);
            }

            return Cell.fromBase64(configData);
        } catch(e) {
            const errMsg = `Failed to fetch state ${e}`;
            if(--retryCount >= 0) {
                console.error(errMsg);
                await sleep(2000);
            } else {
                throw new Error(errMsg);
            }
        }
    } while(true);
}

const getRandom = (min:number, max:number) => {
    return Math.random() * (max - min) + min;
}

export const getRandomInt = (min: number, max: number) => {
    return Math.round(getRandom(min, max));
}

function differentAddress(address: Address) {
    let newAddress: Address

    do {
        newAddress = randomAddress(address.workChain);
    } while(newAddress.equals(address));

    return newAddress;
}

describe('Config custom slot', () => {
    let blockchain: Blockchain;
    let configContract: SandboxContract<Config>;
    let configCode: Cell;
    let deployer: SandboxContract<TreasuryContract>;

    let oldCodeSnap: BlockchainSnapshot;

    const electorAddress = Address.parse('Ef8zMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM0vF');
    const configAddress  = Address.parse('Ef9VVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVVbxn');
    // Trust me
    let configOldCode =  Cell.fromBase64("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");


    const customSlots: Array<-1024 | -1025> = [-1024, -1025];
    const customSlotAdmin = Address.parse("EQA_o6NFLu73wozeYNERTsW8lkU5OarbRbIkoNuWdy5SPDA_");

    let initialState: BlockchainSnapshot;

    let assertSlotRejected: (txs: Transaction[], dataBefore: Cell, resp: Address) => Promise<void>;
    let assertParamSet: (paramId: number, data: Cell) => Promise<void>;

    let voteOut: (propHash: Buffer, critical: boolean, codeUpgrade: boolean) => Promise<void>;

    beforeAll(async () => {
        blockchain = await Blockchain.create();

        const configDs = (await fetchConfigState(configAddress)).beginParse();
        const configData = beginCell()
                            .storeRef(configDs.loadRef()) // Actual config
                            .storeBits(configDs.loadBits(32 + 256)) // seqno + pubkey
                            .storeMaybeRef(null) // Clear the vote dictionary
                           .endCell();

        configCode = await compile('Config');

        blockchain.setConfig(configData.refs[0]);

        deployer = await blockchain.treasury('deployer_wallet', {workchain: -1});

        await blockchain.setShardAccount(configAddress, createShardAccount({
            address: configAddress,
            code: configCode,
            data: configData,
            balance: toNano('10000')
        }));

        configContract = blockchain.openContract(
            Config.createFromAddress(configAddress)
        );

        assertSlotRejected = async (txs, data, resp) => {
            expect(txs).toHaveTransaction({
                on: resp,
                from: configContract.address,
                op: Op.customSlotRejected
            });
            expect(await configContract.getData()).toEqualCell(data);
        };

        assertParamSet = async (paramId, data) => {
            const curConfig = await configContract.getConfig();
            expect(curConfig.get(paramId)).toEqualCell(data);
        }

        voteOut = async (propHash, critical, codeUpgrade) => {
           const configSmc = await blockchain.getContract(configAddress);
           const curVset = getVset(await configContract.getConfig(), 34);
           const weightThreshold =  curVset.total_weight * 3n / 4n;

           const criticalNum = Number(critical);
           let propAccepted = false;
           let minWins = 2 + criticalNum;
           let winCount = 0;

           do {
               let weightRemaining = weightThreshold;
               for(let i = 0; i < curVset.total; i++) {
                   const res = await blockchain.sendMessage(internal({
                       from: deployer.address,
                       to: configAddress,
                       body: Config.mockVoteMessage(i, propHash),
                       value: toNano('100')
                   }), {ignoreChksig: true}); // Skip check sign

                   weightRemaining -= curVset.list[i].weight;

                   // Duh, code upgrade drops action phase
                   if(!(codeUpgrade && minWins - winCount == 1 && weightRemaining <= 0)) {
                       const voteTx = findTransactionRequired(res.transactions, {
                           on: deployer.address,
                           from: configAddress,
                           op: (op) => op == Op.voteProcessed + 2 || op == Op.voteProcessed + 6 + Number(critical) // Processed successfully
                       });
                       if(voteTx.inMessage!.body.beginParse().preloadUint(32) == Op.voteProcessed + 6 + Number(critical)) {
                           winCount++;
                       }
                   } else {
                       // console.log("Ops, special case for last vote of the codeUpdate");
                       // console.log(res.transactions[0].vmLogs);
                       winCount++;
                   }

                   propAccepted = winCount == minWins;

                   if(propAccepted) {
                       // Expect to clear the proposal
                       expect(await configContract.getProposal(propHash)).toBeNull();
                       return;
                   } else if(weightRemaining <= 0n) {
                       winCount++;
                       if(!blockchain.now) {
                           blockchain.now = Math.floor(Date.now() / 1000);
                       }
                       const newVset = packValidatorsSet({...curVset, utime_since: blockchain.now + 100, utime_unitl: blockchain.now + 100 + 65536});
                       const res = await blockchain.sendMessage(internal({
                           from: electorAddress,
                           to: configAddress,
                           body: Config.newVsetMessage(newVset),
                           value: toNano('10')
                       }));
                       expect(res.transactions).toHaveTransaction({
                           on: electorAddress,
                           from: configAddress,
                           op: Op.validatorsSetAccepted
                       });
                       blockchain.now += 1000;
                       await configSmc.runTickTock('tick');
                       const curSet = (await configContract.getConfig()).get(34);
                       expect(curSet).toEqualCell(newVset);
                       blockchain.setConfig((await configContract.getData()).refs[0]);
                       break;
                   }
               }
           } while(true);
       };

        initialState = blockchain.snapshot();
    });

    beforeEach(async () => await blockchain.loadFrom(initialState));

    it('should be able to set custom slot -1024', async () => {
        const testSlot  = -1024;
        const testCellA = beginCell().storeStringTail("Hop hey La La Ley").endCell();
        const testCellB = beginCell().storeBuffer(testCellA.hash()).endCell();
        for(let testCell of [testCellA, testCellB]) {
            const setSlotMsg = Config.setCustomSlotMessage(testSlot, testCell, deployer.address);
            const configSlotBefore = (await configContract.getConfig()).get(testSlot);

            expect(configSlotBefore === undefined || (!configSlotBefore.equals(testCell))).toBe(true);

            const res = await blockchain.sendMessage(internal({
                to: configContract.address,
                from: customSlotAdmin,
                body: setSlotMsg,
                value: toNano('10'),
            }));

            expect(res.transactions).toHaveTransaction({
                on: deployer.address,
                from: configContract.address,
                op: Op.customSlotAccepted
            });

            await assertParamSet(testSlot, testCell);
        }
    });

    it('only admin should be able to set slots', async () => {
        let testSenders = [deployer.address, randomAddress(0), new Address(-1, customSlotAdmin.hash), differentAddress(customSlotAdmin)];

        for(let testSlot of customSlots) {
            for(let testAddr of testSenders) {
                const testCell  = beginCell().storeAddress(testAddr).endCell();
                const dataBefore = await configContract.getData();
                const res = await configContract.sendSetCustomSlot(blockchain.sender(testAddr), testSlot, testCell, deployer.address);

                if(testAddr.workChain == -1) {
                    await assertSlotRejected(res.transactions, dataBefore, deployer.address);
                } else {
                    // Config ignores operations for 0 workchain
                    expect(dataBefore).toEqualCell(await configContract.getData());
                }
            }
        }
    });


    it('should be able to set custom slot -1025', async () => {
        const testSlot  = -1025;
        const testCellA = beginCell().storeStringTail("Hop hey La La Ley").endCell();
        const testCellB = beginCell().storeBuffer(testCellA.hash()).endCell();
        for(let testCell of [testCellA, testCellB]) {
            const setSlotMsg = Config.setCustomSlotMessage(testSlot, testCell, deployer.address);
            const configSlotBefore = (await configContract.getConfig()).get(testSlot);

            expect(configSlotBefore === undefined || (!configSlotBefore.equals(testCell))).toBe(true);

            const res = await blockchain.sendMessage(internal({
                to: configContract.address,
                from: customSlotAdmin,
                body: setSlotMsg,
                value: toNano('10'),
            }));

            expect(res.transactions).toHaveTransaction({
                on: deployer.address,
                from: configContract.address,
                op: Op.customSlotAccepted
            });

            await assertParamSet(testSlot, testCell);
        }
    });
    it('should bounce set_custom_slot when response address is not standard', async () => {
        const testCell = beginCell().storeStringTail("Hop hey La La Ley").endCell();
        let testCases  = [null, new ExternalAddress(42n, 256)] as unknown as Address[];
        const testPayloads: Cell[] = [];

        /*
         * addr_var$11 anycast:(Maybe Anycast) addr_len:(## 9)
         * workchain_id:int32 address:(bits addr_len) = MsgAddressInt;
         */

        customSlots.forEach(slot => {
            const varAddressPayload = beginCell()
                                        .storeUint(Op.setCustomSlot, 32)
                                        .storeUint(0, 64) // queryId
                                        .storeInt(slot, 32) // param_id
                                        .storeUint(0b110, 3) // var_addr tag + no anycast
                                        .storeUint(256, 9) // addr_len
                                        .storeUint(0, 32) // workchain
                                        .storeUint(42n, 256) // Address
                                        .storeRef(testCell)
                                    .endCell();
            testPayloads.push(...testCases.map(a => Config.setCustomSlotMessage(slot, testCell, a)), varAddressPayload);
        });

        for(let setSlotMsg of testPayloads ) {

            const res = await blockchain.sendMessage(internal({
                to: configContract.address,
                from: customSlotAdmin,
                body: setSlotMsg,
                value: toNano('10'),
            }));

            expect(res.transactions).toHaveTransaction({
                on: configContract.address,
                op: Op.setCustomSlot,
                aborted: true,
                outMessagesCount: 1 // Should bounce
            });
            expect(res.transactions).toHaveTransaction({
                on: customSlotAdmin,
                from: configContract.address,
                inMessageBounced: true
            });
        }
    });
    it('should not allow more than single cell for custom slot', async () => {
        // Exact same cell that worked, but in ref
        const testCell = beginCell().storeStringRefTail("Hop hey La La Ley").endCell();

        for(let testSlot of customSlots) {
            const dataBefore = await configContract.getData();
            const res = await configContract.sendSetCustomSlot(blockchain.sender(customSlotAdmin), testSlot,testCell, deployer.address);
            await assertSlotRejected(res.transactions, dataBefore, deployer.address);
        }
    });
    it('should not allow to set other parameters', async () => {
        const testCell = beginCell().storeStringTail("Hop hey La La Ley").endCell();

        let testParams = [
            new Array(5).fill(0).map(p => getRandomInt(1, 81)),
            new Array(5).fill(0).map(p => getRandomInt(-1023, -1)),
            -94
        ].flat();

        for(let testParam of testParams) {
            const dataBefore = await configContract.getData();
            // Force typecast
            const res = await configContract.sendSetCustomSlot(blockchain.sender(customSlotAdmin), testParam as -1024 | -1025,testCell, deployer.address);
            await assertSlotRejected(res.transactions, dataBefore, deployer.address);
        }
    });
    it('should not accept exotic cells for custom slot', async () => {
        const testCell = beginCell().storeStringTail("Hop hey La La Ley").endCell();

        // Gotta make library available, so config won't thrown on XCTOS
        const _libs = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
        _libs.set(BigInt(`0x${testCell.hash().toString('hex')}`), testCell);
        const libs = beginCell().storeDictDirect(_libs).endCell();
        blockchain.libs = libs;

        let testLib = libraryCellFromCode(testCell);
        expect(testLib.isExotic).toBe(true);

        let testProofPrep = beginCell().storeUint(3, 8) // Merkle proof
                                       .storeBuffer(testCell.hash()) // Hash
                                       .storeUint(testCell.depth(), 16)
                                       .storeRef(testCell)
                            .endCell();
        const testProof = new Cell({ exotic:true, bits: testProofPrep.bits, refs:testProofPrep.refs});

        const testUpdatePrep = beginCell().storeUint(4, 8) // Merkle update
                                          /* In reality this update does nothing,
                                           * since both proofs are equal
                                           * but nevertheless it is a valid update
                                           */
                                          .storeBuffer(testProof.hash(0))
                                          .storeBuffer(testProof.hash(0))
                                          .storeUint(testProof.depth(0), 16)
                                          .storeUint(testProof.depth(0), 16)
                                          .storeRef(testProof)
                                          .storeRef(testProof)
                               .endCell();
        const testUpdate = new Cell({ exotic:true, bits: testUpdatePrep.bits, refs:testUpdatePrep.refs});


        for(let testSlot of customSlots) {
            for(let testPayload of [testLib, testProof, testUpdate]) {
                const dataBefore = await configContract.getData();
                const res = await configContract.sendSetCustomSlot(blockchain.sender(customSlotAdmin), testSlot, testPayload, deployer.address);
                await assertSlotRejected(res.transactions, dataBefore, deployer.address);
            }
        }
    });

    it('should not allow to create proposals for parameters -1024 and -1025', async () => {
        const testCell = beginCell().storeStringTail("Hop hey La La Ley").endCell();

        let rndParams = [
            [...new Set(new Array(5).fill(0).map(p => getRandomInt(10, 81)))],
            [...new Set(new Array(5).fill(0).map(p => getRandomInt(-1023, -1)))],
            -94
        ].flat();

        let curConfig = await configContract.getConfig();
        const critParams = Dictionary.loadDirect(Dictionary.Keys.Int(32), Dictionary.Values.BitString(0), curConfig.get(10)!);

        const testCreateVoting = async (testParams: number[], expectOp: number) => {
            for(let paramId of testParams) {
                let curHash: Buffer;
                const curParam = curConfig.get(paramId);

                if(curParam) {
                    curHash = curParam.hash();
                } else {
                    curHash = Buffer.alloc(32);
                }

                const propMsg  = Config.newVotingProposalMessage({
                    expire_at: Math.floor(Date.now() / 1000) + 3600 * 24 * 60,
                    critical: critParams.has(paramId),
                    param_id: paramId,
                    value: testCell,
                    cur_hash: curHash
                });

                expect(await configContract.getProposal(propMsg.refs[0].hash())).toBeNull();

                const dataBefore = await configContract.getData();

                const res = await deployer.send({
                    to: configContract.address,
                    value: toNano('100'),
                    body: propMsg,
                    sendMode: SendMode.PAY_GAS_SEPARATELY
                });

                expect(res.transactions).toHaveTransaction({
                    on: configContract.address,
                    op: Op.newVoting,
                    aborted: false,
                    outMessagesCount: 1
                });

                if(expectOp == Op.newVotingCreated) {
                    expect(await configContract.getProposal(propMsg.refs[0].hash())).not.toBeNull();
                    expect(res.transactions).toHaveTransaction({
                        on: deployer.address,
                        from: configContract.address,
                        op: Op.newVotingCreated
                    });
                } else {
                    const dataAfter = await configContract.getData();
                    expect(dataBefore).toEqualCell(dataAfter);

                    expect(res.transactions).toHaveTransaction({
                        on: deployer.address,
                        from: configContract.address,
                        op: expectOp
                    });

                }
            }
        }

        // Check that voting creating at least works
        await testCreateVoting(rndParams, Op.newVotingCreated);

        // Check that voting is not created when parameters are not set
        expect(curConfig.get(-1024)).toBeUndefined();
        expect(curConfig.get(-1025)).toBeUndefined();

        await testCreateVoting(customSlots, Op.customSlotVotingRejected);

        for(let slot of customSlots) {
            const curCell = beginCell().storeInt(slot, 32).storeBuffer(testCell.hash()).endCell();
            const setSlotMsg = Config.setCustomSlotMessage(slot, curCell, deployer.address);

            await blockchain.sendMessage(internal({
                from: customSlotAdmin,
                to: configContract.address,
                body: setSlotMsg,
                value: toNano('10')
            }));

            await assertParamSet(slot, curCell);
        }

        // Now custom slots are set
        // Test that it won't allow to start voting now
        await testCreateVoting(customSlots, Op.customSlotVotingRejected);

    });
    it('check that votes work', async () => {

       const updateValue = beginCell().storeRef(configOldCode).endCell();

       const codeProposal = Config.newVotingProposalMessage({
                    expire_at: Math.floor(Date.now() / 1000) + 3600 * 24 * 60,
                    critical: true,
                    param_id: -1000,
                    value: updateValue,
                    cur_hash: Buffer.alloc(32)
       });

       let propHash = codeProposal.refs[0].hash();

       expect(await configContract.getProposal(propHash)).toBeNull();

       let res = await deployer.send({
           to: configContract.address,
           value: toNano('1000'),
           body: codeProposal,
           sendMode: SendMode.PAY_GAS_SEPARATELY
       });

       expect(res.transactions).toHaveTransaction({
           on: deployer.address,
           from: configContract.address,
           op: Op.newVotingCreated
       });


       expect(await configContract.getProposal(propHash)).not.toBeNull();
       const newProp  = await configContract.getProposal(propHash);
       expect(newProp).not.toBeNull();
       expect(newProp!.value).toEqualCell(updateValue);


       const stateBefore = await configContract.getState();
       expect(stateBefore.code!).not.toEqualCell(configOldCode);

       await voteOut(propHash, true, true);

       const stateAfter = await configContract.getState();
       expect(stateAfter.code!).toEqualCell(configOldCode);
       oldCodeSnap = blockchain.snapshot();

       // Just for kicks let's vote for some other parameter

       await blockchain.loadFrom(initialState);
       const testCell = beginCell().storeStringTail("Test Cell").storeUint(Math.floor(Date.now() / 1000), 32).endCell();

       const testPropMsg = Config.newVotingProposalMessage({
                    expire_at: Math.floor(Date.now() / 1000) + 3600 * 24 * 60,
                    critical: false,
                    param_id: -42,
                    value: testCell,
                    cur_hash: Buffer.alloc(32)
       });

       propHash = testPropMsg.refs[0].hash();

       expect(await configContract.getProposal(propHash)).toBeNull();

       res = await deployer.send({
           to: configContract.address,
           value: toNano('1000'),
           body: testPropMsg,
           sendMode: SendMode.PAY_GAS_SEPARATELY
       });

       expect(await configContract.getProposal(propHash)).not.toBeNull();

       await voteOut(propHash, false, false);

       await assertParamSet(-42, testCell);
    });
    it('test that proposal for parameters -1024 -1025 can\'t be accepted', async () => {

        // First let's load from the old code
        blockchain.setShardAccount(configAddress, createShardAccount({
            address: configAddress,
            code: configOldCode,
            data: await configContract.getData(),
            balance: toNano('10000')
        }));

        const testCell = beginCell().storeStringTail("Hop hey!").endCell();
        const origCell = beginCell().storeStringTail("Hop hey La La Ley!").endCell();

        const codeProposalMsg = Config.newVotingProposalMessage({
                     expire_at: Math.floor(Date.now() / 1000) + 3600 * 24 * 60,
                     critical: true,
                     param_id: -1000,
                     value: beginCell().storeRef(configCode).endCell(),
                     cur_hash: Buffer.alloc(32)
        });


        const slotProposals = customSlots.map(s => Config.newVotingProposalMessage({
                     expire_at: Math.floor(Date.now() / 1000) + 3600 * 24 * 60,
                     critical: false,
                     param_id: s,
                     value: testCell,
                     cur_hash: Buffer.alloc(32)
                 })
        );

        // First create votings for proposals
        for (let propMsg of [...slotProposals, codeProposalMsg]) {
            expect(await configContract.getProposal(propMsg.refs[0].hash())).toBeNull();

            const res = await deployer.send({
                to: configContract.address,
                value: toNano('1000'),
                body: propMsg,
                sendMode: SendMode.PAY_GAS_SEPARATELY
            });

            expect(await configContract.getProposal(propMsg.refs[0].hash())).not.toBeNull();

            expect(res.transactions).toHaveTransaction({
                on: deployer.address,
                from: configContract.address,
                op: Op.newVotingCreated
            });
        }

        // Now let's vote for the code upgrade
        let propHash = codeProposalMsg.refs[0].hash();

        // Upgrading from old code to the new one
        await voteOut(propHash, true, true);

        expect((await configContract.getState()).code!).toEqualCell(configCode);
        expect(await configContract.getProposal(propHash)).toBeNull();

        // Now let's say customProps were used
        // Self check
        expect(origCell).not.toEqualCell(testCell);

        for(let updateSlot of customSlots) {
            await configContract.sendSetCustomSlot(blockchain.sender(customSlotAdmin), updateSlot, origCell, deployer.address)
            await assertParamSet(updateSlot, origCell);
        }

        for(let i = 0; i < slotProposals.length; i++) {
            const slotProp = slotProposals[i];
            let curConfig = await configContract.getConfig();
            const slotBefore = curConfig.get(customSlots[i]);
            expect(slotBefore).toEqualCell(origCell);
            propHash = slotProp.refs[0].hash();

            // Run the vote
            await voteOut(propHash, false, false);
            // Proposal should be removed
            expect(await configContract.getProposal(propHash)).toBeNull();

            // But slots shouldn't change
            curConfig = await configContract.getConfig();
            const slotAfter = curConfig.get(customSlots[i])!;
            expect(slotAfter).toEqualCell(slotBefore!);
        }
    });
});

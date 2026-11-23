// @ts-nocheck
// QA-only module: selected by the isolated QA Metro config, never imported by app code.
import React, { useSyncExternalStore } from 'react';
import { STELLAR_TESTNET_CONTRACTS as C } from '@/config/stellar-deployment';
const params = new URLSearchParams(globalThis.location?.search ?? '');
const scenario = params.get('qa') ?? 'funded';
export const ADDRESS = 'GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF';
const hash = '0x' + '1'.repeat(64);
const note = { commitment: hash, value: '0x3b9aca00', tokenId:C.nativeAssetContractId, label:hash, status:scenario==='pending'?'PENDING':'ACTIVE', ownerAddress:ADDRESS, noteSecret:hash,isOwned:true,createdAtBlock:'0x0',spentAtBlock:null,txHash:hash,parentCommitmentHash:null };
let state = { address:scenario==='disconnected'?null:ADDRESS, status:'ready',unlocked:!['locked','disconnected'].includes(scenario),registered:true,notes:['empty','locked','disconnected'].includes(scenario)?[]:[note],noteOrigins:null,paymentRequests:[],lastSyncedAt:Date.now(),error:null,keptSessions:false };
const listeners = new Set();
const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn); };
function update(patch) { state={...state,...patch}; listeners.forEach(fn=>fn()); }
const noop = async()=>{};
const fail = async()=>{ throw new Error('QA: unsupported operation blocked'); };
async function flow(opts={}) {
 globalThis.__stellarQaCalls.push({method:'transaction',amount:String(opts.amount),recipient:opts.recipient});
 for(const stage of ['proving','signing','relaying','syncing']) { opts.onStage?.(stage); await new Promise(r=>setTimeout(r,500)); }
 if(scenario==='error') throw new Error('QA: wallet rejected the request');
 return {txHash:'1'.repeat(64),claimNotes:null,pendingLabel:null,commitment:hash,label:hash,labelRegistered:true};
}
globalThis.__stellarQaCalls=[];
export const stellarAccount = {
 subscribe,getSnapshot:()=>state,bind:()=>{},sync:noop,syncIfUnlocked:noop,ensureSession:async()=>{if(params.get('qaUnlock')==='reject'){await new Promise(r=>setTimeout(r,1500));throw new Error('QA: stale unlock rejected');}update({unlocked:true,notes:scenario==='empty'?[]:[note]});},retryPendingLabels:async()=>({sent:0,failed:0}),
 deposit:flow,withdraw:flow,transfer:flow,sendOneTime:fail,ragequit:fail,ensureCanReceive:noop,
 quoteWithdrawal:async()=>({feeCommitment:{feeAmount:'1000000',expiration:Date.now()+120000}}),quoteTransferFee:async()=>1000000n,
 createPaymentRequest:async(opts)=>{if(scenario==='error')throw new Error('QA: request creation failed'); return {paymentId:hash,noteAddressHashes:Array(5).fill(hash),amount:'0x'+BigInt(opts.amount).toString(16),tokenId:C.nativeAssetContractId,tag:hash,paymentPubKey:hash,expiresAt:'0x'+(Date.now()+86400000).toString(16)};},
 payPaymentRequest:fail,depositForPaymentRequest:fail,exportBackup:fail,importBackup:fail,recordRequestRow:()=>{},exportRequestBackup:()=>params.get('qaBackup')==='missing'?null:({payload:'QA ONLY - NOT A REAL BACKUP',paymentIds:[hash]}),markRequestBackupSaved:()=>{},importRequestBackup:fail,claim:fail,keepClaim:fail,
};
export const readStellarDepositsFor=()=>[];
export const readStellarClaimedNotes=()=>[];
export const findStellarSentClaim=()=>null;
export const listStellarSentDeposits=()=>[];
const signer={getAddress:async()=>ADDRESS,getNetworkPassphrase:async()=> 'Test SDF Network ; September 2015',signTransaction:fail};
const connect=async()=>{update({address:ADDRESS});return ADDRESS;};
const disconnect=()=>update({address:null,unlocked:false,notes:[]});
export function StellarWalletProvider({children}) {return children;}
export function useStellarWallet(){const s=useSyncExternalStore(subscribe,()=>state,()=>state);return {address:s.address,status:s.address?'connected':'disconnected',isConnected:!!s.address,networkPassphrase:'Test SDF Network ; September 2015',networkMismatch:scenario==='mismatch',isAvailable:true,availabilityChecked:true,isDevBurner:false,signedOut:!s.address,signer:s.address?signer:null,error:null,connect,connectDetailed:async()=>({address:await connect(),error:null}),cancelConnect:()=>{},disconnect};}
const balance={total:1020000000n,spendable:1000000000n,unfunded:false};
export function useStellarBalance(){return {data:scenario==='empty'?{total:0n,spendable:0n,unfunded:true}:balance,isLoading:false,error:null,refetch:noop};}
const fee=()=>1000000n;
export function useStellarFeeFor(){return fee;}
export function useStellarTransferFeeEstimate(){return 1000000n;}
export function useStellarDepositMax(spendable){return spendable*100n/101n;}
// Same DOM-driven fixture on desktop and real iOS Safari; no synthetic result UI.
if(params.has('qaFlow')) {
 const wait=ms=>new Promise(r=>setTimeout(r,ms));
 const find=id=>document.querySelector(`[data-testid="${id}"]`);
 const fill=(el,value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,value);el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));};
 const clickText=text=>{const nodes=[...document.querySelectorAll('[role="button"], [tabindex="0"]')];const el=nodes.filter(n=>n.textContent.trim()===text).at(-1);if(!el)throw Error('Missing button '+text);el.click();};
 (async()=>{while(!find('hub-tab-shield'))await wait(200);await wait(2500);find('drawer-close')?.click();await wait(400);
 const tab=params.get('qaFlow');find('hub-tab-'+tab)?.click();await wait(1200);
 const panel=find('hub-page-'+tab);fill(panel.querySelector('input[data-testid="hub-amount-input"]'),'10');await wait(400);
 if(tab==='withdraw'||tab==='send')fill(find(tab==='withdraw'?'withdraw-recipient-input':'send-recipient-input'), 'GCFIRY65OQE7DFP5KLNS2PF2LVZMUZYJX4OZIEQ36N2IQANUB5XVYOJR');
 await wait(400);if(params.get('qaStage')==='input'){globalThis.__stellarQaDone='input';return;}
 if(tab==='shield')find('hub-cta-shield').click();else clickText(tab==='withdraw'?'Withdraw':tab==='send'?'Review Transfer':'Create Request');
 await wait(800);if(params.get('qaStage')==='review'){globalThis.__stellarQaDone='review';return;}
 if(tab==='withdraw'||tab==='send')clickText(tab==='withdraw'?'Confirm Withdrawal':'Confirm Transfer');
 await wait(3000);if(params.has('qaScroll'))[...document.querySelectorAll('[tabindex]')].filter(n=>n.textContent.trim()==='Done').at(-1)?.scrollIntoView({block:'center'});globalThis.__stellarQaDone='result';
 })().catch(e=>{globalThis.__stellarQaDone='ERROR: '+e.message;console.error('QA FIXTURE',e);});
}

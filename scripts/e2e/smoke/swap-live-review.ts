// @ts-nocheck
// Mock account state only. All estimates are computed by the installed SDK against live services.
import { launch, open, connect, hubTab, sleep } from './harness';
import { liveReshieldEstimate, liveRequests, seedLiveDetails, liveNoteRedemption } from './live-reshield-estimator';
const runStartedAt=Date.now();
const runId=process.env.RUN_ID??process.env.CROSS??'samechain';
const inputAmount=process.env.AMOUNT??(process.env.CROSS==='native'?'0.02':'50');
const s = await launch('swap-live-review');
const { page } = s;
page.setDefaultTimeout(15000);
let rejectReview;
const failedReview=new Promise((_,reject)=>{rejectReview=reject;});
failedReview.catch(()=>{});
let comparison=null;
const privacyFailures=[];
const estimates = []; const requests = []; const responses=[]; const previewQuotes=[]; const failures = [];
page.on('response',async r=>{if(r.url().includes('li.quest/')){try{previewQuotes.push({receivedAt:Date.now(),url:r.url(),request:r.request().postData(),body:await r.json()});}catch{}}});
page.on('response',r=>{if(!r.url().startsWith('http://localhost'))responses.push({url:r.url().split('?')[0],status:r.status()});});
page.on('request', r => { if (/fastrelay|li.quest|publicnode|asp\./.test(r.url())) requests.push({requestedAt:Date.now(),url:r.url(),method:r.method()}); });
page.on('response',async r=>{if(r.url().endsWith('/v1/details')&&r.ok()){try{seedLiveDetails(await r.json());}catch{}}});
page.on('pageerror', e => failures.push(e.message));
await page.route(/\/v1\/relay\//, route => route.abort());
await page.exposeFunction('__liveEstimate', async (source, destination, params) => {
  const startedAt=Date.now();
  console.log('estimate-start', source, destination, JSON.stringify(params));
  try { const result = await liveReshieldEstimate(source, destination, params); estimates.push({startedAt,finishedAt:Date.now(),source,destination,params,result}); console.log('estimate-result', JSON.stringify(result)); return result; }
  catch(e) { console.log('estimate-error', String(e)); rejectReview(e); throw e; }
});
try {
 await open(page, '/?action=swap'); console.log('opened'); await connect(page); console.log('connected');
 await page.evaluate(async (address) => {
  const mods = [...globalThis.__r.getModules().values()];
  const exp = name => mods.find(m=>m.verboseName===name).publicModule.exports;
  const tokens = exp('config/tokens.ts').getActionableTokens(1).filter(t=>t.yieldShare);
  const details = {yield:tokens.map(t=>({ppToken:t.address}))};
  const notes = details.yield.map((d,i)=>({commitment:`0x${(90000+i).toString(16)}`,value:'0x21e19e0c9bab2400000',tokenId:d.ppToken,label:`0x${(80000+i).toString(16)}`,status:'ACTIVE',ownerAddress:address,noteSecret:'0x1',isOwned:true,createdAtBlock:'0x0',spentAtBlock:null,txHash:'0x0',parentCommitmentHash:null}));
  const session = {isKeystoreRegistered:async()=>true, estimateReshieldAmount:p=>globalThis.__liveEstimate(1,1,p)};
  const manager = {getNotes:()=>notes};
  const patch=(name,key,wrap)=>{const e=exp(name); const original=e[key]; e[key]=wrap(original);};
  const overrides={noteManager:manager,poolSession:session,ensureInitialized:async()=>session,isInitialized:true,isInitializing:false,keysReady:true,sessionResuming:false,sessionAddress:address,sessionTarget:{address,chainId:1},identityMode:'wallet',sessionForChain:async()=>session,keystoreStatusForChain:async()=> 'compatible',createReshieldCrosschainSessions:async({destinationChainId})=>({source:{estimateReshieldCrosschainAmount:p=>globalThis.__liveEstimate(1,destinationChainId,p)},destination:session})};
  patch('hooks/use-pool-session.ts','usePoolSession',original=>(...args)=>({...original(...args),...overrides}));
  const pools=tokens.map(t=>({id:t.address,name:t.symbol,tokenAddress:t.address,chainId:1,balance:'$10,000',balanceToken:'10000',balanceTokenExact:'10000',pending:'$0',pendingToken:'0',pendingTokenExact:'0',poolAccounts:1}));
  const memo = new Map();
  patch('hooks/use-notes.ts','useNotes',original=>(filters)=>{const live=original(filters); const key=JSON.stringify(filters??{}); if(!memo.has(key))memo.set(key,notes.filter(n=>(!filters?.tokenId||n.tokenId.toLowerCase()===filters.tokenId.toLowerCase())&&(!filters?.status||n.status===filters.status))); const ns=memo.get(key);return {...live,notes:ns,isLoading:false,totalValue:ns.reduce((v,n)=>v+BigInt(n.value),0n),activeCount:ns.length};});
  const gate={status:'ready',confirmed:new Set(notes.map(n=>n.commitment))};
  patch('hooks/use-leaf-gate.ts','useLeafGate',original=>(...args)=>{original(...args);return gate;});
  patch('components/pools-provider.tsx','usePools',original=>(...args)=>{const live=original(...args);return {...live,data:{...live.data,holdingsReady:true,myPools:pools}};});
  globalThis.__mockNotes=notes;
 }, s.address);
 await hubTab(page,'swap');
 const root=page.locator('[data-testid="hub-page-swap"]:not([aria-hidden="true"])').first();
 if(process.env.CROSS==='native'){
  await root.getByTestId('hub-withdraw-pool').click();
  await page.getByTestId('token-select-sheet').getByTestId('token-select-row-ppETH').click();
 }
 await root.locator('input[placeholder="0"],input[placeholder="0.0"]').first().fill(inputAmount);
 await sleep(15000);
 if(process.env.CROSS){
  await root.getByTestId('hub-swap-out-token').click();
  const sheet=page.getByTestId('token-select-sheet');
  await sheet.getByRole('button',{name:'Optimism',exact:true}).click();
  await sheet.getByTestId(process.env.CROSS==='same'?'token-select-row-ppUSDC':'token-select-row-ppETH').click();
  await page.getByTestId('swap-recipient-input').fill(s.address);
  await sleep(15000);
 }
 await page.waitForFunction(() => /[0-9]/.test(document.querySelector('[data-testid="hub-swap-output-note"]')?.textContent ?? ''), undefined, {timeout:90000});
 if(process.env.PREVIEW_DWELL_MS)await sleep(Number(process.env.PREVIEW_DWELL_MS));
 const crossPreviewRequests=requests.filter(r=>r.url.includes('li.quest/v1/quote/contractCalls'));
 if(process.env.CROSS){
  if(crossPreviewRequests.length!==1)privacyFailures.push(`Expected one cross-chain preview POST, got ${crossPreviewRequests.length}`);
  if(requests.some(r=>r.url.includes('/quote/toAmount')))privacyFailures.push('Preview disclosed a gas-purchase quote');
  for(const q of previewQuotes){
   if((q.url+(q.request??'')).toLowerCase().includes(s.address.toLowerCase()))privacyFailures.push('Preview disclosed wallet address');
   if(q.request){
    const body=JSON.parse(q.request);
    if(body.contractCalls?.[0]?.fromAmount!=='1')privacyFailures.push('Preview disclosed derived deposit budget');
   }
  }
 }
 const previewRequestCount=requests.filter(r=>r.url.includes('li.quest/')).length;
 const previewText=await root.getByTestId('hub-swap-output-note').innerText().catch(()=>null);
 console.log('before-review',await root.innerText());
 await page.screenshot({path:`/tmp/swap-live-preview-${runId}.png`});
 const reviewStartedAt=Date.now();
 await page.evaluate(() => {
  globalThis.__reviewOutputCleared = false;
  globalThis.__reviewOutputObserver = new MutationObserver(() => {
   const output = document.querySelector('[data-testid="hub-swap-output-note"]');
   if(output?.textContent?.trim() === '—') globalThis.__reviewOutputCleared = true;
  });
  globalThis.__reviewOutputObserver.observe(document.body, {subtree:true, childList:true, characterData:true});
 });
 console.log('clicking-review'); await root.getByText('Review swap', {exact:true}).click({timeout:10000}); console.log('clicked-review');
 await Promise.race([page.getByText('Confirm swap',{exact:true}).waitFor({timeout:150000}),failedReview]);
 const outputCleared = await page.evaluate(() => {
  globalThis.__reviewOutputObserver.disconnect();
  return globalThis.__reviewOutputCleared;
 });
 if(outputCleared)throw new Error('Review cleared the completed output estimate');
 const reviewReadyAt=Date.now();
 if(requests.filter(r=>r.url.includes('li.quest/')).length!==previewRequestCount)privacyFailures.push('Preview kept querying during Review');
 console.log('after-review',await root.innerText());
 if(await page.getByTestId('reshield-details-toggle').count())throw new Error('Fee breakdown must be visible without expanding Details');
 await page.getByTestId('reshield-fee-breakdown').waitFor();
 console.log('details',await page.locator('#pp-inline-op-host').innerText());
 const noteRow=await page.getByTestId('reshield-note-row').innerText();
 const lifiFeeRow=await page.getByTestId('reshield-lifi-fee-row').innerText();
 console.log('lifi-fee-row',lifiFeeRow);
 if(lifiFeeRow.includes('—'))throw new Error('Live Review fee metadata was not carried to the UI');
 if(!estimates.length)throw new Error('Review did not call live estimator');
 const last=estimates.at(-1);
 const redemption=await liveNoteRedemption(last.destination,last.params.outputToken,last.result.noteValue);
 const displayed=Number(noteRow.split('\n').find(line=>/^\d/.test(line))?.split(' ')[0].replaceAll(',',''));
 const tolerance=['USDC','USDT'].includes(redemption.symbol)?0.01:0.00001;
 if(!Number.isFinite(displayed)||Math.abs(displayed-Number(redemption.exact))>tolerance)throw new Error(`Review note ${displayed} disagrees with live redemption ${redemption.exact}`);
 const previewDisplayed=Number(previewText?.replace('~','').replaceAll(',','').trim());
 comparison={previewDisplayed,confirmDisplayed:displayed,exactNoteValue:Number(redemption.exact),errorPct:(previewDisplayed/displayed-1)*100};
 if(!Number.isFinite(comparison.errorPct)||Math.abs(comparison.errorPct)>3)throw new Error(`Widget estimate differs from Confirm by ${comparison.errorPct}% (3% validation limit)`);
 const dust=await page.getByTestId('reshield-dust-row').innerText();
 if(process.env.CROSS && !dust.includes('—'))throw new Error('Preliminary bridge output was incorrectly reported as destination dust');
 await page.screenshot({path:`/tmp/swap-live-confirm-${runId}.png`});
 await page.getByTestId('reshield-dust-hint').hover();
 await page.getByRole('tooltip').filter({hasText:'Estimated surplus after creating'}).waitFor();
 await sleep(200);
 await page.screenshot({path:`/tmp/swap-live-dust-tooltip-${runId}.png`});
 await page.mouse.move(0,0);

 await page.getByText('Back',{exact:true}).click();
 await root.locator('input[placeholder="0"],input[placeholder="0.0"]').first().fill('60');
 if(await page.getByText('Confirm swap',{exact:true}).isVisible())throw new Error('Stale confirmation after edit');
 if(failures.length || s.refusedSends.length)throw new Error('Browser errors or submission attempt in read-only simulation');
 console.log('verified-review-note',displayed,'live-redemption',redemption.exact,'reset-after-edit');
 await Bun.write(`/tmp/swap-live-report-${runId}.json`,JSON.stringify({comparison,privacyFailures,runId,inputAmount,route:process.env.CROSS??'samechain',runStartedAt,reviewStartedAt,reviewReadyAt,previewRequestCount,previewText,noteRow,redemption,previewQuotes,estimates,requests,responses,liveRequests,failures,refusedSends:s.refusedSends},null,2));
 if(privacyFailures.length){console.log('privacy-failed',JSON.stringify(privacyFailures));process.exitCode=1;}
} catch(e) {await Bun.write(`/tmp/swap-live-report-${runId}.json`,JSON.stringify({comparison,privacyFailures,runId,inputAmount,route:process.env.CROSS??'samechain',runStartedAt,failedAt:Date.now(),error:String(e),previewQuotes,estimates,requests,responses,liveRequests,failures,refusedSends:s.refusedSends},null,2));console.log('failed-ui',await page.locator('body').innerText());await page.screenshot({path:'/tmp/swap-live-failed.png'});throw e;} finally {await s.browser.close();}

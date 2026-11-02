// Read-only probe: which anonymous Square endpoints work from a GitHub runner.
// No secrets, no Telegram, no state writes. Prints a short report.
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const base=term=>({'Accept':'application/json, text/plain, */*','Accept-Language':'en-US,en;q=0.9','Content-Type':'application/json',
  Origin:'https://www.binance.com',Referer:'https://www.binance.com/en/square/search?s='+encodeURIComponent(term),
  'User-Agent':UA,clienttype:'web',lang:'en','bnc-uuid':crypto.randomUUID(),'x-trace-id':crypto.randomUUID()});
const term='Red Packet Quiz';
const posts=(u,body,extra={})=>({name:u.split('/bapi/')[1]+' '+JSON.stringify(body).slice(0,90),url:u,
  init:{method:'POST',headers:{...base(term),...extra},body:JSON.stringify(body)}});
const gets=(u,q)=>({name:u.split('/bapi/')[1]+'?'+new URLSearchParams(q),url:u+'?'+new URLSearchParams(q),
  init:{headers:{...base(term),'Content-Type':undefined}}});
const B='https://www.binance.com/bapi/composite/';
const H='https://www.binance.com/bapi/composite/v4/friendly/pgc/content/queryByHashtag';
const tagCases=[];
for(const tag of ['红包','binanceredpacket','redpacketquiz','giveaway'])
  for(const page of [1,3,6,10,20])
    tagCases.push(gets(H,{hashtag:'#'+tag,pageIndex:String(page),pageSize:'50',orderBy:'LATEST'}));
tagCases.push(gets(H,{hashtag:'#redpacketquiz',pageIndex:'1',pageSize:'50',orderBy:'HOT'}));
const cases=[
  gets(B+'v3/friendly/pgc/content/article/list',{pageIndex:'1',pageSize:'20',type:'1'}),
  ...tagCases,
];
for(const c of cases){
  try{
    const r=await fetch(c.url,{...c.init,signal:AbortSignal.timeout(15000)});
    const t=await r.text();let j=null;try{j=JSON.parse(t)}catch{}
    const d=j?.data;
    const arr=d?.vos||d?.feedData||d?.list||(Array.isArray(d)?d:null);
    const open=arr?arr.filter(p=>JSON.stringify(p).includes('redEnvelop')&&!JSON.stringify(p).includes('"isExpired":true')).length:'-';
    console.log(r.status,c.name,'| success=',j?.success,'| msg=',String(j?.message||'').slice(0,60),'| items=',arr?.length??'-',
      '| open_packets=',open,'| keys=',d&&!arr?Object.keys(d).slice(0,6).join(','):'');
  }catch(e){console.log('ERR',c.name,String(e.message).slice(0,80));}
}

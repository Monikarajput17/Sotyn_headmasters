import {useEffect,useState} from 'react';
import {Link,useSearchParams} from 'react-router-dom';
import api from '../api';
import Modal from './Modal';
const money=n=>'₹'+Number(n||0).toLocaleString('en-IN',{maximumFractionDigits:2});
export default function SaleHistory(){
 const [params,setParams]=useSearchParams(),[data,setData]=useState(null),[error,setError]=useState(''),[detail,setDetail]=useState(null),[revision,setRevision]=useState(0),[detailError,setDetailError]=useState('');
 const from=params.get('from')||'',to=params.get('to')||'',page=Number(params.get('page'))||1;
 useEffect(()=>{let cancelled=false;setData(null);setError('');api.get('/salon/pos',{params:{from:from||undefined,to:to||undefined,page,status:'paid'}}).then(r=>{if(!cancelled)setData(r.data);}).catch(()=>{if(!cancelled)setError('Could not load bills. Please retry.');});return()=>{cancelled=true;};},[from,to,page,revision]);
 const change=(key,value)=>{const next=new URLSearchParams(params);next.set(key,value);if(key!=='page')next.delete('page');setParams(next);};
 async function open(id){setDetailError('');try{setDetail((await api.get(`/salon/pos/${id}`)).data);}catch{setDetailError('Could not open this invoice. Please retry.');}}
 return <div className="p-4 sm:p-6 space-y-4"><div className="flex justify-between gap-2"><h1 className="text-2xl font-bold">Paid bills</h1><Link className="btn btn-secondary" to="/salon/billing">Billing / POS</Link></div>
  <div className="flex flex-wrap gap-3"><label>From<input className="input" type="date" value={from} onChange={e=>change('from',e.target.value)}/></label><label>To<input className="input" type="date" value={to} onChange={e=>change('to',e.target.value)}/></label></div>
  {(error||detailError)&&<p role="alert">{error||detailError} <button className="btn btn-secondary" onClick={()=>setRevision(v=>v+1)}>Retry</button></p>}
  {!data&&!error&&<p role="status">Loading bills…</p>}
  {data&&<><p className="text-sm text-gray-500">{data.total} paid bills · India time</p><div className="space-y-2">{data.rows.map(r=><button key={r.id} onClick={()=>open(r.id)} className="card w-full text-left flex flex-wrap justify-between gap-3"><span>{r.invoice_no||`Bill #${r.id}`} · {r.client_name||'Walk-in'}</span><span>{money(r.total)} →</span></button>)}{!data.rows.length&&<p>No paid bills in this period.</p>}</div><div className="flex gap-3 items-center"><button className="btn btn-secondary" disabled={page<=1} onClick={()=>change('page',String(page-1))}>Previous</button><span>Page {page}</span><button className="btn btn-secondary" disabled={page*data.limit>=data.total} onClick={()=>change('page',String(page+1))}>Next</button></div></>}
  <Modal isOpen={!!detail} onClose={()=>setDetail(null)} title={detail?.invoice_no||'Invoice'}>{detail&&<div className="space-y-3"><p>{detail.client_name||'Walk-in'} · {detail.payment_mode}</p>{detail.items?.map(i=><div className="flex justify-between gap-3" key={i.id}><span>{i.name} × {i.qty}</span><span>{money(i.line_total)}</span></div>)}<p className="font-bold">Total {money(detail.total)}</p></div>}</Modal>
 </div>;
}

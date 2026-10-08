"""Checksum-verified public futures archives. No trading credentials required."""
import argparse
import concurrent.futures
import hashlib
import io
import json
from pathlib import Path
import time
import urllib.request
import urllib.parse
import zipfile
import numpy as np
import pandas as pd

ROOT=Path(__file__).resolve().parent/'data'
BASE='https://data.binance.vision/data/futures/um/monthly'
def request(url,method='GET'):
    for attempt in range(4):
        try:
            return urllib.request.urlopen(urllib.request.Request(url,method=method,headers={'User-Agent':'RiggedResearch/1.0'}),timeout=40)
        except Exception:
            if attempt==3:raise
            time.sleep(1+attempt)
def url_for(kind,month):
    if kind=='fundingRate':return f'{BASE}/{kind}/BTCUSDT/BTCUSDT-fundingRate-{month}.zip'
    return f'{BASE}/{kind}/BTCUSDT/1m/BTCUSDT-1m-{month}.zip'
def archive(kind,month,download):
    url=url_for(kind,month)
    with request(url,'HEAD') as response:size=int(response.headers['Content-Length'])
    result={'kind':kind,'month':month,'url':url,'bytes':size}
    if not download:return result
    destination=ROOT/'archives'/kind/f'{month}.zip';destination.parent.mkdir(parents=True,exist_ok=True)
    with request(url+'.CHECKSUM') as response:expected=response.read().decode().split()[0]
    if destination.exists() and hashlib.sha256(destination.read_bytes()).hexdigest()==expected:
        result['sha256']=expected;return result
    temporary=destination.with_suffix('.partial')
    for attempt in range(5):
        try:
            with request(url) as response,temporary.open('wb') as output:
                while chunk:=response.read(256*1024):output.write(chunk)
            actual=hashlib.sha256(temporary.read_bytes()).hexdigest()
            if actual!=expected:raise ValueError(f'Checksum mismatch: {kind} {month}')
            break
        except Exception:
            if attempt==4:raise
            print(f'Retrying {kind} {month} ({attempt+1})',flush=True)
            time.sleep(1+attempt)
    temporary.replace(destination);result['sha256']=actual
    print(f'Saved {kind} {month}: {size/1024**2:.2f} MiB',flush=True)
    return result
def csv_frame(kind,month):
    with zipfile.ZipFile(ROOT/'archives'/kind/f'{month}.zip') as archive_file:
        names=[n for n in archive_file.namelist() if n.endswith('.csv')]
        if len(names)!=1:raise ValueError('Archive must contain exactly one CSV')
        with archive_file.open(names[0]) as source:raw=source.read()
    first=raw.splitlines()[0].decode().split(',')[0]
    return pd.read_csv(io.BytesIO(raw),header=0 if not first.isdigit() else None)
def repair_mark(trade,mark,month):
    missing=np.setdiff1d(trade[:,0],mark[:,0])
    if not len(missing):return mark
    if len(missing)>100:raise ValueError('Large archive gap: manual investigation required')
    destination=ROOT/'repairs'/f'mark-{month}.json';destination.parent.mkdir(parents=True,exist_ok=True)
    if destination.exists():record=json.loads(destination.read_text(encoding='utf-8'))
    else:
        rows=[];sources=[]
        for timestamp in missing:
            parameters=urllib.parse.urlencode({'symbol':'BTCUSDT','interval':'1m','startTime':int(timestamp),'endTime':int(timestamp),'limit':1})
            url='https://fapi.binance.com/fapi/v1/markPriceKlines?'+parameters
            with request(url) as response:body=response.read()
            candles=json.loads(body)
            if len(candles)!=1 or candles[0][0]!=timestamp:raise ValueError('Public API could not repair the exact missing minute')
            rows.extend(candles);sources.append({'url':url,'response_sha256':hashlib.sha256(body).hexdigest()})
        record={'month':month,'source':'Binance public REST markPriceKlines','sources':sources,'rows':rows}
        destination.write_text(json.dumps(record,indent=2),encoding='utf-8')
    repairs=np.asarray([row[:5] for row in record['rows']],dtype=np.float64)
    if not np.array_equal(np.sort(repairs[:,0]),missing):raise ValueError('Cached repair timestamps do not match gap')
    combined=np.concatenate([mark,repairs]);combined=combined[np.argsort(combined[:,0])]
    print(f'Repaired {len(missing)} missing mark minutes in {month} from Binance REST; provenance: {destination}',flush=True)
    return combined
def prepare(months):
    chunks=[];funding_count=0
    for month in months:
        trade=csv_frame('klines',month).iloc[:,:6].to_numpy(dtype=np.float64)
        mark=csv_frame('markPriceKlines',month).iloc[:,:5].to_numpy(dtype=np.float64)
        mark=repair_mark(trade,mark,month)
        if len(trade)!=len(mark) or not np.array_equal(trade[:,0],mark[:,0]):raise ValueError(f'Trade/mark alignment failed: {month}')
        if not np.all(np.isfinite(trade)) or not np.all(np.isfinite(mark)):raise ValueError('Non-finite market data')
        if len(trade)>1 and not np.all(np.diff(trade[:,0])==60000):raise ValueError(f'Missing or duplicate minute candles: {month}')
        if not np.all(trade[:,0]%60000==0):raise ValueError('Unexpected timestamp units')
        for array in (trade,mark):
            if np.any(array[:,3]<=0) or np.any(array[:,2]<array[:,1]) or np.any(array[:,2]<array[:,4]) or np.any(array[:,3]>array[:,1]) or np.any(array[:,3]>array[:,4]):raise ValueError('Invalid OHLC data')
        rates=np.zeros(len(trade),dtype=np.float64)
        frame=csv_frame('fundingRate',month)
        columns={str(c).lower():c for c in frame.columns}
        timestamp=columns.get('calc_time')
        rate=columns.get('last_funding_rate')
        if timestamp is None or rate is None:raise ValueError(f'Unknown funding columns: {frame.columns.tolist()}')
        for ts,value in zip(frame[timestamp],frame[rate]):
            ts=int(ts);value=float(value)
            if not np.isfinite(value):raise ValueError('Non-finite funding rate')
            i=int(np.searchsorted(trade[:,0],ts,side='right')-1)
            if not 0<=i<len(trade) or not trade[i,0]<=ts<trade[i,0]+60000:raise ValueError('Funding outside matching candle')
            rates[i]+=value;funding_count+=1
        chunks.append(np.column_stack([trade,mark[:,1:5],rates]))
    data=np.concatenate(chunks)
    if not np.all(np.diff(data[:,0])==60000):raise ValueError('Gap between monthly archives')
    destination=ROOT/'btc-usdt-1m.npy';np.save(destination,data)
    summary={'columns':['time','open','high','low','close','volume','mark_open','mark_high','mark_low','mark_close','funding_rate'],
             'rows':len(data),'funding_events':funding_count,'first_time':int(data[0,0]),'last_time':int(data[-1,0]),
             'sha256':hashlib.sha256(destination.read_bytes()).hexdigest(),'prepared_bytes':destination.stat().st_size,
             'repair_provenance':[str(p.relative_to(ROOT)) for p in sorted((ROOT/'repairs').glob('*.json'))]}
    (ROOT/'dataset.json').write_text(json.dumps(summary,indent=2),encoding='utf-8')
    print(json.dumps(summary),flush=True)
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--download',action='store_true');parser.add_argument('--years',nargs='+',type=int,default=[2024,2025]);args=parser.parse_args()
    months=[f'{year}-{month:02d}' for year in args.years for month in range(1,13)]
    jobs=[(kind,month) for month in months for kind in ('klines','markPriceKlines','fundingRate')]
    records=[]
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for record in pool.map(lambda job:archive(*job,args.download),jobs):records.append(record)
    ROOT.mkdir(parents=True,exist_ok=True)
    (ROOT/'archives.json').write_text(json.dumps(records,indent=2),encoding='utf-8')
    print(f'Archives: {sum(r["bytes"] for r in records)/1024**2:.2f} MiB across {len(records)} files',flush=True)
    if args.download:prepare(months)
if __name__=='__main__':main()
